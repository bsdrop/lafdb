export interface WatchItemEntry {
  itemName?: string;
  itemThumbPath?: string;
  itemMedium?: string;
  lastEpisodeId?: string;
  updatedAt?: number;
}

export interface WatchProgressEntry {
  itemId?: string;
  episodeTitle?: string;
  episodeNum?: string;
  t?: number;
  dur?: number;
  updatedAt?: number;
}

export interface WatchHistoryGroup {
  itemId: string;
  item: WatchItemEntry | null;
  progresses: Array<{ epId: string; data: WatchProgressEntry }>;
  latestEpisodeId: string;
  latestEpisodeTitle: string;
  updatedAt: number;
}

interface WatchStore {
  version: 2;
  items: Record<string, WatchItemEntry>;
  episodes: Record<string, WatchProgressEntry>;
}

export const WATCH_STORAGE_KEY = "watch_history_v1";
const WATCH_TIME_BASE_MS = Date.UTC(2026, 3, 1, 0, 0, 0, 0);
const WATCH_TIME_STEP_MS = 5000;
export const EXPORT_PREFIXES = [WATCH_STORAGE_KEY];
export const EXPORT_EXACT = [
  "player_autoskip",
  "player_autoplay",
  "time_pref",
];

export const WatchHistory = {
  saveItem(itemId: string, meta: Partial<WatchItemEntry>): void {
    if (!itemId) return;
    try {
      const store = readWatchStore(localStorage);
      store.items[itemId] = mergeItem(store.items[itemId], meta);
      writeWatchStore(localStorage, store);
    } catch (e) {
      console.warn("[WatchHistory] saveItem:", e);
    }
  },

  saveEpisode(itemId: string, epId: string, meta: Partial<WatchProgressEntry>): void {
    if (!itemId || !epId) return;
    try {
      const store = readWatchStore(localStorage);
      store.episodes[epId] = mergeEpisode(store.episodes[epId], {
        ...meta,
        itemId,
      });
      store.items[itemId] = mergeItem(store.items[itemId], {
        lastEpisodeId: epId,
      });
      writeWatchStore(localStorage, store);
    } catch (e) {
      console.warn("[WatchHistory] saveEpisode:", e);
    }
  },

  clearProgress(epId: string): void {
    if (!epId) return;
    try {
      const store = readWatchStore(localStorage);
      const itemId = String(store.episodes[epId]?.itemId ?? "");
      delete store.episodes[epId];
      refreshItemLastEpisode(store, itemId);
      writeWatchStore(localStorage, store);
    } catch (e) {
      console.error("[WatchHistory] clearProgress failed:", e);
    }
  },

  saveProgress(epId: string, t: number, dur: number, itemId: string | null, epTitle: string | null): void {
    if (!epId || !itemId || t < 1) return;
    try {
      const store = readWatchStore(localStorage);
      store.episodes[epId] = mergeEpisode(store.episodes[epId], {
        itemId,
        episodeTitle: epTitle ?? store.episodes[epId]?.episodeTitle,
        t: Math.floor(t),
        dur: dur > 0 ? Math.floor(dur) : 0,
      });
      store.items[itemId] = mergeItem(store.items[itemId], {
        lastEpisodeId: epId,
      });
      writeWatchStore(localStorage, store);
    } catch (e) {
      console.warn("[WatchHistory] saveProgress:", e);
    }
  },

  getItem(itemId: string): WatchItemEntry | null {
    return readWatchStore(localStorage).items[itemId] ?? null;
  },

  getProgress(epId: string): WatchProgressEntry | null {
    return readWatchStore(localStorage).episodes[epId] ?? null;
  },
};

export function normalizeStoredTimestamps(storage: Storage = localStorage): void {
  const store = readWatchStore(storage);
  let dirty = false;
  for (const value of Object.values(store.items)) {
    const updatedAt = Number(value?.updatedAt);
    if (!Number.isFinite(updatedAt) || updatedAt <= 1_000_000_000_000) continue;
    value.updatedAt = encodeWatchTimestamp(updatedAt);
    dirty = true;
  }
  for (const value of Object.values(store.episodes)) {
    const updatedAt = Number(value?.updatedAt);
    if (!Number.isFinite(updatedAt) || updatedAt <= 1_000_000_000_000) continue;
    value.updatedAt = encodeWatchTimestamp(updatedAt);
    dirty = true;
  }
  if (dirty) writeWatchStore(storage, store);
}

export function isExportKey(key: string): boolean {
  return EXPORT_PREFIXES.some((p) => key.startsWith(p)) || EXPORT_EXACT.includes(key);
}

export function getExportData(storage: Storage = localStorage): Record<string, unknown> {
  const data: Record<string, unknown> = {
    [WATCH_STORAGE_KEY]: readWatchStore(storage),
  };
  for (const key of EXPORT_EXACT) {
    const raw = storage.getItem(key);
    if (raw === null) continue;
    data[key] = safeParseUnknown(raw);
  }
  return data;
}

export function removeItemHistory(itemId: string, storage: Storage = localStorage): void {
  const store = readWatchStore(storage);
  delete store.items[itemId];
  for (const [epId, progress] of Object.entries(store.episodes)) {
    if (String(progress.itemId ?? "") !== itemId) continue;
    delete store.episodes[epId];
  }
  writeWatchStore(storage, store);
}

export function removeEpisodeHistory(epId: string, storage: Storage = localStorage): void {
  const store = readWatchStore(storage);
  const itemId = String(store.episodes[epId]?.itemId ?? "");
  delete store.episodes[epId];
  refreshItemLastEpisode(store, itemId);
  writeWatchStore(storage, store);
}

export function clearAllWatchHistory(storage: Storage = localStorage): void {
  try {
    storage.removeItem(WATCH_STORAGE_KEY);
  } catch (err) {
    console.error(err);
  }
}

export function updateItemHistoryMeta(
  itemId: string,
  meta: { itemName?: string; itemThumbPath?: string; itemMedium?: string },
  storage: Storage = localStorage,
): void {
  if (!itemId) return;
  const store = readWatchStore(storage);
  store.items[itemId] = mergeItem(store.items[itemId], meta);
  writeWatchStore(storage, store);
}

export function updateEpisodeHistoryMeta(
  epId: string,
  meta: { episodeTitle?: string; episodeNum?: string },
  storage: Storage = localStorage,
): void {
  if (!epId) return;
  const store = readWatchStore(storage);
  const current = store.episodes[epId];
  if (!current) return;
  store.episodes[epId] = mergeEpisode(current, meta);
  writeWatchStore(storage, store);
}

export function listWatchHistory(storage: Storage = localStorage): WatchHistoryGroup[] {
  const store = readWatchStore(storage);
  const itemIds = new Set<string>([
    ...Object.keys(store.items),
    ...Object.values(store.episodes).map((progress) => String(progress.itemId ?? "")).filter(Boolean),
  ]);

  const groups: WatchHistoryGroup[] = [];
  for (const itemId of itemIds) {
    const item = store.items[itemId] ?? null;
    const progresses = Object.entries(store.episodes)
      .filter(([, progress]) => String(progress.itemId ?? "") === itemId)
      .map(([epId, data]) => ({ epId, data }))
      .sort((a, b) => getUpdatedAt(b.data) - getUpdatedAt(a.data));
    const latestEpisodeId = String(item?.lastEpisodeId ?? progresses[0]?.epId ?? "");
    const latestData = (latestEpisodeId ? store.episodes[latestEpisodeId] : null) ?? progresses[0]?.data ?? null;
    const latestEpisodeTitle = formatStoredEpisodeLabel(latestData);
    const updatedAt = Math.max(
      getUpdatedAt(item),
      progresses[0] ? getUpdatedAt(progresses[0].data) : 0,
    );
    groups.push({
      itemId,
      item,
      progresses,
      latestEpisodeId,
      latestEpisodeTitle,
      updatedAt,
    });
  }

  groups.sort((a, b) => b.updatedAt - a.updatedAt);
  return groups;
}

export type ImportMode = "merge" | "overwrite";

export function applyImportData(
  data: Record<string, unknown>,
  mode: ImportMode,
  storage: Storage = localStorage,
): { imported: number; failed: number } {
  try {
    const nextStore = normalizeImportedStore(data, mode === "merge" ? readWatchStore(storage) : emptyWatchStore());
    storage.setItem(WATCH_STORAGE_KEY, JSON.stringify(nextStore));
    for (const exactKey of EXPORT_EXACT) {
      if (data[exactKey] === undefined) continue;
      storage.setItem(exactKey, serializeStorageValue(data[exactKey]));
    }
    return { imported: 1, failed: 0 };
  } catch (e) {
    console.warn("import failed:", e);
    return { imported: 0, failed: 1 };
  }
}

function normalizeImportedStore(data: Record<string, unknown>, base: WatchStore): WatchStore {
  const imported = coerceStore(data[WATCH_STORAGE_KEY]);
  if (!imported) return base;
  if (base === emptyWatchStore()) return imported;
  return {
    version: 2,
    items: { ...base.items, ...imported.items },
    episodes: { ...base.episodes, ...imported.episodes },
  };
}

function coerceStore(value: unknown): WatchStore | null {
  if (!value || typeof value !== "object") return null;
  const store = value as Partial<WatchStore>;
  const items = store.items && typeof store.items === "object" ? store.items as Record<string, WatchItemEntry> : {};
  const episodes = store.episodes && typeof store.episodes === "object" ? store.episodes as Record<string, WatchProgressEntry> : {};
  return { version: 2, items, episodes };
}

function readWatchStore(storage: Storage): WatchStore {
  return coerceStore(safeParseJSON<WatchStore>(storage.getItem(WATCH_STORAGE_KEY))) ?? emptyWatchStore();
}

function writeWatchStore(storage: Storage, store: WatchStore): void {
  storage.setItem(WATCH_STORAGE_KEY, JSON.stringify(store));
}

function emptyWatchStore(): WatchStore {
  return { version: 2, items: {}, episodes: {} };
}

function mergeItem(current: WatchItemEntry | undefined, patch: Partial<WatchItemEntry>): WatchItemEntry {
  return {
    ...(current ?? {}),
    ...compactDefined(patch),
    updatedAt: encodeWatchTimestamp(Date.now()),
  };
}

function mergeEpisode(current: WatchProgressEntry | undefined, patch: Partial<WatchProgressEntry>): WatchProgressEntry {
  return {
    ...(current ?? {}),
    ...compactDefined(patch),
    updatedAt: encodeWatchTimestamp(Date.now()),
  };
}

function refreshItemLastEpisode(store: WatchStore, itemId: string): void {
  if (!itemId) return;
  const progresses = Object.entries(store.episodes)
    .filter(([, progress]) => String(progress.itemId ?? "") === itemId)
    .sort((a, b) => getUpdatedAt(b[1]) - getUpdatedAt(a[1]));
  if (progresses.length === 0) {
    delete store.items[itemId];
    return;
  }
  const current = store.items[itemId] ?? {};
  store.items[itemId] = {
    ...current,
    lastEpisodeId: progresses[0][0],
    updatedAt: Math.max(getUpdatedAt(current), getUpdatedAt(progresses[0][1])),
  };
}

function formatStoredEpisodeLabel(progress: WatchProgressEntry | null | undefined): string {
  const title = String(progress?.episodeTitle ?? "").trim();
  const episodeNum = String(progress?.episodeNum ?? "").trim();
  if (episodeNum && title) return `${episodeNum}화 ${title}`;
  if (title) return title;
  if (episodeNum) return `${episodeNum}화`;
  return "";
}

function compactDefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined || entry === null || entry === "") continue;
    out[key as keyof T] = entry as T[keyof T];
  }
  return out;
}

function getUpdatedAt(value: { updatedAt?: number } | null | undefined): number {
  return decodeWatchTimestamp(Number(value?.updatedAt) || 0);
}

function serializeStorageValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function safeParseUnknown(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function safeParseJSON<T>(raw: string | null): T | null {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function encodeWatchTimestamp(ms: number): number {
  return Math.max(0, Math.floor((ms - WATCH_TIME_BASE_MS) / WATCH_TIME_STEP_MS));
}

function decodeWatchTimestamp(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (value > 1_600_000_000_000) return value;
  return WATCH_TIME_BASE_MS + value * WATCH_TIME_STEP_MS;
}
