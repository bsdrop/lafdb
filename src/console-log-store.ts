type LogLevel = "debug" | "log" | "warn" | "error";

type LogEntry = {
  ts: number;
  level: LogLevel;
  message: string;
};

type LogSession = {
  id: string;
  startedAt: number;
  href: string;
  ua: string;
  logs: LogEntry[];
};

type LogStore = {
  version: 1;
  sessions: LogSession[];
};

declare global {
  interface Window {
    __lafConsoleLoggerInstalled?: boolean;
    __lafLogViewer?: {
      open: () => void;
      exportText: () => string;
      clear: () => void;
    };
  }
}

const STORE_KEY = "laf_console_logs_v1";
const MAX_SESSIONS = 30;
const MAX_BYTES = 1024 * 1024; // 1MB
const MAX_AGE_MS = 3 * 24 * 60 * 60000; // 3일
const MAX_MESSAGE_CHARS = 4000;
const FLUSH_DEBOUNCE_MS = 1000;

let store: LogStore | null = null;
let currentSession: LogSession | null = null;
let flushTimer: number | null = null;
let viewerEl: HTMLElement | null = null;
let originalConsole: Pick<Console, LogLevel> | null = null;

function readStore(): LogStore {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return { version: 1, sessions: [] };
    const parsed = JSON.parse(raw) as LogStore;
    if (parsed?.version !== 1 || !Array.isArray(parsed.sessions)) {
      return { version: 1, sessions: [] };
    }
    return parsed;
  } catch {
    return { version: 1, sessions: [] };
  }
}

function safeJsonStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(
    value,
    (_key, current) => {
      if (current instanceof Error) {
        return {
          name: current.name,
          message: current.message,
          stack: current.stack,
        };
      }
      if (typeof Element !== "undefined" && current instanceof Element) {
        return `<${current.tagName.toLowerCase()}${current.id ? ` id="${current.id}"` : ""}>`;
      }
      if (typeof current === "object" && current !== null) {
        if (seen.has(current)) return "[Circular]";
        seen.add(current);
      }
      return current;
    },
  );
}

function stringifyArg(arg: unknown): string {
  if (typeof arg === "string") return arg;
  if (typeof arg === "number" || typeof arg === "boolean" || arg == null) {
    return String(arg);
  }
  try {
    return safeJsonStringify(arg);
  } catch {
    try {
      return String(arg);
    } catch {
      return "[Unserializable]";
    }
  }
}

function toMessage(args: unknown[]): string {
  const joined = args.map(stringifyArg).join(" ");
  return joined.length > MAX_MESSAGE_CHARS
    ? `${joined.slice(0, MAX_MESSAGE_CHARS)}...`
    : joined;
}

function storeSizeBytes(next: LogStore): number {
  try {
    return new TextEncoder().encode(JSON.stringify(next)).length;
  } catch {
    return JSON.stringify(next).length * 2;
  }
}

function trimStore(): void {
  if (!store) return;

  const now = Date.now();
  // 3일 이상 된 세션 삭제 (현재 세션 제외)
  store.sessions = store.sessions.filter((s) => {
    if (currentSession && s.id === currentSession.id) return true;
    return now - s.startedAt < MAX_AGE_MS;
  });

  // 너무 많은 세션 삭제
  while (store.sessions.length > MAX_SESSIONS) {
    store.sessions.shift();
  }
  // 용량 초과 시 오래된 세션부터 삭제
  while (store.sessions.length > 0 && storeSizeBytes(store) > MAX_BYTES) {
    // 현재 세션만 남았는데도 용량이 큰 경우, 현재 세션의 오래된 로그를 일부 삭제
    if (store.sessions.length === 1 && store.sessions[0].id === currentSession?.id) {
      const logs = store.sessions[0].logs;
      if (logs.length <= 1) break;
      logs.splice(0, Math.max(1, Math.ceil(logs.length / 5)));
    } else {
      store.sessions.shift();
    }
  }
}

function isSessionWorthy(s: LogSession): boolean {
  if (currentSession && s.id === currentSession.id) return true;
  try {
    const url = new URL(s.href, location.origin);
    const path = url.pathname;

    // 플레이어 페이지는 항상 가치 있음
    if (
      path.includes("/player.html") ||
      path.includes("/player/") ||
      path.endsWith("/player")
    ) {
      return true;
    }

    // 유의미한 에러가 있는 세션
    const hasError = s.logs.some((l) => {
      if (l.level !== "error") return false;
      const msg = l.message;
      if (/Content Security Policy|\[Report Only\]|\bCSP\b/i.test(msg)) return false;
      if (/warp-suggest/i.test(msg)) return false;
      return true;
    });
    if (hasError) return true;

    // 인덱스/아이템 페이지는 에러 없으면 무시
    const isIndex = path === "/" || path.endsWith("/index.html") || path.endsWith("/index") || path.endsWith("/index/");
    const isItem = path.includes("/item.html") || path.includes("/item/") || path.endsWith("/item");
    if (isIndex || isItem) return false;

    return true;
  } catch {
    return true;
  }
}

function flushStore(): void {
  if (!store) return;
  
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }

  // 가비지 컬렉션: 가치 없는 과거 세션 정리
  store.sessions = store.sessions.filter(isSessionWorthy);
  
  trimStore();

  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
  } catch (e) {
    // 쿼터 초과 시 더 공격적으로 트리밍 후 재시도
    if (store.sessions.length > 1) {
      store.sessions.shift();
      flushStore();
    }
  }
}

function scheduleFlush(immediate = false): void {
  if (immediate) {
    flushStore();
    return;
  }
  if (flushTimer != null) return;
  flushTimer = window.setTimeout(() => {
    flushTimer = null;
    flushStore();
  }, FLUSH_DEBOUNCE_MS);
}

function addEntry(level: LogLevel, args: unknown[]): void {
  if (!store || !currentSession) return;
  currentSession.logs.push({
    ts: Date.now(),
    level,
    message: toMessage(args),
  });
  scheduleFlush(level === "error");
}


function formatTs(ts: number): string {
  try {
    return new Date(ts).toLocaleString("ko-KR", { hour12: false });
  } catch {
    return String(ts);
  }
}

function sessionLabel(session: LogSession): string {
  return `${formatTs(session.startedAt)} | ${session.href}`;
}

function createSession(): LogSession {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    startedAt: Date.now(),
    href: location.href,
    ua: navigator.userAgent,
    logs: [],
  };
}

function exportText(): string {
  const nextStore = store ?? readStore();
  return nextStore.sessions
    .map((session) => {
      const lines = [
        `=== ${sessionLabel(session)} ===`,
        `ua: ${session.ua}`,
        ...session.logs.map((entry) => `[${formatTs(entry.ts)}] [${entry.level}] ${entry.message}`),
      ];
      return lines.join("\n");
    })
    .join("\n\n");
}

function closeViewer(): void {
  viewerEl?.remove();
  viewerEl = null;
}

function openViewer(): void {
  closeViewer();
  const nextStore = store ?? readStore();
  const overlay = document.createElement("div");
  overlay.id = "laf-log-viewer";
  overlay.style.cssText = [
    "position:fixed",
    "inset:0",
    "z-index:10000",
    "background:rgba(0,0,0,.72)",
    "display:flex",
    "align-items:center",
    "justify-content:center",
    "padding:16px",
  ].join(";");

  const panel = document.createElement("div");
  panel.style.cssText = [
    "width:min(1100px,100%)",
    "height:min(85vh,100%)",
    "display:grid",
    "grid-template-columns:minmax(240px,320px) 1fr",
    "background:#111215",
    "color:#ddd",
    "border:1px solid #2b2f38",
    "border-radius:14px",
    "overflow:hidden",
    "box-shadow:0 24px 60px rgba(0,0,0,.45)",
  ].join(";");

  const sidebar = document.createElement("div");
  sidebar.style.cssText = "border-right:1px solid #222831;overflow:auto;background:#0c0d10;";
  const main = document.createElement("div");
  main.style.cssText = "display:flex;flex-direction:column;min-width:0;min-height:0;overflow:hidden;";

  const header = document.createElement("div");
  header.style.cssText = "display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border-bottom:1px solid #222831;";
  header.innerHTML = `<strong style="font-size:14px;">콘솔 로그</strong>`;
  const actions = document.createElement("div");
  actions.style.cssText = "display:flex;gap:8px;flex-wrap:wrap;";
  const mkBtn = (text: string) => {
    const btn = document.createElement("button");
    btn.textContent = text;
    btn.style.cssText =
      "padding:7px 10px;border-radius:8px;border:1px solid #39414f;background:#171b22;color:#e5e7eb;cursor:pointer;font:12px sans-serif;";
    return btn;
  };
  const copyBtn = mkBtn("복사");
  const clearBtn = mkBtn("삭제");
  const closeBtn = mkBtn("닫기");
  actions.append(copyBtn, clearBtn, closeBtn);
  header.append(actions);

  const body = document.createElement("div");
  body.style.cssText = "flex:1 1 auto;min-height:0;padding:12px;overflow:auto;white-space:pre-wrap;word-break:break-word;font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;";

  const sessions = [...nextStore.sessions].reverse();
  let selected = sessions[0] ?? null;

  function renderSidebar(): void {
    sidebar.innerHTML = "";
    for (const session of sessions) {
      const btn = document.createElement("button");
      btn.textContent = sessionLabel(session);
      btn.style.cssText = [
        "display:block",
        "width:100%",
        "padding:10px 12px",
        "text-align:left",
        "border:none",
        "border-bottom:1px solid #171b22",
        "background:" + (selected?.id === session.id ? "#1a1f29" : "transparent"),
        "color:#d4d8df",
        "cursor:pointer",
        "font:12px/1.35 sans-serif",
      ].join(";");
      btn.addEventListener("click", () => {
        selected = session;
        renderSidebar();
        renderBody();
      });
      sidebar.appendChild(btn);
    }
  }

  function renderBody(): void {
    if (!selected) {
      body.textContent = "저장된 로그가 없습니다.";
      return;
    }
    body.textContent = [
      `session: ${sessionLabel(selected)}`,
      `ua: ${selected.ua}`,
      "",
      ...selected.logs.map((entry) => `[${formatTs(entry.ts)}] [${entry.level}] ${entry.message}`),
    ].join("\n");
  }

  copyBtn.addEventListener("click", async () => {
    const text = exportText();
    try {
      await navigator.clipboard.writeText(text);
      if (originalConsole) originalConsole.log("[log-viewer] copied logs");
    } catch {
      // FIXME: ignore
    }
  });
  clearBtn.addEventListener("click", () => {
    if (!selected) return;
    store = store ?? readStore();
    const selectedId = selected.id;
    store.sessions = store.sessions.filter((session) => session.id !== selectedId);
    if (currentSession?.id === selectedId) {
      currentSession = createSession();
      store.sessions.push(currentSession);
    }
    flushStore();
    sessions.splice(0, sessions.length, ...store.sessions.slice().reverse());
    selected = sessions[0] ?? null;
    renderSidebar();
    renderBody();
  });
  closeBtn.addEventListener("click", closeViewer);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeViewer();
  });

  main.append(header, body);
  panel.append(sidebar, main);
  overlay.append(panel);
  document.body.appendChild(overlay);
  viewerEl = overlay;
  renderSidebar();
  renderBody();
}

export function initConsoleLogStore(): void {
  if (typeof window === "undefined" || window.__lafConsoleLoggerInstalled) return;
  window.__lafConsoleLoggerInstalled = true;
  originalConsole = {
    debug: console.debug.bind(console),
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };

  store = readStore();
  currentSession = createSession();
  store.sessions.push(currentSession);
  trimStore();
  flushStore();

  (["debug", "log", "warn", "error"] as const).forEach((level) => {
    const orig = originalConsole![level];
    console[level] = ((...args: unknown[]) => {
      addEntry(level, args);
      orig(...args);
    }) as Console[typeof level];
  });

  window.addEventListener("error", (e) => {
    addEntry("error", [
      e.message,
      e.filename ? `@ ${e.filename}:${e.lineno}:${e.colno}` : "",
    ]);
  });
  window.addEventListener("unhandledrejection", (e) => {
    addEntry("error", ["Unhandled rejection:", e.reason]);
  });
  window.addEventListener("beforeunload", flushStore);
  window.addEventListener("pagehide", flushStore);
  window.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushStore();
  });

  window.__lafLogViewer = {
    open: openViewer,
    exportText,
    clear: () => {
      localStorage.removeItem(STORE_KEY);
      store = { version: 1, sessions: [] };
      currentSession = null;
    },
  };
}
