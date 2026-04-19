import { Player } from "./player.js";
import { rewriteCdnUrl } from "../shared/cdn";

declare const ManagedMediaSource:
  | (typeof MediaSource & { canConstructInDedicatedWorker?: boolean })
  | undefined;

declare function _dlInit(mpdUrl: string, playerOrWorker: Player | Worker, isWorker: boolean): void;
declare function _dlHandleMsg(data: Record<string, unknown>): void;

declare global {
  interface Window {
    _dlDurSecs?: number;
    _currentWorker?: Worker | null;
    _currentPlayer?: Player | null;
    _workerAc?: AbortController | null;
  }
}

const rewriteCDN = rewriteCdnUrl;

const MS: typeof MediaSource | undefined =
  typeof ManagedMediaSource !== "undefined"
    ? ManagedMediaSource
    : typeof MediaSource !== "undefined"
      ? MediaSource
      : undefined;

if (localStorage.getItem("cv_auto") === "yes") document.body.classList.add("cv-auto");

function cleanupPreviousPlayer(): void {
  clearAutoplayPrompt();
  if (window._currentWorker) {
    window._currentWorker.terminate();
    window._currentWorker = null;
  }
  if (window._workerAc) {
    window._workerAc.abort();
    window._workerAc = null;
  }
  if (window._currentPlayer) {
    window._currentPlayer.destroy();
    window._currentPlayer = null;
  }
}

function showError(msg: string): void {
  const box = document.getElementById("video-box");
  if (!box) return;
  const overlay = document.createElement("div");
  overlay.className = "error-overlay";
  overlay.style.cssText =
    "position:absolute;inset:0;z-index:50;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.82);padding:24px;";
  const p = document.createElement("p");
  p.style.cssText =
    "color:#aaa;font-size:14px;line-height:1.5;text-align:center;max-width:100%;word-break:keep-all;";
  p.textContent = msg || "재생을 시작할 수 없습니다.";
  overlay.appendChild(p);
  box.appendChild(overlay);
}

function clearErrors(): void {
  document.querySelectorAll(".error-overlay").forEach(el => el.remove());
}

function clearCompatWarning(): void {
  document.getElementById("player-compat-warning")?.remove();
}

function clearAutoplayPrompt(): void {
  document.getElementById("autoplay-prompt")?.remove();
}

function showAutoplayPrompt(): void {
  if (document.getElementById("autoplay-prompt")) return;
  const box = document.getElementById("video-box");
  const video = document.getElementById("v") as HTMLVideoElement | null;
  if (!box || !video) return;
  const btn = document.createElement("button");
  btn.id = "autoplay-prompt";
  btn.textContent = "▶ 탭하여 재생";
  btn.style.cssText =
    "position:absolute;inset:0;width:100%;height:100%;background:rgba(0,0,0,.55);color:#fff;font-size:20px;border:none;cursor:pointer;z-index:30;";
  btn.addEventListener("click", () => {
    video.play().catch(e => console.debug("Ignored promise rejection:", e));
    btn.remove();
  }, { once: true });
  box.appendChild(btn);
}

function buildUnsupportedBrowserMessage(): string {
  const ua = navigator.userAgent || "";
  const isAndroid = ua.includes("Android");

  if (isAndroid) {
    const match = ua.match(/Android\s(\d+)/);
    const androidVersion = match ? parseInt(match[1], 10) : null;
    let msg = "현재 Android 브라우저는 WebCrypto, MediaSource, 서비스 워커 등 일부 최신 웹 기능을 완전히 지원하지 않아 재생이 원활하지 않을 수 있습니다.";
    if (androidVersion && androidVersion < 8) {
      return msg + " 이 기기에서 설치 가능한 최신 IronFox을 설치하여 VLC 또는 MPV로 감상할 것을 권장합니다.";
    }
    return msg;
  }

  return "현재 브라우저는 WebCrypto, MediaSource 등 재생에 필요한 최신 웹 기능을 충분히 지원하지 않습니다.";
}

function showCompatWarning(msg: string): void {
  if (document.getElementById("player-compat-warning")) return;
  const banner = document.createElement("div");
  banner.id = "player-compat-warning";
  banner.style.cssText = [
    "position:fixed",
    "left:12px",
    "right:12px",
    "bottom:12px",
    "z-index:9500",
    "display:flex",
    "flex-direction:column",
    "gap:10px",
    "padding:14px 16px",
    "border:1px solid #7c3d12",
    "border-radius:12px",
    "background:#18181b",
    "color:#fdba74",
    'font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
    "box-shadow:0 10px 30px rgba(0,0,0,.35)",
  ].join(";");
  const canDownloadFallback = !!globalThis.crypto?.subtle;
  banner.innerHTML = `
<p style="margin:0;">${msg}</p>
<div style="display:flex;gap:8px;flex-wrap:wrap;">
	${canDownloadFallback ? `<button id="player-compat-download" style="padding:7px 14px;border-radius:8px;border:1px solid #e5ff00;background:#e5ff00;color:#000;font:600 13px inherit;cursor:pointer;">다운로드</button>` : ""}
	<button id="player-compat-close" style="padding:7px 14px;border-radius:8px;border:1px solid #3f3f46;background:transparent;color:#d4d4d8;font:13px inherit;cursor:pointer;">닫기</button>
</div>
  `;
  document.body.appendChild(banner);

  (document.getElementById("player-compat-close") as HTMLButtonElement | null)
    ?.addEventListener("click", clearCompatWarning, { once: true });
  (document.getElementById("player-compat-download") as HTMLButtonElement | null)
    ?.addEventListener("click", () => {
      const dlBtn = document.getElementById("btn-download") as HTMLButtonElement | null;
      if (dlBtn && !dlBtn.hidden) dlBtn.click();
    });
}

window.addEventListener("player:compat-warning", ((e: Event) => {
  const detail = (e as CustomEvent<{ message?: string }>).detail;
  showCompatWarning(
    detail?.message ??
      "Firefox에서 재생이 원활하지 않을 수 있습니다. 파일을 다운로드하여 재생하거나 Chrome 기반 브라우저를 이용해 다시 시청하시기를 권장합니다.",
  );
}) as EventListener);

window.addEventListener("player:play-blocked", () => {
  showAutoplayPrompt();
});

async function startPlayer(
  mpdUrl: string,
  kid: string | null,
  key: string | null,
  resumeTime: number | null,
): Promise<void> {
  cleanupPreviousPlayer();
  clearErrors();
  clearCompatWarning();
  clearAutoplayPrompt();

  const video = document.getElementById("v") as HTMLVideoElement | null;
  const qualityPref = parseInt(localStorage.getItem("quality_pref") || "0", 10);
  const qualityPrefBps = parseInt(localStorage.getItem("quality_pref_bps") || "0", 10);

  const MSWithWorker = MS as (typeof MediaSource & { canConstructInDedicatedWorker?: boolean }) | undefined;
  //const workerMseOptIn = localStorage.getItem("player_worker_mse") === "on"; // TODO: FIXME: 이거 항상 false임. player_worker_mse 쓰일 일 없음
  //const canUseWorkerMse = !!(MSWithWorker?.canConstructInDedicatedWorker && workerMseOptIn);
  const canUseWorkerMse = MSWithWorker?.canConstructInDedicatedWorker;

  if (MS === undefined || !globalThis.crypto?.subtle) {
    if (navigator.userAgent.includes("iP") && MS === undefined) {
      return showError("재생이 지원되지 않습니다. Safari로 열어보시겠어요?");
    }
    showError(buildUnsupportedBrowserMessage());
    return showCompatWarning(buildUnsupportedBrowserMessage());
  } else if (canUseWorkerMse) {
    const worker = new Worker("/player.js", { type: "module" });
    window._currentWorker = worker;
    const ac = new AbortController();
    window._workerAc = ac;
    const { signal } = ac;
    let fellBackToMainThread = false;

    function fallbackToMainThread(): void {
      if (fellBackToMainThread) return;
      fellBackToMainThread = true;
      ac.abort();
      worker.terminate();
      const player = new Player(video);
      window._currentPlayer = player;
      player._qualityPref = qualityPref;
      player._qualityPrefBps = qualityPrefBps;
      player.init(mpdUrl, kid ?? "", key ?? "", resumeTime).catch((err: Error) => showError(err.message));
      _dlInit(mpdUrl, player, false);
    }

    worker.addEventListener("error", () => {
      fallbackToMainThread();
    }, { signal });

    worker.addEventListener("message", ({ data }: MessageEvent<Record<string, unknown>>) => {
      switch (data["type"]) {
        case "handle": {
          const handle = data["handle"];
          if (handle == null) {
            console.error("[PLAYER] worker did not provide a MediaSource handle; falling back");
            fallbackToMainThread();
            break;
          }
          (video as HTMLVideoElement).srcObject = handle as MediaProvider;
          break;
        }
        case "play":
          video!.play().catch((e: Error) => {
            console.error("video.play() rejected:", e);
            showAutoplayPrompt();
          });
          break;
        case "setCurrentTime":
          video!.currentTime = data["time"] as number;
          break;
        case "qualityOptions": {
          const sel = document.getElementById("quality-selector") as HTMLSelectElement | null;
          if (!sel) break;
          sel.innerHTML = "";
          for (const opt of data["options"] as Array<{ id: string; label: string }>) {
            const el = document.createElement("option");
            el.value = opt.id;
            el.textContent = opt.label;
            if (opt.id === data["activeId"]) el.selected = true;
            sel.appendChild(el);
          }
          break;
        }
        case "updateActiveQuality": {
          const sel = document.getElementById("quality-selector") as HTMLSelectElement | null;
          if (sel)
            for (const o of sel.options)
              o.selected = o.value === data["repId"];
          break;
        }
        case "error":
          showError(data["message"] as string);
          break;
        case "compatWarning":
          showCompatWarning(data["message"] as string);
          break;
        default:
          _dlHandleMsg(data);
      }
    }, { signal });

    video!.addEventListener("timeupdate", () => {
      worker.postMessage({
        type: "timeupdate",
        currentTime: video!.currentTime,
        readyState: video!.readyState,
        videoWidth: video!.videoWidth,
        videoHeight: video!.videoHeight,
      });
    }, { signal });

    video!.addEventListener("playing", () => {
      worker.postMessage({ type: "playing" });
      clearAutoplayPrompt();
    }, { signal });

    video!.addEventListener("seeking", () => {
      worker.postMessage({ type: "seeking", currentTime: video!.currentTime });
    }, { signal });

    video!.addEventListener("error", () => {
      worker.postMessage({ type: "videoError", code: video!.error?.code });
    }, { signal });

    document.getElementById("quality-selector")!.addEventListener("change", (e) => {
      const sel = e.target as HTMLSelectElement;
      if (sel.value) worker.postMessage({ type: "setQuality", repId: sel.value });
    }, { signal });

    worker.postMessage({
      type: "init",
      mpdUrl,
      kid,
      key,
      resumeTime,
      qualityPref: String(qualityPref || ""),
      qualityPrefBps: String(qualityPrefBps || ""),
    });
    _dlInit(mpdUrl, worker, true);
  } else {
    if (canUseWorkerMse) {
      console.log("[PLAYER] Dedicated worker MSE disabled; using main-thread player");
    }
    const player = new Player(video);
    window._currentPlayer = player;
    player._qualityPref = qualityPref;
    player._qualityPrefBps = qualityPrefBps;
    player.init(mpdUrl, kid ?? "", key ?? "", resumeTime).catch((err: Error) => showError(err.message));
    _dlInit(mpdUrl, player, false);
    video?.addEventListener("playing", clearAutoplayPrompt, { once: true });
  }
}

let lastHandledHash = "";
async function handleRoute() {
  if (location.hash === lastHandledHash) return;
  lastHandledHash = location.hash;
  console.log("[ROUTE] Handling route:", location.hash);
  const params = new URLSearchParams(location.hash.slice(1));
  const epId = params.get("epId");
  const mpdParam = params.get("mpd");
  const kidParam = params.get("kid");
  const keyParam = params.get("key");
  const tParam = params.get("t");
  const resumeTime =
    tParam !== null && Number.isFinite(parseFloat(tParam))
      ? parseFloat(tParam)
      : null;

  if (mpdParam) {
    const mpdUrl = rewriteCDN(mpdParam);
    await startPlayer(mpdUrl, kidParam, keyParam, resumeTime);
    if (epId) {
      apiFetch<{ running_time?: string }>(`/api/episodes/v3/${epId}`)
        .then((ep: any) => {
          if (!ep?.running_time) return;
          const parts = ep.running_time.split(":");
          if (parts.length === 3) {
            window._dlDurSecs = +parts[0] * 3600 + +parts[1] * 60 + parseFloat(parts[2]);
          }
        })
        .catch((e: any) => console.debug("Ignored promise rejection:", e));
    }
  } else if (epId) {
    try {
      const [info, ep] = await Promise.all([
        apiFetch<any>(`/api/episodes/v3/${epId}/video`),
        apiFetch<any>(`/api/episodes/v3/${epId}`),
      ]);
        if (!info?.dash_url) return;
        const mpdUrl = rewriteCDN(info.dash_url);
        const kid = info.keys?.[0]?.key_id ?? "";
        const key = info.keys?.[0]?.key ?? "";
        const p = new URLSearchParams(location.hash.slice(1));
      p.set("mpd", info.dash_url);
      if (kid) p.set("kid", kid);
      if (key) p.set("key", key);
      history.replaceState(null, "", "#" + p.toString());

        if (ep?.running_time) {
          const parts = ep.running_time.split(":");
          if (parts.length === 3) {
            window._dlDurSecs = +parts[0] * 3600 + +parts[1] * 60 + parseFloat(parts[2]);
          }
        }
        await startPlayer(mpdUrl, kid, key, resumeTime);
      } catch (e) {
        console.error("[ROUTE] Failed to fetch episode info:", e);
      }
  }
}

window.addEventListener("hashchange", () => {
  console.log("[ROUTE] hashchange detected, re-routing");
  handleRoute();
});

handleRoute();
