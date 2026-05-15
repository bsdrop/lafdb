export type ExtRoute = "direct" | "server";
export const EXT_STORAGE_KEY = "laftel_ext_enabled";

export function isExtEnabled(): boolean {
  return localStorage.getItem(EXT_STORAGE_KEY) === "yes";
}

let _initStarted = false;
let _initDone = false;
let _loggedIn = false;
let _myName: string | null = null;
let _route: ExtRoute = "server";
let _initPromise: Promise<void> | null = null;
const _callbacks: Array<(loggedIn: boolean) => void> = [];

export function getMyName(): string | null { return _myName; }
export function isExtLoggedIn(): boolean { return _loggedIn; }
export function isExtInitDone(): boolean { return _initDone; }
export function getExtRoute(): ExtRoute { return _route; }

function normalizeRoute(route: unknown): ExtRoute {
  return route === "direct" ? "direct" : "server";
}

function finishInit(): void {
  _initDone = true;
  for (const fn of _callbacks) fn(_loggedIn);
  _callbacks.length = 0;
}

window.addEventListener("message", (e: MessageEvent) => {
  if (e.source !== window || (e.data as any)?.ns !== "lafdb-ext-res" || (e.data as any)?.type !== "ready") return;
  _route = normalizeRoute((e.data as any)?.route);
});

export function extSend(msg: Record<string, unknown>, timeoutMs = 20000): Promise<any> {
  return new Promise((resolve, reject) => {
    const rid = crypto.randomUUID();
    const tid = setTimeout(() => {
      window.removeEventListener("message", h);
      reject(new Error("extension timeout"));
    }, timeoutMs);
    const h = (e: MessageEvent) => {
      if (e.source !== window || (e.data as any)?.ns !== "lafdb-ext-res" || (e.data as any)?.rid !== rid) return;
      clearTimeout(tid);
      window.removeEventListener("message", h);
      resolve((e.data as any).result);
    };
    window.addEventListener("message", h);
    window.postMessage({ ns: "lafdb-ext", rid, ...msg }, location.origin);
  });
}

export async function ensureExtStatus(): Promise<void> {
  if (!isExtEnabled()) return;
  if (_initDone) return;
  if (_initPromise) {
    await _initPromise;
    return;
  }

  _initStarted = true;
  _initPromise = (async () => {
    try {
      const status = await extSend({ type: "status" });
      _loggedIn = !!status?.loggedIn;
      _route = normalizeRoute(status?.route);
      if (_loggedIn) {
        try {
          const me = await extSend({ type: "api", method: "GET", path: "/accounts/v2/me/" });
          _myName = (me?.data as any)?.profile?.name ?? (me?.data as any)?.name ?? null;
        } catch (e) {
          console.warn("[EXT] /me fetch failed:", e);
        }
      }
    } catch (e) {
      console.warn("[EXT] extension status check failed (not installed or not responding):", e);
    }
    finishInit();
  })();

  await _initPromise;
}

export function initExt(cb: (loggedIn: boolean) => void): void {
  if (!isExtEnabled()) return;
  if (_initDone) {
    cb(_loggedIn);
    return;
  }
  _callbacks.push(cb);
  if (_initStarted) return;
  void ensureExtStatus();
}
