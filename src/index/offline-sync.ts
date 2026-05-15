import { disassemble, getChoseong } from "../shared/hangul";

import {
  EXCLUSIVE_SCAN_PAGE_LIMIT,
  MANUAL_COMMENTS_KEY,
  MANUAL_THUMBS_KEY,
  OFFLINE_DB_NAME,
  OFFLINE_DB_VERSION,
  OFFLINE_EPISODE_CONCURRENCY,
  OFFLINE_EPISODES_KEY,
  OFFLINE_EPISODE_STORE,
  OFFLINE_ITEMS_KEY,
  OFFLINE_ITEM_STORE,
  OFFLINE_META_STORE,
  OFFLINE_MODE_KEY,
  OFFLINE_SYNC_PAGE_SIZE,
} from "./constants";
import type {
  OfflineEpisodeRecord,
  OfflineItemRecord,
  OfflineMetaState,
  OfflineScope,
  OfflineStatusState,
  RawEpisode,
  RawItem,
} from "./types";

let offlineSyncPromise: Promise<void> | null = null;
let offlineItemsCache: OfflineItemRecord[] | null = null;
let offlineMeta: OfflineMetaState = {
  ready: false,
  itemCount: 0,
  episodeCount: 0,
  updatedAt: "",
  scopes: { items: true, episodes: false },
  syncState: { inProgress: false, stage: "", nextItemIndex: 0, totalItems: 0 },
};
let offlineStatus: OfflineStatusState = {
  phase: "idle",
  message: "",
  downloaded: 0,
  total: 0,
  error: "",
};
const offlineListeners = new Set<() => void>();

function notifyOfflineStatus() {
  for (const listener of offlineListeners) listener();
}

function subscribeOfflineStatus(listener: () => void) {
  offlineListeners.add(listener);
  return () => offlineListeners.delete(listener);
}

function setOfflineStatus(patch: Partial<OfflineStatusState>) {
  offlineStatus = { ...offlineStatus, ...patch };
  notifyOfflineStatus();
}

function isOfflineModeEnabled() {
  return localStorage.getItem(OFFLINE_MODE_KEY) === "yes";
}

function getOfflineScope(): OfflineScope {
  const items = localStorage.getItem(OFFLINE_ITEMS_KEY);
  const episodes = localStorage.getItem(OFFLINE_EPISODES_KEY);
  if (items === null && episodes === null) {
    return { items: true, episodes: false };
  }
  return {
    items: items === "yes",
    episodes: episodes === "yes",
  };
}

function hasOfflineScope(scope: OfflineScope) {
  return scope.items || scope.episodes;
}

function normalizeOfflineScope(scope: OfflineScope): OfflineScope {
  return scope;
}

function saveOfflineScope(scope: OfflineScope) {
  const normalized = normalizeOfflineScope(scope);
  localStorage.setItem(OFFLINE_ITEMS_KEY, normalized.items ? "yes" : "no");
  localStorage.setItem(OFFLINE_EPISODES_KEY, normalized.episodes ? "yes" : "no");
  return normalized;
}

function isOfflineItemModeReady() {
  return isOfflineModeEnabled() && offlineMeta.scopes.items && offlineMeta.itemCount > 0;
}

function hasDownloadedOfflineItems() {
  return offlineMeta.itemCount > 0;
}

function shouldPreferOfflineItemSearch() {
  return isOfflineModeEnabled() && getOfflineScope().items && hasDownloadedOfflineItems();
}

function getOfflineSearchBlockedMessage() {
  return "오프라인 메타데이터가 없어 검색할 수 없습니다. DB 동기화를 시작하거나 온라인 모드로 전환해주세요.";
}

function describeOfflineScope(scope: OfflineScope) {
  if (scope.items && scope.episodes) return "작품 + 에피소드";
  if (scope.episodes) return "에피소드만";
  if (scope.items) return "작품만";
  return "선택 안 함";
}

function isManualThumbsEnabled() {
  return isOfflineModeEnabled() && localStorage.getItem(MANUAL_THUMBS_KEY) === "yes";
}

function isManualCommentsEnabled() {
  return isOfflineModeEnabled() && localStorage.getItem(MANUAL_COMMENTS_KEY) === "yes";
}

function formatOfflineTime(ts: string) {
  if (!ts) return "";
  try {
    return new Date(ts).toLocaleString("ko-KR", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

function openOfflineDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(OFFLINE_DB_NAME, OFFLINE_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(OFFLINE_ITEM_STORE)) {
        db.createObjectStore(OFFLINE_ITEM_STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(OFFLINE_EPISODE_STORE)) {
        db.createObjectStore(OFFLINE_EPISODE_STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(OFFLINE_META_STORE)) {
        db.createObjectStore(OFFLINE_META_STORE, { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("indexedDB open failed"));
  });
}

async function readOfflineMeta() {
  const db = await openOfflineDb();
  return await new Promise<Record<string, unknown> | null>((resolve, reject) => {
    const tx = db.transaction(OFFLINE_META_STORE, "readonly");
    const req = tx.objectStore(OFFLINE_META_STORE).get("snapshot");
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error || new Error("meta read failed"));
  });
}

async function writeOfflineSnapshot(items: OfflineItemRecord[], episodes: OfflineEpisodeRecord[], scope: OfflineScope) {
  const db = await openOfflineDb();
  return await new Promise((resolve, reject) => {
    const tx = db.transaction([OFFLINE_ITEM_STORE, OFFLINE_EPISODE_STORE, OFFLINE_META_STORE], "readwrite");
    const itemStore = tx.objectStore(OFFLINE_ITEM_STORE);
    const episodeStore = tx.objectStore(OFFLINE_EPISODE_STORE);
    const metaStore = tx.objectStore(OFFLINE_META_STORE);
    itemStore.clear();
    episodeStore.clear();
    for (const item of items) itemStore.put(item);
    for (const episode of episodes) episodeStore.put(episode);
    metaStore.put({
      key: "snapshot",
      ready: true,
      itemCount: items.length,
      episodeCount: episodes.length,
      updatedAt: new Date().toISOString(),
      scopes: scope,
    });
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error || new Error("snapshot write failed"));
  });
}

async function commitOfflineItems(
  items: OfflineItemRecord[],
  scope: OfflineScope,
  clearEpisodes: boolean,
  existingEpisodeCount = 0,
) {
  const db = await openOfflineDb();
  return await new Promise((resolve, reject) => {
    const tx = db.transaction([OFFLINE_ITEM_STORE, OFFLINE_EPISODE_STORE, OFFLINE_META_STORE], "readwrite");
    const itemStore = tx.objectStore(OFFLINE_ITEM_STORE);
    const episodeStore = tx.objectStore(OFFLINE_EPISODE_STORE);
    const metaStore = tx.objectStore(OFFLINE_META_STORE);
    itemStore.clear();
    if (scope.episodes && clearEpisodes) episodeStore.clear();
    for (const item of items) itemStore.put(item);
    metaStore.put({
      key: "snapshot",
      ready: true,
      itemCount: items.length,
      episodeCount: existingEpisodeCount,
      updatedAt: new Date().toISOString(),
      scopes: scope,
    });
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error || new Error("item commit failed"));
  });
}

async function appendOfflineEpisodes(episodes: OfflineEpisodeRecord[], itemCount: number, scope: OfflineScope) {
  const db = await openOfflineDb();
  return await new Promise((resolve, reject) => {
    const tx = db.transaction([OFFLINE_EPISODE_STORE, OFFLINE_META_STORE], "readwrite");
    const episodeStore = tx.objectStore(OFFLINE_EPISODE_STORE);
    const metaStore = tx.objectStore(OFFLINE_META_STORE);
    for (const episode of episodes) episodeStore.put(episode);
    const metaReq = metaStore.get("snapshot");
    metaReq.onsuccess = () => {
      const current = (metaReq.result as Record<string, unknown> | null) ?? {};
      metaStore.put({
        key: "snapshot",
        ready: true,
        itemCount,
        episodeCount: Number(current.episodeCount || 0) + episodes.length,
        updatedAt: new Date().toISOString(),
        scopes: scope,
      });
    };
    metaReq.onerror = () => reject(metaReq.error || new Error("episode meta read failed"));
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error || new Error("episode commit failed"));
  });
}

async function resetOfflineSnapshotForSync(scope: OfflineScope, stage: "items" | "episodes", totalItems = 0) {
  const db = await openOfflineDb();
  return await new Promise((resolve, reject) => {
    const tx = db.transaction([OFFLINE_ITEM_STORE, OFFLINE_EPISODE_STORE, OFFLINE_META_STORE], "readwrite");
    tx.objectStore(OFFLINE_ITEM_STORE).clear();
    tx.objectStore(OFFLINE_EPISODE_STORE).clear();
    tx.objectStore(OFFLINE_META_STORE).put({
      key: "snapshot",
      ready: false,
      itemCount: 0,
      episodeCount: 0,
      updatedAt: new Date().toISOString(),
      scopes: scope,
      syncState: {
        inProgress: true,
        stage,
        nextItemIndex: 0,
        totalItems,
      },
    });
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error || new Error("sync reset failed"));
  });
}

async function appendOfflineItemsBatch(
  items: OfflineItemRecord[],
  scope: OfflineScope,
  nextItemIndex: number,
  totalItems: number,
) {
  const db = await openOfflineDb();
  return await new Promise((resolve, reject) => {
    const tx = db.transaction([OFFLINE_ITEM_STORE, OFFLINE_META_STORE], "readwrite");
    const itemStore = tx.objectStore(OFFLINE_ITEM_STORE);
    const metaStore = tx.objectStore(OFFLINE_META_STORE);
    for (const item of items) itemStore.put(item);
    const metaReq = metaStore.get("snapshot");
    metaReq.onsuccess = () => {
      const current = (metaReq.result as Record<string, unknown> | null) ?? {};
      metaStore.put({
        key: "snapshot",
        ready: false,
        itemCount: Number(current.itemCount || 0) + items.length,
        episodeCount: Number(current.episodeCount || 0),
        updatedAt: new Date().toISOString(),
        scopes: scope,
        syncState: {
          inProgress: true,
          stage: "items",
          nextItemIndex,
          totalItems,
        },
      });
    };
    metaReq.onerror = () => reject(metaReq.error || new Error("item meta read failed"));
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error || new Error("item batch commit failed"));
  });
}

async function beginOfflineEpisodeStage(
  itemCount: number,
  scope: OfflineScope,
  nextItemIndex: number,
  totalItems: number,
) {
  const db = await openOfflineDb();
  return await new Promise((resolve, reject) => {
    const tx = db.transaction([OFFLINE_EPISODE_STORE, OFFLINE_META_STORE], "readwrite");
    if (nextItemIndex === 0) tx.objectStore(OFFLINE_EPISODE_STORE).clear();
    tx.objectStore(OFFLINE_META_STORE).put({
      key: "snapshot",
      ready: false,
      itemCount,
      episodeCount: nextItemIndex === 0 ? 0 : offlineMeta.episodeCount,
      updatedAt: new Date().toISOString(),
      scopes: scope,
      syncState: {
        inProgress: true,
        stage: "episodes",
        nextItemIndex,
        totalItems,
      },
    });
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error || new Error("episode stage init failed"));
  });
}

async function updateOfflineSyncState(
  patch: Partial<OfflineMetaState["syncState"]>,
  scope: OfflineScope,
  counts?: { itemCount?: number; episodeCount?: number },
) {
  const db = await openOfflineDb();
  return await new Promise((resolve, reject) => {
    const tx = db.transaction(OFFLINE_META_STORE, "readwrite");
    const metaStore = tx.objectStore(OFFLINE_META_STORE);
    const req = metaStore.get("snapshot");
    req.onsuccess = () => {
      const current = (req.result as Record<string, unknown> | null) ?? {};
      const currentSync =
        current.syncState && typeof current.syncState === "object"
          ? (current.syncState as Record<string, unknown>)
          : {};
      metaStore.put({
        key: "snapshot",
        ready: current.ready !== false,
        itemCount: counts?.itemCount ?? Number(current.itemCount || 0),
        episodeCount: counts?.episodeCount ?? Number(current.episodeCount || 0),
        updatedAt: new Date().toISOString(),
        scopes: current.scopes ?? scope,
        syncState: {
          inProgress: patch.inProgress ?? currentSync.inProgress === true,
          stage: patch.stage ?? String(currentSync.stage || ""),
          nextItemIndex: patch.nextItemIndex ?? Number(currentSync.nextItemIndex || 0),
          totalItems: patch.totalItems ?? Number(currentSync.totalItems || 0),
        },
      });
    };
    req.onerror = () => reject(req.error || new Error("sync state read failed"));
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error || new Error("sync state write failed"));
  });
}

async function finalizeOfflineSnapshot(scope: OfflineScope, itemCount: number, episodeCount: number) {
  const db = await openOfflineDb();
  return await new Promise((resolve, reject) => {
    const tx = db.transaction(OFFLINE_META_STORE, "readwrite");
    tx.objectStore(OFFLINE_META_STORE).put({
      key: "snapshot",
      ready: true,
      itemCount,
      episodeCount,
      updatedAt: new Date().toISOString(),
      scopes: scope,
      syncState: {
        inProgress: false,
        stage: "",
        nextItemIndex: 0,
        totalItems: itemCount,
      },
    });
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error || new Error("snapshot finalize failed"));
  });
}

async function loadOfflineItems() {
  if (offlineItemsCache) return offlineItemsCache;
  const db = await openOfflineDb();
  offlineItemsCache = await new Promise<OfflineItemRecord[]>((resolve, reject) => {
    const tx = db.transaction(OFFLINE_ITEM_STORE, "readonly");
    const req = tx.objectStore(OFFLINE_ITEM_STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error || new Error("items read failed"));
  });
  return offlineItemsCache;
}

async function refreshOfflineMeta() {
  const meta = await readOfflineMeta();
  offlineMeta = {
    ready: !!meta?.ready,
    itemCount: Number(meta?.itemCount || 0),
    episodeCount: Number(meta?.episodeCount || 0),
    updatedAt: String(meta?.updatedAt || ""),
    scopes: {
      items:
        meta?.scopes && typeof meta.scopes === "object"
          ? (meta.scopes as Record<string, unknown>).items !== false
          : true,
      episodes:
        meta?.scopes && typeof meta.scopes === "object"
          ? (meta.scopes as Record<string, unknown>).episodes === true
          : false,
    },
    syncState: {
      inProgress:
        meta?.syncState && typeof meta.syncState === "object"
          ? (meta.syncState as Record<string, unknown>).inProgress === true
          : false,
      stage:
        meta?.syncState && typeof meta.syncState === "object"
          ? (String((meta.syncState as Record<string, unknown>).stage || "") as "items" | "episodes" | "")
          : "",
      nextItemIndex:
        meta?.syncState && typeof meta.syncState === "object"
          ? Number((meta.syncState as Record<string, unknown>).nextItemIndex || 0)
          : 0,
      totalItems:
        meta?.syncState && typeof meta.syncState === "object"
          ? Number((meta.syncState as Record<string, unknown>).totalItems || 0)
          : 0,
    },
  };
  notifyOfflineStatus();
  return offlineMeta;
}

function normalizeOfflineItem(item: RawItem, index: number): OfflineItemRecord {
  const name = item.name ?? "";
  return {
    id: item.id,
    name,
    genre: item.genre ?? [],
    medium: item.medium ?? "",
    images: item.images ?? [],
    is_laftel_original: !!item.is_laftel_original,
    is_ending: !!item.is_ending,
    avg_rating: Number(item.avg_rating || 0),
    air_year_quarter: item.air_year_quarter ?? "",
    latest_episode_release_datetime: item.latest_episode_release_datetime ?? "",
    _sortRecent: index,
    _nameLower: name.toLowerCase(),
    _choseong: getChoseong(name),
    _disassembled: disassemble(name).toLowerCase(),
    _search: `${name} ${(item.genre ?? []).join(" ")} ${(item.tags ?? []).join(" ")}`.toLowerCase(),
  };
}

function maybePromptResumeOfflineSync() {
  if (!offlineMeta.syncState.inProgress || offlineStatus.phase === "syncing") return;
  if (sessionStorage.getItem("offline_sync_resume_prompted") === "yes") return;
  sessionStorage.setItem("offline_sync_resume_prompted", "yes");
  const processed = offlineMeta.syncState.nextItemIndex;
  const total = offlineMeta.syncState.totalItems;
  const stageLabel = offlineMeta.syncState.stage === "items" ? "작품" : "에피소드";
  const confirmed = confirm(
    total > 0
      ? `오프라인 메타데이터 다운로드가 중간에 멈췄습니다.\n${stageLabel} 단계 ${processed}/${total}까지 처리했습니다. 이어서 받을까요?`
      : `오프라인 메타데이터 다운로드가 중간에 멈췄습니다.\n${stageLabel} 단계부터 이어서 받을까요?`,
  );
  if (confirmed) {
    syncOfflineMetadata().catch((e) => console.error("Resume sync failed:", e));
  }
}

function normalizeOfflineEpisode(
  item: Pick<RawItem, "id" | "name" | "title"> | Pick<OfflineItemRecord, "id" | "name">,
  ep: RawEpisode,
): OfflineEpisodeRecord {
  return {
    id: ep.id,
    item_id: ep.item_id ?? item.id,
    item_name: item.name ?? ("title" in item ? (item.title ?? "") : ""),
    episode_num: String(ep.episode_num ?? ep.episode_order ?? ""),
    title: ep.subject ?? ep.title ?? "",
    running_time: ep.running_time ?? "",
    thumbnail_path: ep.thumbnail_path ?? "",
    is_free: !!ep.is_free,
    has_preview: !!ep.has_preview,
  };
}

function isChoseongQuery(q: string) {
  return /^[ㄱ-ㅎ\s]+$/.test(q);
}

function isSubsequence(needle: string, haystack: string) {
  let j = 0;
  for (let i = 0; i < haystack.length && j < needle.length; i++) {
    if (haystack[i] === needle[j]) j++;
  }
  return j === needle.length;
}

function levenshtein(a: string, b: string) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = i - 1;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

function scoreOfflineMatch(item: OfflineItemRecord, query: string) {
  const q = String(query || "")
    .trim()
    .toLowerCase();
  if (!q) return 1;

  const nameLower = String(item._nameLower || item.name || "").toLowerCase();
  const choseong = String(item._choseong || "");
  const decomp = String(item._disassembled || "");
  const qChoseong = getChoseong(q);
  const qDecomp = disassemble(q).toLowerCase();

  if (nameLower === q) return 1000;
  const includeIdx = nameLower.indexOf(q);
  if (includeIdx >= 0) return 900 - includeIdx;

  // Multi-token: all space-separated tokens appear somewhere in the name/search field
  const tokens = q.split(/\s+/).filter(Boolean);
  if (tokens.length > 1) {
    const searchField = String(item._search || nameLower);
    if (tokens.every((t) => searchField.includes(t))) return 860;
    const qTokensDecomp = tokens.map((t) => disassemble(t).toLowerCase());
    if (qTokensDecomp.every((t) => decomp.includes(t))) return 820;
  }

  if (isChoseongQuery(q)) {
    const idx = choseong.indexOf(q.replace(/\s+/g, ""));
    if (idx >= 0) return 860 - idx;
  }

  if (qChoseong && choseong.includes(qChoseong)) {
    return 820 - choseong.indexOf(qChoseong);
  }
  if (qDecomp && decomp.includes(qDecomp)) {
    return 780 - decomp.indexOf(qDecomp);
  }
  if (isSubsequence(q, nameLower) || (qDecomp && isSubsequence(qDecomp, decomp))) {
    return 620;
  }

  const nameSlice = nameLower.slice(0, Math.max(q.length + 2, 8));
  const decompSlice = decomp.slice(0, Math.max(qDecomp.length + 4, 16));
  const dist = Math.min(levenshtein(q, nameSlice), qDecomp ? levenshtein(qDecomp, decompSlice) : Infinity);
  if (Number.isFinite(dist) && dist <= Math.max(1, Math.floor(q.length / 3))) {
    return 520 - dist * 40;
  }

  return 0;
}

async function getOfflineAutocompleteItems(query: string, limit = 8) {
  const allItems = await loadOfflineItems();
  return allItems
    .map((item) => ({ item, score: scoreOfflineMatch(item, query) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.item._sortRecent - b.item._sortRecent)
    .slice(0, limit)
    .map((x) => x.item);
}

async function fetchOfflineSourceItems(scope: OfflineScope, startOffset = 0): Promise<RawItem[]> {
  const sourceItems: RawItem[] = [];
  let offset = startOffset;
  let total = Infinity;
  while (offset < total) {
    const params = new URLSearchParams({
      offset: String(offset),
      size: String(OFFLINE_SYNC_PAGE_SIZE),
      sort: "recent",
    });
    const data = await apiFetch<{ results?: RawItem[]; count?: number }>(`/api/search/v1/discover?${params}`);
    const batch = data.results ?? [];
    total = typeof data.count === "number" ? data.count : offset + batch.length;
    sourceItems.push(...batch);
    offset += batch.length;
    setOfflineStatus({
      phase: "syncing",
      message: "작품 메타데이터를 불러오는 중입니다...",
      downloaded: offset,
      total,
    });
    await appendOfflineItemsBatch(
      batch.map((item: any, index: any) => normalizeOfflineItem(item, offset - batch.length + index)),
      scope,
      offset,
      total,
    );
    if (batch.length === 0) break;
  }
  return sourceItems;
}

async function fetchEpisodesForItem(item: RawItem): Promise<OfflineEpisodeRecord[]> {
  const episodes: OfflineEpisodeRecord[] = [];
  let offset = 0;
  const limit = 300;
  while (true) {
    const params = new URLSearchParams({
      item_id: String(item.id),
      offset: String(offset),
      limit: String(limit),
      sort: "oldest",
    });
    const data = await apiFetch<{ results?: RawEpisode[] }>(`/api/episodes/v3/list?${params}`).catch((e: any) => {
      if (e instanceof Error && (e.message.includes("404") || e.message.includes("HTTP 404"))) {
        return { results: [], count: 0, next: null, previous: null };
      }
      throw e;
    });
    const batch = data.results ?? [];
    episodes.push(...batch.map((ep: any) => normalizeOfflineEpisode(item, ep)));
    offset += batch.length;
    if (batch.length < limit) break;
  }
  return episodes;
}

async function syncOfflineMetadata() {
  if (offlineSyncPromise) return offlineSyncPromise;
  offlineSyncPromise = (async () => {
    try {
      offlineItemsCache = null;
      const scope = normalizeOfflineScope(getOfflineScope());
      if (!hasOfflineScope(scope)) {
        throw new Error("작품 또는 에피소드 메타데이터 중 하나는 선택해야 합니다.");
      }
      setOfflineStatus({
        phase: "syncing",
        message: "준비 중...",
        downloaded: 0,
        total: 0,
        error: "",
      });

      const itemResumeOffset =
        offlineMeta.syncState.inProgress && offlineMeta.syncState.stage === "items"
          ? offlineMeta.syncState.nextItemIndex
          : 0;
      const episodeResumeOffset =
        offlineMeta.syncState.inProgress && offlineMeta.syncState.stage === "episodes"
          ? offlineMeta.syncState.nextItemIndex
          : 0;

      let items = await loadOfflineItems();

      if (scope.items || items.length === 0) {
        const itemScope = { items: true, episodes: scope.episodes };
        if (itemResumeOffset === 0 && episodeResumeOffset === 0) {
          await resetOfflineSnapshotForSync(itemScope, "items");
        }
        await refreshOfflineMeta();
        await fetchOfflineSourceItems(itemScope, itemResumeOffset);
        offlineItemsCache = null;
        items = await loadOfflineItems();
      }

      const itemTotal = items.length;
      const resumeFrom = Math.min(episodeResumeOffset, itemTotal);

      if (scope.episodes) {
        const itemTotal = items.length;
        const resumeFrom = Math.min(episodeResumeOffset, itemTotal);

        await beginOfflineEpisodeStage(itemTotal, scope, resumeFrom, itemTotal);
        await refreshOfflineMeta();

        setOfflineStatus({
          phase: "syncing",
          message: "진행 중",
          downloaded: resumeFrom,
          total: itemTotal,
          error: "",
        });

        for (let i = resumeFrom; i < itemTotal; i += OFFLINE_EPISODE_CONCURRENCY) {
          const batch = items.slice(i, i + OFFLINE_EPISODE_CONCURRENCY);
          const results = await Promise.all(batch.map((item) => fetchEpisodesForItem(item)));
          const committedBatch = results.flat();

          if (committedBatch.length > 0) {
            await appendOfflineEpisodes(committedBatch, itemTotal, scope);
          }

          const nextIndex = Math.min(i + batch.length, itemTotal);
          await updateOfflineSyncState(
            {
              inProgress: true,
              stage: "episodes",
              nextItemIndex: nextIndex,
              totalItems: itemTotal,
            },
            scope,
          );

          await refreshOfflineMeta();
          setOfflineStatus({
            phase: "syncing",
            message: "진행 중",
            downloaded: nextIndex,
            total: itemTotal,
            error: "",
          });
        }
      }
      await finalizeOfflineSnapshot(scope, itemTotal, scope.episodes ? offlineMeta.episodeCount : 0);
      await refreshOfflineMeta();
      setOfflineStatus({
        phase: "ready",
        message: "오프라인 메타데이터 준비 완료",
        downloaded: scope.episodes ? offlineMeta.episodeCount : items.length,
        total: scope.episodes ? offlineMeta.episodeCount : items.length,
        error: "",
      });
    } catch (err) {
      setOfflineStatus({
        phase: "error",
        message: "",
        error: err instanceof Error ? err.message : "다운로드 실패",
      });
      throw err;
    } finally {
      offlineSyncPromise = null;
    }
  })();
  return offlineSyncPromise;
}

function offlineMatchesYear(item: OfflineItemRecord, filter: string | null) {
  if (!filter) return true;
  const year = parseInt(String(item.air_year_quarter || "").slice(0, 4), 10);
  if (!Number.isFinite(year)) return false;
  if (/^\d{4}$/.test(filter)) return year === Number(filter);
  if (/^\d{4}\.\.\d{4}$/.test(filter)) {
    const [start, end] = filter.split("..").map(Number);
    return year >= start && year <= end;
  }
  if (filter.endsWith("년대")) {
    const decade = parseInt(filter, 10);
    return Number.isFinite(decade) && year >= decade && year < decade + 10;
  }
  if (filter.endsWith("년대 이전")) {
    const decade = parseInt(filter, 10);
    return Number.isFinite(decade) && year < decade;
  }
  if (filter.endsWith("년대 이후")) {
    const decade = parseInt(filter, 10);
    return Number.isFinite(decade) && year >= decade;
  }
  return true;
}

async function queryOfflineItems(
  state: {
    q?: string;
    original?: string | null;
    ending?: string | null;
    medium?: string | null;
    genre?: string | null;
    year?: string | null;
    sort?: string;
  },
  offset: number,
  size: number,
) {
  const allItems = await loadOfflineItems();
  const q = String(state.q || "").trim();
  let filtered = allItems.filter((item) => {
    if (state.original === "true" && !item.is_laftel_original) return false;
    if (state.ending === "true" && !item.is_ending) return false;
    if (state.medium && item.medium !== state.medium) return false;
    if (state.genre && !(item.genre ?? []).includes(state.genre)) return false;
    if (state.year && !offlineMatchesYear(item, state.year)) return false;
    return true;
  });

  if (q) {
    filtered = filtered
      .map((item) => ({ item, score: scoreOfflineMatch(item, q) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || a.item._sortRecent - b.item._sortRecent)
      .map((x) => x.item);
  }

  if (!q) {
    switch (state.sort) {
      case "avg_rating":
        filtered.sort((a, b) => (b.avg_rating || 0) - (a.avg_rating || 0) || a._sortRecent - b._sortRecent);
        break;
      case "update":
        filtered.sort(
          (a, b) =>
            String(b.latest_episode_release_datetime || "").localeCompare(
              String(a.latest_episode_release_datetime || ""),
            ) || a._sortRecent - b._sortRecent,
        );
        break;
      default:
        filtered.sort((a, b) => a._sortRecent - b._sortRecent);
        break;
    }
  }

  return {
    total: filtered.length,
    items: filtered.slice(offset, offset + size),
  };
}

function getOfflineMeta() {
  return offlineMeta;
}

function getOfflineStatus() {
  return offlineStatus;
}

export {
  subscribeOfflineStatus,
  isOfflineModeEnabled,
  getOfflineScope,
  normalizeOfflineScope,
  saveOfflineScope,
  isOfflineItemModeReady,
  hasDownloadedOfflineItems,
  shouldPreferOfflineItemSearch,
  getOfflineSearchBlockedMessage,
  describeOfflineScope,
  isManualThumbsEnabled,
  isManualCommentsEnabled,
  formatOfflineTime,
  syncOfflineMetadata,
  refreshOfflineMeta,
  maybePromptResumeOfflineSync,
  getOfflineAutocompleteItems,
  queryOfflineItems,
  getOfflineMeta,
  getOfflineStatus,
};
