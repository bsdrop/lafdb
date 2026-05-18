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
// 기존 base가 2026-04-01이었는데, 그보다 이전 시점(시계 오차, 다른 기기에서
// import한 옛 기록)이 들어오면 음수가 0으로 잘려 정렬이 깨졌다. 안전한 과거로
// 옮긴다. normalizeStoredTimestamps에서 옛 base로 인코딩된 값을 새 base로 재인코딩한다.
const WATCH_TIME_BASE_MS = Date.UTC(2020, 0, 1, 0, 0, 0, 0);
const LEGACY_WATCH_TIME_BASE_MS = Date.UTC(2026, 3, 1, 0, 0, 0, 0);
const WATCH_TIME_STEP_MS = 5000;
// 옛 base와 새 base의 step 단위 차이. 옛 인코딩 값에 더하면 새 인코딩 값이 된다.
const WATCH_BASE_SHIFT_STEPS = Math.floor((LEGACY_WATCH_TIME_BASE_MS - WATCH_TIME_BASE_MS) / WATCH_TIME_STEP_MS);
// 옛 base/새 base를 값만으로 구별할 수 없으므로(둘 다 작은 양수 범위) 1회성 마이그레이션 마커를 둔다.
const WATCH_TIME_BASE_VERSION_KEY = "watch_history_base_v";
const WATCH_TIME_BASE_VERSION_CURRENT = "2020-01-01";
export const EXPORT_PREFIXES = [WATCH_STORAGE_KEY];
export const EXPORT_EXACT = ["player_autoskip", "player_autoplay", "time_pref"];

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
      // dur=0(아직 metadata 미도착, reinit 중)이면 기존 dur을 보존한다.
      // compactDefined가 0을 통과시키므로 명시적으로 undefined로 패치에서 제외.
      const durPatch = dur > 0 ? Math.floor(dur) : undefined;
      const patch: Partial<WatchProgressEntry> = {
        itemId,
        episodeTitle: epTitle ?? store.episodes[epId]?.episodeTitle,
        t: Math.floor(t),
      };
      if (durPatch !== undefined) patch.dur = durPatch;
      store.episodes[epId] = mergeEpisode(store.episodes[epId], patch);
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
  let baseVersion: string | null = null;
  try {
    baseVersion = storage.getItem(WATCH_TIME_BASE_VERSION_KEY);
  } catch {
    /* private mode 등 */
  }
  const needsBaseShift = baseVersion !== WATCH_TIME_BASE_VERSION_CURRENT;
  let dirty = false;

  const fix = (value: { updatedAt?: number } | null | undefined): void => {
    if (!value) return;
    const updatedAt = Number(value.updatedAt);
    if (!Number.isFinite(updatedAt) || updatedAt <= 0) return;
    // raw ms 형태(>1e12): 새 base로 인코딩.
    if (updatedAt > 1_000_000_000_000) {
      value.updatedAt = encodeWatchTimestamp(updatedAt);
      dirty = true;
      return;
    }
    // 옛 base로 인코딩된 작은 양수: 새 base로 옮긴다.
    if (needsBaseShift) {
      value.updatedAt = updatedAt + WATCH_BASE_SHIFT_STEPS;
      dirty = true;
    }
  };
  for (const value of Object.values(store.items)) fix(value);
  for (const value of Object.values(store.episodes)) fix(value);

  if (dirty) writeWatchStore(storage, store);
  if (needsBaseShift) {
    try {
      storage.setItem(WATCH_TIME_BASE_VERSION_KEY, WATCH_TIME_BASE_VERSION_CURRENT);
    } catch {
      /* ignore */
    }
  }
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
    // 캐시·보류 write 무효화.
    if (storage === localStorage) {
      if (_writeDebounceTimer !== null) {
        clearTimeout(_writeDebounceTimer);
        _writeDebounceTimer = null;
      }
      _pendingWriteStorage = null;
      _cachedStore = null;
      _cachedStoreFor = null;
    }
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
  // WatchHistory.saveItem과 의도가 같다(메타 머지). 차이는 saveItem이 lastEpisodeId까지
  // 받을 수 있다는 것뿐. 호출처가 lastEpisodeId 없이 메타만 갱신하려면 이 헬퍼를 쓴다.
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
    ...Object.values(store.episodes)
      .map((progress) => String(progress.itemId ?? ""))
      .filter(Boolean),
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
    const updatedAt = Math.max(getUpdatedAt(item), progresses[0] ? getUpdatedAt(progresses[0].data) : 0);
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
    // 보류 중인 debounce write가 import 결과를 덮어쓰지 않도록 먼저 캐시·타이머 초기화.
    if (storage === localStorage) {
      if (_writeDebounceTimer !== null) {
        clearTimeout(_writeDebounceTimer);
        _writeDebounceTimer = null;
      }
      _pendingWriteStorage = null;
      _cachedStore = nextStore;
      _cachedStoreFor = storage;
    }
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
  const items = store.items && typeof store.items === "object" ? (store.items as Record<string, WatchItemEntry>) : {};
  const episodes =
    store.episodes && typeof store.episodes === "object" ? (store.episodes as Record<string, WatchProgressEntry>) : {};
  return { version: 2, items, episodes };
}

// localStorage I/O 비용을 줄이기 위한 메모리 캐시.
// 호출처가 1초마다 saveProgress + 5/10초마다 hash 저장 등 빈번하게 호출되는데,
// 매번 JSON.parse → mutate → JSON.stringify → setItem은 100건+ 시청기록 사용자에게 큰 부담.
// 캐시는 같은 storage 참조에만 유효(테스트 등에서 다른 Storage를 넘기는 케이스는 미적용).
let _cachedStore: WatchStore | null = null;
let _cachedStoreFor: Storage | null = null;
let _writeDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let _pendingWriteStorage: Storage | null = null;
const WRITE_DEBOUNCE_MS = 1500;

function readWatchStore(storage: Storage): WatchStore {
  if (storage === _cachedStoreFor && _cachedStore) return _cachedStore;
  const parsed = coerceStore(safeParseJSON<WatchStore>(storage.getItem(WATCH_STORAGE_KEY))) ?? emptyWatchStore();
  if (storage === localStorage) {
    _cachedStore = parsed;
    _cachedStoreFor = storage;
  }
  return parsed;
}

function flushWatchStoreWrite(): void {
  if (_writeDebounceTimer !== null) {
    clearTimeout(_writeDebounceTimer);
    _writeDebounceTimer = null;
  }
  const storage = _pendingWriteStorage;
  _pendingWriteStorage = null;
  if (!storage || !_cachedStore) return;
  try {
    storage.setItem(WATCH_STORAGE_KEY, JSON.stringify(_cachedStore));
  } catch (e) {
    console.warn("[WatchHistory] write failed:", e);
  }
}

function writeWatchStore(storage: Storage, store: WatchStore): void {
  // 캐시 갱신은 즉시(같은 페이지 내 후속 read는 새 값을 본다).
  if (storage === localStorage) {
    _cachedStore = store;
    _cachedStoreFor = storage;
    _pendingWriteStorage = storage;
    if (_writeDebounceTimer === null) {
      _writeDebounceTimer = setTimeout(() => {
        _writeDebounceTimer = null;
        flushWatchStoreWrite();
      }, WRITE_DEBOUNCE_MS);
    }
    return;
  }
  // 캐시 미적용 경로(별도 Storage 객체): 그대로 동기 write.
  storage.setItem(WATCH_STORAGE_KEY, JSON.stringify(store));
}

// 페이지 종료/숨김 시 보류 중인 write를 반드시 동기로 내보낸다.
if (typeof window !== "undefined") {
  const flushOnExit = (): void => flushWatchStoreWrite();
  window.addEventListener("pagehide", flushOnExit);
  window.addEventListener("beforeunload", flushOnExit);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushWatchStoreWrite();
  });
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
