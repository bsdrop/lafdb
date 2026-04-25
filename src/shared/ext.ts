// Extension bridge — communicates with laftel-ext content script via postMessage.
// Content script must be injected (run_at: document_start) on this origin.

export const EXT_STORAGE_KEY = "laftel_ext_enabled";

export function isExtEnabled(): boolean {
  return localStorage.getItem(EXT_STORAGE_KEY) === "yes";
}

let _initStarted = false;
let _initDone = false;
let _loggedIn = false;
let _myName: string | null = null;
const _callbacks: Array<(loggedIn: boolean) => void> = [];

export function getMyName(): string | null { return _myName; }
export function isExtLoggedIn(): boolean { return _loggedIn; }
export function isExtInitDone(): boolean { return _initDone; }

export function extSend(msg: Record<string, unknown>, timeoutMs = 30000): Promise<any> {
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

// Call this once per page to set up the extension connection.
// cb is called when initialization is complete (loggedIn = whether user is logged in).
export function initExt(cb: (loggedIn: boolean) => void): void {
  if (!isExtEnabled()) return;
  if (_initDone) { cb(_loggedIn); return; }
  _callbacks.push(cb);
  if (_initStarted) return;
  _initStarted = true;

  void (async () => {
    try {
      const status = await extSend({ type: "status" });
      _loggedIn = !!status?.loggedIn;
      if (_loggedIn) {
        try {
          const me = await extSend({ type: "api", method: "GET", path: "/accounts/v2/me/" });
          _myName = (me?.data as any)?.profile?.name ?? (me?.data as any)?.name ?? null;
        } catch (_) {}
      }
    } catch (_) {
      // Extension not installed or not responding on this page
    }
    _initDone = true;
    for (const fn of _callbacks) fn(_loggedIn);
    _callbacks.length = 0;
  })();
}
