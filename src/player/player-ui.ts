import { WatchHistory, updateEpisodeHistoryMeta } from "../watch-history";
import { rewriteCdnUrl } from "../shared/cdn";

declare global {
  interface Window {
    Telemetry: { openInfo: () => void; optout: () => void; getConsent: () => string | null };
    ShareLink: {
      copy: (
        text: string,
        btn: HTMLElement | null,
        opts?: { successText?: string; resetText?: string; delay?: number },
      ) => Promise<void>;
      buildUrl: (extra?: Record<string, string | null | undefined>) => string;
      highlight: (el: Element | null) => void;
    };
    rewriteCDN: (url: string) => string;
  }
}

function rewriteCDN(url: string): string {
  return rewriteCdnUrl(url);
}
window.rewriteCDN = rewriteCDN;

// ── Share sheet ──────────────────────────────────────────────────────────────
const ShareSheet = (() => {
  const overlay = document.getElementById("share-overlay")!;
  const sheet = document.getElementById("share-sheet")!;
  const timeRow = document.getElementById("share-time-row")!;
  const timeToggle = document.getElementById("share-time-toggle") as HTMLInputElement;
  const rowsEl = document.getElementById("share-rows")!;

  let _epId: string | null = null,
    _itemId: string | null = null,
    _epTitle = "",
    _getTime: (() => number) | null = null;

  function open({ epId, itemId, epTitle, getTime }: {
    epId: string | null;
    itemId: string | null;
    epTitle?: string;
    getTime?: (() => number) | null;
  }): void {
    _epId = epId;
    _itemId = itemId;
    _epTitle = epTitle ?? "";
    _getTime = getTime ?? null;

    timeToggle.checked = true;
    render();
    timeToggle.onchange = render;

    overlay.classList.add("open");
    sheet.classList.add("open");
    sheet.setAttribute("aria-hidden", "false");
  }

  function close(): void {
    overlay.classList.remove("open");
    sheet.classList.remove("open");
    sheet.setAttribute("aria-hidden", "true");
  }

  function buildUrls(): Array<{ label: string; url: string; withTime?: boolean }> {
    const base = location.origin;
    const useLaftel = localStorage.getItem("share_laftel_url") === "yes";
    const laftelBase = "https://laftel.net";
    const urls: Array<{ label: string; url: string; withTime?: boolean }> = [];

    if (_epId) {
      let epUrl: string;
      if (useLaftel && _itemId) {
        epUrl = `${laftelBase}/player/${_itemId}/${_epId}`;
      } else {
        epUrl = `${base}/player/${_epId}`;
        if (timeToggle.checked && _getTime) {
          const t = Math.floor(_getTime());
          if (t > 1) epUrl += `?t=${t}`;
        }
      }
      urls.push({
        label: "에피소드 공유",
        url: epUrl,
        withTime: !useLaftel && timeToggle.checked,
      });
    }

    if (_itemId) {
      urls.push({
        label: "작품 페이지 공유",
        url: useLaftel ? `${laftelBase}/item/${_itemId}` : `${base}/item/${_itemId}`,
      });
    }

    return urls;
  }

  function fmtTime(s: number): string {
    s = Math.floor(s);
    const h = Math.floor(s / 3600),
      m = Math.floor((s % 3600) / 60),
      sec = s % 60;
    return h
      ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
      : `${m}:${String(sec).padStart(2, "0")}`;
  }

  function render(): void {
    const useLaftel = localStorage.getItem("share_laftel_url") === "yes";
    timeRow.style.display = _epId && !useLaftel ? "" : "none";
    rowsEl.innerHTML = "";
    const urls = buildUrls();

    for (const item of urls) {
      const row = document.createElement("div");
      row.className = "share-row";

      const displayUrl = item.url.replace(
        location.origin,
        "",
      );
      const timeHint =
        item.withTime && _getTime
          ? ` (${fmtTime(_getTime())}부터)`
          : "";

      row.innerHTML = `
<div class="share-row-left">
	<span class="share-row-label">${esc(item.label)}${esc(timeHint)}</span>
	<span class="share-row-url">${esc(displayUrl)}</span>
</div>
<div class="share-btns">
	${typeof navigator.share === "function" ? `<button class="share-btn" data-action="native" data-url="${esc(item.url)}" data-label="${esc(item.label)}">공유</button>` : ""}
	<button class="share-btn primary" data-action="copy" data-url="${esc(item.url)}">복사</button>
</div>`;
      rowsEl.appendChild(row);
    }
  }

  async function copyToClipboard(text: string, btn: HTMLElement): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = "✓ 복사됨";
      btn.classList.add("copied");
      setTimeout(() => {
        btn.textContent = "복사";
        btn.classList.remove("copied");
      }, 2000);
    } catch (_e) {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;top:-9999px";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
      btn.textContent = "✓ 복사됨";
      btn.classList.add("copied");
      setTimeout(() => {
        btn.textContent = "복사";
        btn.classList.remove("copied");
      }, 2000);
    }
  }

  rowsEl.addEventListener("click", async (e) => {
    const btn = (e.target as Element).closest("[data-action]") as HTMLElement | null;
    if (!btn) return;
    const url = (btn as HTMLElement & { dataset: DOMStringMap }).dataset["url"]!;
    const label = (btn as HTMLElement & { dataset: DOMStringMap }).dataset["label"] ?? "";

    if (btn.dataset["action"] === "copy") {
      await copyToClipboard(url, btn);
    } else if (btn.dataset["action"] === "native") {
      try {
        await navigator.share({
          title: label || _epTitle,
          url,
        });
      } catch (err) {
        if ((err as Error).name !== "AbortError")
          console.warn("share:", err);
      }
    }
  });

  overlay.addEventListener("click", close);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && sheet.classList.contains("open")) close();
  });

  let touchStartY = 0;
  sheet.addEventListener(
    "touchstart",
    (e) => {
      touchStartY = e.touches[0].clientY;
    },
    { passive: true },
  );
  sheet.addEventListener(
    "touchend",
    (e) => {
      if (e.changedTouches[0].clientY - touchStartY > 60)
        close();
    },
    { passive: true },
  );

  return { open, close };
})();

// ── Options ───────────────────────────────────────────────────────────────────
let autoSkip = localStorage.getItem("player_autoskip") === "on";
let autoPlay = localStorage.getItem("player_autoplay") !== "off";
const btnAutoSkip = document.getElementById("btn-autoskip") as HTMLButtonElement;
const btnAutoPlay = document.getElementById("btn-autoplay") as HTMLButtonElement;
function syncOptBtns(): void {
  btnAutoSkip.classList.toggle("on", autoSkip);
  btnAutoSkip.textContent = autoSkip ? "켜짐" : "꺼짐";
  btnAutoSkip.setAttribute("aria-pressed", String(autoSkip));
  btnAutoPlay.classList.toggle("on", autoPlay);
  btnAutoPlay.textContent = autoPlay ? "켜짐" : "꺼짐";
  btnAutoPlay.setAttribute("aria-pressed", String(autoPlay));
}
syncOptBtns();
btnAutoSkip.addEventListener("click", () => {
  autoSkip = !autoSkip;
  localStorage.setItem(
    "player_autoskip",
    autoSkip ? "on" : "off",
  );
  syncOptBtns();
});
btnAutoPlay.addEventListener("click", () => {
  autoPlay = !autoPlay;
  localStorage.setItem(
    "player_autoplay",
    autoPlay ? "on" : "off",
  );
  syncOptBtns();
});

// ── Speed control ─────────────────────────────────────────────────────────────
{
  const btnDown = document.getElementById("btn-speed-down") as HTMLButtonElement | null;
  const btnUp   = document.getElementById("btn-speed-up")   as HTMLButtonElement | null;
  const btnVal  = document.getElementById("btn-speed-val")  as HTMLButtonElement | null;
  const MIN = 0.125, MAX = 8;

  let curSpeed = parseFloat(localStorage.getItem("player_speed") || "1") || 1;

  // Customizable via localStorage — not exposed in settings UI
  const getMul    = () => parseFloat(localStorage.getItem("player_speed_step_mul") || "1.1") || 1.1;
  const getBigMul = () => parseFloat(localStorage.getItem("player_speed_big_mul") || "2")   || 2;
  const getPresets = (): number[] => {
    const raw = localStorage.getItem("player_speed_presets");
    if (raw) { const p = raw.split(",").map(Number).filter(n => n > 0); if (p.length) return p; }
    return [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
  };

  const fmtSpeed = (v: number) => {
    const s = v === 1 ? "1" : v < 10 ? v.toPrecision(3).replace(/\.?0+$/, "") : String(Math.round(v));
    return s + "x";
  };
  const UNSAFE_TITLE = "브라우저에 따라 실제 재생 속도가 다를 수 있습니다";
  const applySpeed = (v: number, silent = false) => {
    v = Math.max(MIN, Math.min(MAX, v));
    const prev = curSpeed;
    curSpeed = v;
    const video = document.getElementById("v") as HTMLVideoElement | null;
    if (video) video.playbackRate = v;
    const unsafe = v < 0.5 || v > 2;
    if (btnVal) {
      btnVal.textContent = fmtSpeed(v);
      btnVal.style.color = unsafe ? "#f97316" : "";
      btnVal.title = unsafe ? UNSAFE_TITLE : "";
    }
    localStorage.setItem("player_speed", String(v));
    if (!silent) showSpeedToast(prev, v);
  };
  applySpeed(curSpeed, true);
  (document.getElementById("v") as HTMLVideoElement | null)?.addEventListener("ratechange", () => {
    const v = document.getElementById("v") as HTMLVideoElement | null;
    if (!v) return;
    if (v.playbackRate !== curSpeed) applySpeed(v.playbackRate, true);
  });
  (document.getElementById("v") as HTMLVideoElement | null)?.addEventListener("playing", () => {
    const v = document.getElementById("v") as HTMLVideoElement | null;
    if (v && v.playbackRate !== curSpeed) v.playbackRate = curSpeed;
  });

  btnDown?.addEventListener("click", () => applySpeed(Math.round((curSpeed - 0.05) * 100) / 100));
  btnUp?.addEventListener("click",   () => applySpeed(Math.round((curSpeed + 0.05) * 100) / 100));
  btnVal?.addEventListener("click",  () => applySpeed(1));

  document.addEventListener("keydown", (e) => {
    if ((e.target as Element).matches("input, textarea, [contenteditable]")) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    switch (e.key) {
      case "]": applySpeed(curSpeed * getMul()); break;
      case "[": applySpeed(curSpeed / getMul()); break;
      case "}": applySpeed(curSpeed * getBigMul()); break;
      case "{": applySpeed(curSpeed / getBigMul()); break;
      case ">": { const p = getPresets(); const i = p.findIndex(v => v > curSpeed + 0.01); applySpeed(i >= 0 ? p[i] : p[p.length - 1]); break; }
      case "<": { const p = getPresets(); const i = [...p].reverse().findIndex(v => v < curSpeed - 0.01); applySpeed(i >= 0 ? p[p.length - 1 - i] : p[0]); break; }
      case "Backspace": if (localStorage.getItem("player_speed_bs_reset") !== "off") applySpeed(1); break;
    }
  });
}

const btnSettings = document.getElementById("btn-settings") as HTMLButtonElement;
const settingsPanel = document.getElementById("settings-panel")!;
function setSettingsPanelOpen(open: boolean): void {
  settingsPanel.classList.toggle("open", open);
  settingsPanel.setAttribute("aria-hidden", String(!open));
  btnSettings.setAttribute("aria-expanded", String(open));
}
btnSettings.addEventListener("click", (e) => {
  e.stopPropagation();
  setSettingsPanelOpen(!settingsPanel.classList.contains("open"));
});
document.addEventListener("click", () =>
  setSettingsPanelOpen(false),
);
settingsPanel.addEventListener("click", (e) => e.stopPropagation());

// ── Episode info ──────────────────────────────────────────────────────────────
const params = new URLSearchParams(location.hash.slice(1));
let epId = params.get("epId");
const itemId = params.get("itemId");

let _currentEpTitle = "";
let _currentEpHistoryLabel = "";
let _currentItemId: string | null = itemId ?? null;

function formatEpisodeHistoryLabel(title: string, episodeNum: unknown): string {
  const trimmedTitle = String(title ?? "").trim();
  const trimmedNum = String(episodeNum ?? "").trim();
  if (trimmedNum && trimmedTitle) return `${trimmedNum}화 ${trimmedTitle}`;
  if (trimmedTitle) return trimmedTitle;
  if (trimmedNum) return `${trimmedNum}화`;
  return "";
}

function updateItemBtn(id: string): void {
  const btn = document.getElementById("btn-item") as HTMLAnchorElement | null;
  if (!btn || !id) return;
  btn.href = `/item.html#id=${id}`;
  btn.style.display = "";
}
if (_currentItemId) updateItemBtn(_currentItemId);

async function initUIForEpisode(id: string): Promise<void> {
  if (!id) return;
  try {
    const ep = await apiFetch<Record<string, unknown>>(`/api/episodes/v3/${id}`);
    const t = (ep["subject"] ?? ep["title"] ?? "") as string;
    const episodeNum = String(ep["episode_num"] ?? "").trim();
    _currentEpTitle = t;
    _currentEpHistoryLabel = formatEpisodeHistoryLabel(t, episodeNum);
    const titleEl = document.getElementById("ep-title") as HTMLElement | null;
    if (titleEl) titleEl.textContent = t;
    document.title = t;

    if (!_currentItemId && ep["item_id"]) {
      _currentItemId = String(ep["item_id"]);
      updateItemBtn(_currentItemId);
    }

    if (_currentItemId) {
      WatchHistory.saveEpisode(_currentItemId, id, {
        episodeTitle: t || undefined,
        episodeNum: episodeNum || undefined,
      });
      try {
        const item = await apiFetch<Record<string, unknown>>(`/api/items/v4/${_currentItemId}`);
        const images = Array.isArray(item["images"]) ? item["images"] as Array<Record<string, unknown>> : [];
        const thumbPath =
          String(images.find((image) => image["option_name"] === "home_default")?.["img_url"] ?? "") ||
          String(images[0]?.["img_url"] ?? "") ||
          undefined;
        WatchHistory.saveItem(_currentItemId, {
          itemName: String(item["name"] ?? "").trim() || undefined,
          itemThumbPath: thumbPath,
          itemMedium: String(item["medium"] ?? "").trim() || undefined,
          lastEpisodeId: id,
        });
      } catch (itemErr) {
        console.error("item info fetch:", itemErr);
      }
    } else {
      updateEpisodeHistoryMeta(id, {
        episodeTitle: t || undefined,
        episodeNum: episodeNum || undefined,
      });
    }
  } catch (e) {
    console.error("ep info fetch:", e);
  }

  try {
    const info = await apiFetch<Record<string, unknown>>(
      `/api/episodes/v3/${id}/video`,
    );
    setupMarkers(info["markers"] as MarkerData | null | undefined);
  } catch (e) {
    console.error("markers fetch:", e);
  }

  setupAutoplay(id);
  setupProgressSave();
  setupMediaSession();
  loadComments(id);
  setupShareButton();
}

window.addEventListener("hashchange", () => {
  const newParams = new URLSearchParams(location.hash.slice(1));
  const newEpId = newParams.get("epId");
  if (newEpId && newEpId !== epId) {
    console.log("[UI] Episode changed, refreshing UI for:", newEpId);
    epId = newEpId;
    initUIForEpisode(newEpId);
  }
});

if (epId) initUIForEpisode(epId);

// ── Speed toast ───────────────────────────────────────────────────────────────
let _speedToastTimer: ReturnType<typeof setTimeout> | null = null;
function showSpeedToast(prev: number, next: number): void {
  const box = document.getElementById("video-box");
  if (!box) return;
  let toast = document.getElementById("speed-toast") as HTMLDivElement | null;
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "speed-toast";
    toast.style.cssText = [
      "position:absolute", "top:50%", "left:50%",
      "transform:translate(-50%,-50%)",
      "z-index:30", "pointer-events:none",
      "display:flex", "flex-direction:column", "align-items:center", "gap:4px",
      "background:rgba(0,0,0,.55)", "border-radius:10px",
      "padding:10px 18px",
      'font:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
      "color:#fff", "text-align:center",
      "transition:opacity .15s",
    ].join(";");
    box.appendChild(toast);
  }
  const fmtSpeed = (v: number) => v === 1 ? "1x" : v.toPrecision(3).replace(/\.?0+$/, "") + "x";
  const arrow = next > prev ? "▶▶" : next < prev ? "◀◀" : "";
  const unsafe = next < 0.5 || next > 2;
  const valColor = unsafe ? "#f97316" : "#fff";
  toast.innerHTML = arrow
    ? `<span style="font-size:13px;letter-spacing:.1em;color:#ccc;">${arrow}</span>` +
      `<span style="font-size:22px;font-weight:700;line-height:1.1;color:${valColor};">${fmtSpeed(next)}</span>`
    : `<span style="font-size:22px;font-weight:700;line-height:1.1;color:${valColor};">${fmtSpeed(next)}</span>`;
  toast.style.opacity = "1";
  if (_speedToastTimer) clearTimeout(_speedToastTimer);
  _speedToastTimer = setTimeout(() => {
    if (toast) toast.style.opacity = "0";
  }, 800);
}

// ── Keyboard shortcuts ────────────────────────────────────────────────────────
document.addEventListener("keydown", (e) => {
  if ((e.target as Element).matches("input, textarea, [contenteditable]")) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === " ") {
    const v = document.getElementById("v") as HTMLVideoElement | null;
    if (!v) return;
    e.preventDefault();
    if (v.paused) v.play().catch(() => {});
    else v.pause();
    return;
  }
  if (e.key === "f" || e.key === "F") {
    const v = document.getElementById("v");
    if (!v) return;
    if (document.fullscreenElement) {
      document.exitFullscreen?.();
    } else {
      v.requestFullscreen?.();
    }
  }
});

// ── Media Session ─────────────────────────────────────────────────────────────
function setupMediaSession(): void {
  if (!("mediaSession" in navigator)) return;
  const video = document.getElementById("v") as HTMLVideoElement;
  const ms = navigator.mediaSession;

  function syncMetadata(): void {
    try {
      ms.metadata = new MediaMetadata({ title: _currentEpTitle || document.title });
    } catch (e) { console.debug("Ignored error:", e); }
  }
  syncMetadata();
  const titleEl = document.getElementById("ep-title");
  if (titleEl) new MutationObserver(syncMetadata).observe(titleEl, { childList: true });

  function syncPlaybackState(): void {
    try { ms.playbackState = video.paused ? "paused" : "playing"; } catch (e) { console.debug("Ignored error:", e); }
  }
  video.addEventListener("play", syncPlaybackState);
  video.addEventListener("pause", syncPlaybackState);
  syncPlaybackState();

  function syncPositionState(): void {
    try {
      const dur = video.duration;
      if (!dur || !isFinite(dur)) return;
      ms.setPositionState({
        duration:     dur,
        playbackRate: video.playbackRate || 1,
        position:     Math.min(video.currentTime, dur),
      });
    } catch (e) { console.debug("Ignored error:", e); }
  }
  let _posTimer: ReturnType<typeof setTimeout> | 0 = 0;
  video.addEventListener("timeupdate", () => {
    if (_posTimer) return;
    _posTimer = setTimeout(() => { _posTimer = 0; syncPositionState(); }, 1000);
  });
  video.addEventListener("loadedmetadata", syncPositionState);
  video.addEventListener("seeked",         syncPositionState);
  video.addEventListener("ratechange",     syncPositionState);

  function safeSeek(t: number): void {
    try {
      const dur = video.duration;
      if (!dur || !isFinite(dur)) return;
      video.currentTime = Math.max(0, Math.min(t, dur));
    } catch (e) { console.debug("Ignored error:", e); }
  }

  const videoWithFastSeek = video as HTMLVideoElement & { fastSeek?: (t: number) => void };

  const handlers: Record<string, (details?: MediaSessionActionDetails | null) => void> = {
    play:         () => { try { video.play().catch(() => {}); } catch (e) { console.debug("Ignored error:", e); } },
    pause:        () => { try { video.pause(); } catch (e) { console.debug("Ignored error:", e); } },
    seekforward:  (details) => safeSeek(video.currentTime + (details?.seekOffset ?? 10)),
    seekbackward: (details) => safeSeek(video.currentTime - (details?.seekOffset ?? 10)),
    seekto:       (details) => {
      if (details?.seekTime == null) return;
      if (details.fastSeek && videoWithFastSeek.fastSeek) {
        try { videoWithFastSeek.fastSeek(details.seekTime); } catch (_) { safeSeek(details.seekTime); }
      } else {
        safeSeek(details.seekTime);
      }
    },
  };

  for (const [action, handler] of Object.entries(handlers)) {
    try { ms.setActionHandler(action as MediaSessionAction, handler); } catch (e) { console.debug("Ignored error:", e); }
  }
}

// ── Progress save ─────────────────────────────────────────────────────────────
function setupProgressSave(): void {
  const video = document.getElementById("v") as HTMLVideoElement;
  let lastSaved = 0;

  function save(): void {
    const t = video.currentTime;
    if (!t || t < 1) return;
    WatchHistory.saveProgress(
      epId!,
      t,
      video.duration,
      _currentItemId,
      _currentEpHistoryLabel || _currentEpTitle,
    );
  }

  video.addEventListener("timeupdate", () => {
    const now = Date.now();
    if (now - lastSaved < 5000) return;
    lastSaved = now;
    save();
  });
  video.addEventListener("pause", save);
  video.addEventListener("ended", save);
  window.addEventListener("beforeunload", save);
}

// ── Share button ──────────────────────────────────────────────────────────────
function setupShareButton(): void {
  const video = document.getElementById("v") as HTMLVideoElement;
  document
    .getElementById("btn-share")!
    .addEventListener("click", () => {
      ShareSheet.open({
        epId,
        itemId: _currentItemId,
        epTitle: _currentEpTitle,
        getTime: () => video.currentTime,
      });
    });
}

// ── Markers ───────────────────────────────────────────────────────────────────
interface MarkerData {
  opening?: { start: number; end: number };
  ending?: { start: number; end: number };
}

function setupMarkers(markers: MarkerData | null | undefined): void {
  if (!markers) return;

  const video = document.getElementById("v") as HTMLVideoElement;
  const btnOpen = document.getElementById("skip-opening") as HTMLButtonElement;
  const btnEnd = document.getElementById("skip-ending") as HTMLButtonElement;

  type SkipPlayer = { skipRanges: Array<{ start: number; end: number }> } | null | undefined;
  const p = (window as Window & { _currentPlayer?: SkipPlayer })._currentPlayer;
  if (p) {
    p.skipRanges = [
      ...(markers.opening ? [markers.opening] : []),
      ...(markers.ending ? [markers.ending] : []),
    ];
  }

  // Don't seek to video.duration — causes MEDIA_ERR_DECODE on some browsers.
  function skipTo(time: number): void {
    const dur = video.duration;
    if (isFinite(dur) && time >= dur - 0.07) return;
    video.currentTime = time;
  }

  function renderTimelineMarkers(): void {
    const dur = video.duration;
    if (!dur || !isFinite(dur)) return;
    document
      .querySelectorAll(".tl-marker")
      .forEach((el) => el.remove());
    for (const [type, seg] of [
      ["opening", markers!.opening],
      ["ending", markers!.ending],
    ] as Array<[string, { start: number; end: number } | undefined]>) {
      if (!seg) continue;
      const el = document.createElement("div");
      el.className = `tl-marker ${type}`;
      el.style.left = (seg.start / dur) * 100 + "%";
      el.style.width =
        ((seg.end - seg.start) / dur) * 100 + "%";
      document
        .getElementById("timeline-track")!
        .appendChild(el);
    }
  }
  if (video.readyState >= 1 && isFinite(video.duration))
    renderTimelineMarkers();
  else
    video.addEventListener(
      "loadedmetadata",
      renderTimelineMarkers,
      { once: true },
    );

  video.addEventListener("timeupdate", () => {
    const t = video.currentTime;
    if (markers!.opening) {
      const { start, end } = markers!.opening;
      const inSeg = t >= start && t < end;
      btnOpen.classList.toggle("visible", inSeg);
      if (inSeg && autoSkip) skipTo(end);
    }
    if (markers!.ending) {
      const { start, end } = markers!.ending;
      const inSeg = t >= start && t < end;
      const endingWindow = parseFloat(localStorage.getItem("player_ending_skip_window") ?? "10");
      const inWindow = endingWindow < 0 || (endingWindow > 0 && t - start < endingWindow);
      btnEnd.classList.toggle("visible", inSeg && inWindow);
      if (inSeg && autoSkip) skipTo(end);
    }
  });
  btnOpen.onclick = () => {
    if (markers!.opening) skipTo(markers!.opening.end);
  };
  btnEnd.onclick = () => {
    if (markers!.ending) skipTo(markers!.ending.end);
  };
}

// ── Timeline bar ──────────────────────────────────────────────────────────────
(function setupTimeline() {
  const video = document.getElementById("v") as HTMLVideoElement;
  const bar = document.getElementById("timeline-bar")!;
  const progress = document.getElementById("timeline-progress") as HTMLElement;

  video.addEventListener("timeupdate", () => {
    const dur = video.duration;
    if (!dur || !isFinite(dur)) return;
    progress.style.width =
      (video.currentTime / dur) * 100 + "%";
  });

  function seekFromEvent(e: { clientX: number }): void {
    const dur = video.duration;
    if (!dur || !isFinite(dur)) return;
    const rect = bar.getBoundingClientRect();
    const ratio = Math.max(
      0,
      Math.min(1, (e.clientX - rect.left) / rect.width),
    );
    const wasPlaying = !video.paused;
    video.currentTime = ratio * dur;
    if (ratio * dur < 1) {
      saveHash(0);
      WatchHistory.clearProgress(epId!);
    }
    if (wasPlaying) video.play().catch(() => {});
  }

  let dragging = false;
  bar.addEventListener("mousedown", (e) => {
    dragging = true;
    seekFromEvent(e);
  });
  bar.addEventListener(
    "touchstart",
    (e) => {
      seekFromEvent(e.touches[0]);
    },
    { passive: true },
  );
  window.addEventListener("mousemove", (e) => {
    if (dragging) seekFromEvent(e);
  });
  window.addEventListener("mouseup", () => {
    dragging = false;
  });
})();

// ── Time sync (hash) ──────────────────────────────────────────────────────────
(function setupTimeSync() {
  const video = document.getElementById("v") as HTMLVideoElement;
  const _tParam = params.get("t");
  const startT =
    _tParam !== null
      ? parseFloat(_tParam)
      : (WatchHistory.getProgress(epId!)?.t ?? 0);
  if (startT > 0 && _tParam === null) {
    const p = new URLSearchParams(location.hash.slice(1));
    p.set("t", Math.floor(startT).toString());
    history.replaceState(null, "", "#" + p.toString());
  }

  function saveHash(ct: number): void {
    const p = new URLSearchParams(location.hash.slice(1));
    if (!ct || ct < 1) {
      p.delete("t");
    } else {
      p.set("t", Math.floor(ct).toString());
    }
    history.replaceState(null, "", "#" + p.toString());
  }
  let lastSaved = 0;
  video.addEventListener("timeupdate", () => {
    const now = Date.now();
    if (now - lastSaved < 10000) return;
    lastSaved = now;
    saveHash(video.currentTime);
  });
  video.addEventListener("pause", () => {
    lastSaved = Date.now();
    saveHash(video.currentTime);
  });
})();

function saveHash(ct: number): void {
  const p = new URLSearchParams(location.hash.slice(1));
  if (!ct || ct < 1) {
    p.delete("t");
  } else {
    p.set("t", Math.floor(ct).toString());
  }
  history.replaceState(null, "", "#" + p.toString());
}

// ── Build episode URL ─────────────────────────────────────────────────────────
async function buildEpUrl(id: string | number): Promise<string | null> {
  try {
    const info = await apiFetch<{ dash_url?: string; keys?: Array<{ key_id?: string; key?: string }> }>(`/api/episodes/v3/${id}/video`);
    if (!info.dash_url) return null;
    const localDash = rewriteCDN(info.dash_url);
    const key = info.keys?.[0] ?? {};
    let url = `player.html#epId=${id}&mpd=${encodeURIComponent(localDash)}&kid=${key.key_id ?? ""}&key=${key.key ?? ""}`;
    if (_currentItemId) url += `&itemId=${_currentItemId}`;
    return url;
  } catch (_) {
    return null;
  }
}

// ── Autoplay / episode navigation ─────────────────────────────────────────────
interface EpListItem {
  id: number;
  episode_num?: string;
  episode_order?: number;
  subject?: string;
  title?: string;
}

function setupAutoplay(epId: string): void {
  autoplayUiAc?.abort();
  autoplayUiAc = new AbortController();
  const signal = autoplayUiAc.signal;

  const video = document.getElementById("v") as HTMLVideoElement & {
    webkitPresentationMode?: string;
    _prevWebkitMode?: string;
  };
  const btnPrev = document.getElementById("btn-prev-ep") as HTMLButtonElement;
  const btnNext = document.getElementById("btn-next-ep") as HTMLButtonElement;
  const btnList = document.getElementById("btn-ep-list") as HTMLButtonElement;
  const panel = document.getElementById("ep-list-panel")!;

  let epList: EpListItem[] = [],
    currentIdx = -1;

  function showToast(msg: string): void {
    const t = document.createElement("div");
    t.textContent = msg;
    t.style.cssText =
      "position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,.8);color:#fff;padding:8px 16px;border-radius:8px;font-size:13px;z-index:200;pointer-events:none;transition:opacity .3s";
    document.body.appendChild(t);
    setTimeout(() => {
      t.style.opacity = "0";
      setTimeout(() => t.remove(), 300);
    }, 2000);
  }

  async function navigate(id: string | number): Promise<void> {
    const url = await buildEpUrl(id).catch((e: Error) => {
      console.error("buildEpUrl:", e);
      return null;
    });
    if (url) {
      location.href = url;
      location.reload();
    } else showToast("재생 불가 (영상 파일이 없습니다)");
  }

  async function loadEpList(): Promise<void> {
    try {
      const data = await apiFetch<{ results?: EpListItem[]; item_id?: string | number }>(
        `/api/episode/${epId}/episodes`,
      );
      epList = (data.results ?? []).slice();
      currentIdx = epList.findIndex(
        (ep) => String(ep.id) === String(epId),
      );

      if (!_currentItemId && data.item_id) {
        _currentItemId = String(data.item_id);
        updateItemBtn(_currentItemId);
      }

      btnPrev.disabled = currentIdx <= 0;
      btnNext.disabled =
        currentIdx < 0 || currentIdx + 1 >= epList.length;
      panel.innerHTML = "";
      epList.forEach((ep, i) => {
        const btn = document.createElement("button");
        btn.className =
          "ep-item" +
          (i === currentIdx ? " current" : "");
        btn.textContent = episodeLabel(ep, i);
        btn.title = btn.textContent;
        if (i === currentIdx) btn.setAttribute("aria-current", "page");
        btn.addEventListener("click", () => {
          closePanel();
          navigate(ep.id);
        }, { signal });
        panel.appendChild(btn);
      });
      panel
        .querySelector(".ep-item.current")
        ?.scrollIntoView({ block: "nearest" });
    } catch (e) {
      console.error("loadEpList:", e);
    }
  }

  function episodeLabel(ep: EpListItem, index: number): string {
    const rawNum = String(ep.episode_num ?? "").trim();
    const title = String(ep.subject ?? ep.title ?? "").trim();
    const num = rawNum || String(index + 1);
    const prefix = /화\s*$/.test(num) ? num : `${num}화`;
    return title ? `${prefix} ${title}` : prefix;
  }

  const closePanel = () => {
    panel.classList.remove("open");
    btnList.classList.remove("on");
    panel.setAttribute("aria-hidden", "true");
    btnList.setAttribute("aria-expanded", "false");
  };
  btnList.addEventListener("click", (e) => {
    e.stopPropagation();
    const isOpen = panel.classList.toggle("open");
    btnList.classList.toggle("on", isOpen);
    panel.setAttribute("aria-hidden", String(!isOpen));
    btnList.setAttribute("aria-expanded", String(isOpen));
    if (isOpen && epList.length === 0) loadEpList();
  }, { signal });
  document.addEventListener("click", closePanel, { signal });
  panel.addEventListener("click", (e) => e.stopPropagation(), { signal });

  btnPrev.addEventListener("click", () => {
    if (currentIdx > 0) navigate(epList[currentIdx - 1].id);
  }, { signal });
  btnNext.addEventListener("click", () => {
    if (currentIdx >= 0 && currentIdx + 1 < epList.length)
      navigate(epList[currentIdx + 1].id);
  }, { signal });

  let autoplayTriggered = false;
  let pendingPiPAutoNext = false;
  video._prevWebkitMode = video.webkitPresentationMode ?? "inline";

  async function tryAutoplayNext(trigger: string): Promise<void> {
    if (!autoPlay || autoplayTriggered) return;
    console.log(`[PLAYER] tryAutoplayNext triggered by: ${trigger}`);
    const inPiP =
      document.pictureInPictureElement === video ||
      video.webkitPresentationMode === "picture-in-picture";
    if (inPiP) {
      console.log("[PLAYER] Autoplay deferred (PiP active)");
      return;
    }
    if (currentIdx < 0 || currentIdx + 1 >= epList.length) {
      if (epList.length === 0) await loadEpList();
      if (currentIdx < 0 || currentIdx + 1 >= epList.length)
        return;
    }
    autoplayTriggered = true;
    pendingPiPAutoNext = false;
    const url = await buildEpUrl(
      epList[currentIdx + 1].id,
    ).catch((e: Error) => {
      console.error("buildEpUrl (autoplay):", e);
      return null;
    });
    if (url) {
      console.log("[PLAYER] Navigating to next episode:", url);
      const hashIdx = url.indexOf("#");
      if (hashIdx !== -1) {
        const newHash = url.substring(hashIdx + 1);
        if (location.hash !== "#" + newHash) {
          location.hash = newHash;
        } else {
          // If hash is same, manually trigger route logic
          console.log("[PLAYER] Hash identical, forcing re-route");
          window.dispatchEvent(new HashChangeEvent("hashchange"));
        }
      } else {
        location.href = url;
      }
    }
  }

  const onErr = (e: unknown) => console.error("tryAutoplayNext:", e);
  video.addEventListener("ended", () => {
    autoplayTriggered = false;
    const inPiP =
      document.pictureInPictureElement === video ||
      video.webkitPresentationMode === "picture-in-picture";
    if (inPiP) {
      pendingPiPAutoNext = true;
    } else {
      tryAutoplayNext("ended event").catch(onErr);
    }
  }, { signal });

  video.addEventListener("timeupdate", () => {
    const dur = video.duration;
    if (!dur || !isFinite(dur)) return;
    if (autoplayTriggered) return;

    const ct = video.currentTime;
    if (dur - ct > 0.5) return;

    let bufferedEnd = 0;
    try {
      const buf = video.buffered;
      for (let i = 0; i < buf.length; i++) {
        if (buf.end(i) > bufferedEnd)
          bufferedEnd = buf.end(i);
      }
    } catch (_e) {
      return;
    }

    if (dur - bufferedEnd > 0.2) return;
    if (bufferedEnd - ct > 0.2) return;

    tryAutoplayNext("timeupdate threshold").catch(onErr);
  }, { signal });

  function isNearEnd(): boolean {
    const dur = video.duration;
    return isFinite(dur) && dur > 0 && (video.ended || dur - video.currentTime < 2);
  }
  function onLeavePiP(): void {
    if (pendingPiPAutoNext || isNearEnd())
      tryAutoplayNext("leave PiP").catch(onErr);
  }
  video.addEventListener("leavepictureinpicture", onLeavePiP, { signal });
  video.addEventListener("webkitpresentationmodechanged", () => {
    if (video.webkitPresentationMode === "inline" &&
      video._prevWebkitMode === "picture-in-picture")
      onLeavePiP();
    video._prevWebkitMode = video.webkitPresentationMode;
  }, { signal });

  loadEpList();
}

// ── Comments ──────────────────────────────────────────────────────────────────
interface CommentData {
  id: string | number;
  content?: string;
  is_spoiler?: boolean;
  created?: string;
  count_like?: number;
  count_reply_comment?: number;
  profile?: { image?: string; name?: string };
}

const manualCommentThumbs =
  localStorage.getItem("offline_metadata_mode") === "yes" &&
  localStorage.getItem("manual_comment_load") === "yes";
let activeCommentsLoadToken = 0;
let autoplayUiAc: AbortController | null = null;

function parseTsSecs(ts: string): number {
  const parts = ts.split(":").map((p) => parseFloat(p));
  return parts.length === 3
    ? parts[0] * 3600 + parts[1] * 60 + parts[2]
    : parts[0] * 60 + parts[1];
}

function renderWithTs(text: string): string {
  return esc(text).replace(
    /\b(\d{1,2}:\d{2}(?::\d{2})?(?:\.\d{1,3})?)\b/g,
    (_, ts: string) =>
      `<button class="ts-btn" data-t="${parseTsSecs(ts)}">${ts}</button>`,
  );
}

function buildCommentTextHtml(content: string | undefined, isSpoiler: boolean): string {
  const inner = renderWithTs(content ?? "");
  if (!isSpoiler)
    return `<div class="comment-text">${inner}</div>`;
  return `<div class="comment-text"><span class="spoiler-block" role="button" tabindex="0" title="스포일러 — 클릭하여 보기">${inner}</span></div>`;
}

function toDate(s: string | undefined): Date | null {
  if (!s) return null;
  return new Date(
    /[Zz]|[+-]\d{2}:?\d{2}$/.test(s) ? s : s + "+09:00",
  );
}

function fmtRelTime(s: string | undefined): string {
  const d = toDate(s);
  if (!d) return "";
  const sec = Math.floor((Date.now() - d.getTime()) / 1000);
  if (sec < 60) return "방금 전";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}분 전`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}시간 전`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}일 전`;
  const mo = Math.floor(day / 30.5);
  if (mo < 12) return `${mo}개월 전`;
  return `${Math.floor(mo / 12)}년 전`;
}

function fmtAbsTime(s: string | undefined): string {
  const d = toDate(s);
  if (!d) return "";
  return d.toLocaleString("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

let timePref: string = localStorage.getItem("time_pref") || "relative";
function fmtTs(s: string | undefined): string {
  return timePref === "relative" ? fmtRelTime(s) : fmtAbsTime(s);
}

function buildCommentEl(
  c: CommentData,
  isReply: boolean = false,
  parentId: string | number | null = null,
  getSorting: () => string = () => "top",
  seekReplyId: string | null = null,
): HTMLElement {
  const el = document.createElement("div");
  el.className = isReply ? "reply" : "comment";
  el.dataset["cid"] = String(c.id);
  const isSpoiler = !!c.is_spoiler;
  const avatarHtml = c.profile?.image && !manualCommentThumbs
    ? `<img class="comment-avatar" src="${esc(c.profile.image)}" alt="" loading="lazy">`
    : `<div class="comment-avatar"></div>`;
  const dateHtml = c.created
    ? `<span class="comment-date" data-ts="${esc(c.created)}">${fmtTs(c.created)}</span>`
    : "";
  const likesHtml =
    (c.count_like ?? 0) > 0
      ? `<span class="comment-likes">♥ ${c.count_like}</span>`
      : "";
  const repliesHtml =
    !isReply && (c.count_reply_comment ?? 0) > 0
      ? `<button class="comment-replies-btn">답글 ${c.count_reply_comment}개</button>`
      : "";

  const copyBtnHtml = `<button class="link-copy-btn comment-copy-btn" title="링크 복사" aria-label="댓글 링크 복사">🔗</button>`;
  el.innerHTML = `
	<div class="comment-header">${avatarHtml}<span class="comment-user">${esc(c.profile?.name ?? "익명")}</span></div>
	${buildCommentTextHtml(c.content, isSpoiler)}
	<div class="comment-footer">${likesHtml}${repliesHtml}${dateHtml}${copyBtnHtml}</div>
	${!isReply && (c.count_reply_comment ?? 0) > 0 ? `<div class="replies"></div>` : ""}`;

  el.querySelector(".comment-copy-btn")?.addEventListener("click", (e) => {
    e.stopPropagation();
    const sorting = getSorting();
    const sortingPart = sorting && sorting !== "top" ? `?sorting=${encodeURIComponent(sorting)}` : "";
    const url = `${location.origin}/comment/${c.id}${sortingPart}`;
    window.ShareLink?.copy(url, e.currentTarget as HTMLElement, { successText: "✓", resetText: "🔗" });
  });

  const spoiler = el.querySelector(".spoiler-block");
  if (spoiler) {
    const reveal = (e: Event) => {
      if (spoiler.classList.contains("revealed")) return;
      e.stopPropagation();
      spoiler.classList.add("revealed");
      spoiler.removeAttribute("tabindex");
    };
    spoiler.addEventListener("click", reveal);
    spoiler.addEventListener("keydown", (e) => {
      if ((e as KeyboardEvent).key === "Enter" || (e as KeyboardEvent).key === " ") {
        e.preventDefault();
        reveal(e);
      }
    });
  }

  el.querySelector(".comment-date")?.addEventListener(
    "click",
    () => {
      timePref =
        timePref === "relative" ? "absolute" : "relative";
      localStorage.setItem("time_pref", timePref);
      document
        .querySelectorAll(".comment-date[data-ts]")
        .forEach((d) => {
          (d as HTMLElement).textContent = fmtTs((d as HTMLElement).dataset["ts"]);
        });
    },
  );

  const repliesBtn = el.querySelector(".comment-replies-btn") as HTMLButtonElement | null;
  if (repliesBtn) {
    const repliesContainer = el.querySelector(".replies") as HTMLElement;
    const repliesId = `replies-${c.id}`;
    repliesContainer.id = repliesId;
    repliesBtn.setAttribute("aria-controls", repliesId);
    repliesBtn.setAttribute("aria-expanded", "false");
    const REPLY_PAGE = 10;
    let rOffset = 0,
      rTotal = Infinity,
      rLoading = false,
      rOpened = false,
      rDeepLinked = false;

    async function fetchReplies(): Promise<void> {
      if (rLoading || rOffset >= rTotal) return;
      rLoading = true;
      repliesBtn!.textContent = "로딩 중...";
      try {
        if (seekReplyId && !rDeepLinked) {
          rDeepLinked = true;
          try {
            const pos = await apiFetch<{ offset?: number }>(
              `/api/comments/v1/reply-position?parent_comment_id=${c.id}&id=${seekReplyId}`,
            ).catch(() => null);
            if (pos?.offset != null) {
              const pageStart = Math.floor(pos.offset / REPLY_PAGE) * REPLY_PAGE;
              if (pageStart > 0) {
                rOffset = pageStart;
                const prev = document.createElement("button");
                prev.className = "load-prev-btn reply-prev-btn";
                prev.textContent = `이전 답글 ${pageStart}개 보기`;
                prev.onclick = () => {
                  prev.remove();
                  rOffset = 0;
                  rTotal = Infinity;
                  rDeepLinked = true;
                  repliesContainer.innerHTML = "";
                  fetchReplies();
                };
                repliesContainer.before(prev);
              }
            }
          } catch (e) { console.debug("Ignored error:", e); }
        }
        const data = await apiFetch<{ results?: CommentData[]; count?: number }>(
          `/api/comments/v1/list?parent_comment_id=${c.id}&sorting=oldest&offset=${rOffset}&limit=${REPLY_PAGE}`,
        );
        const replies = data.results ?? [];
        rTotal = data.count ?? replies.length;
        repliesContainer
          .querySelector(".reply-load-more")
          ?.remove();
        for (const r of replies)
          repliesContainer.appendChild(
            buildCommentEl(r, true, c.id, getSorting),
          );
        rOffset += replies.length;
        if (rOffset < rTotal) {
          const more = document.createElement("button");
          more.className =
            "comments-load-more reply-load-more";
          more.textContent = `답글 더 보기 (${rTotal - rOffset}개 남음)`;
          more.addEventListener("click", fetchReplies);
          repliesContainer.appendChild(more);
        }
        repliesBtn!.textContent = `답글 ${rTotal}개`;
        if (seekReplyId && rOffset < rTotal &&
            !repliesContainer.querySelector(`[data-cid="${seekReplyId}"]`)) {
          setTimeout(fetchReplies, 0);
        }
      } catch (e) {
        console.error("fetchReplies:", e);
        repliesBtn!.textContent = `답글 ${c.count_reply_comment}개`;
      } finally {
        rLoading = false;
      }
    }

    repliesBtn.addEventListener("click", () => {
      const isOpen =
        repliesContainer.classList.toggle("open");
      repliesBtn!.classList.toggle("open", isOpen);
      repliesBtn!.setAttribute("aria-expanded", String(isOpen));
      if (!isOpen || rOpened) return;
      rOpened = true;
      fetchReplies();
    });
  }
  return el;
}

function waitForEl(sel: string, root: Document | Element = document, maxMs: number = 5000): Promise<Element | null> {
  return new Promise((resolve) => {
    const el = root.querySelector(sel);
    if (el) { resolve(el); return; }
    const deadline = Date.now() + maxMs;
    const mo = new MutationObserver(() => {
      const found = root.querySelector(sel);
      if (found || Date.now() >= deadline) { mo.disconnect(); resolve(found ?? null); }
    });
    mo.observe(root, { childList: true, subtree: true });
  });
}

async function loadComments(epId: string): Promise<void> {
  const loadToken = ++activeCommentsLoadToken;
  const toggle = document.getElementById("comments-toggle") as HTMLElement;
  const list = document.getElementById("comments-list")!;
  const wrap = document.getElementById("comments-wrap")!;
  const sortBar = document.getElementById("comments-sort")!;
  list.innerHTML = "";
  toggle.textContent = "댓글";
  document.getElementById("comments-prev-btn")?.remove();

  // PC layout toggle (sidebar ↔ below player)
  const layoutBtn = document.getElementById("btn-comments-layout");
  const mainLayout = document.getElementById("main-layout");
  const playerCol = document.getElementById("player-col");
  let onLayoutChange: (() => void) | null = null;
  if (layoutBtn && mainLayout) {
    const LAYOUT_KEY = "comments_layout";
    let userPrefersBelow = localStorage.getItem(LAYOUT_KEY) === "below";

    const applyCommentsLayout = (below: boolean, forcedSide = false) => {
      const useBelow = below && !forcedSide;
      const rect = playerCol?.getBoundingClientRect() ?? null;
      const needsViewportScroll =
        window.innerWidth >= 660 &&
        !useBelow &&
        !!rect &&
        (rect.bottom > window.innerHeight - 8 || rect.right > window.innerWidth - 8);
      mainLayout.classList.toggle("comments-below", useBelow);
      mainLayout.classList.toggle("comments-auto-side", forcedSide);
      mainLayout.classList.toggle("viewport-scroll", needsViewportScroll);
      document.documentElement.classList.toggle("comments-below-layout", useBelow);
      document.body.classList.toggle("comments-below-layout", useBelow);
      document.documentElement.classList.toggle("viewport-scroll-layout", needsViewportScroll);
      document.body.classList.toggle("viewport-scroll-layout", needsViewportScroll);
      layoutBtn.title = forcedSide
        ? "화면 높이가 부족해 댓글을 옆에 표시 중"
        : "댓글 위치 변경";
      onLayoutChange?.();
    };

    const shouldForceSideLayout = () => {
      if (!playerCol) return false;
      const w = window.innerWidth;
      const h = window.innerHeight;
      
      if (w < 660) return false;

      // 1. If it overflows vertically when placed "below", we MUST use side-layout
      // to keep it sticky/visible and fit within max-height.
      const hadBelow = mainLayout.classList.contains("comments-below");
      if (!hadBelow) {
        mainLayout.classList.add("comments-below");
        document.documentElement.classList.add("comments-below-layout");
        document.body.classList.add("comments-below-layout");
      }

      const playerRect = playerCol.getBoundingClientRect();
      const overflowsViewport = playerRect.bottom > h;

      if (!hadBelow) {
        mainLayout.classList.remove("comments-below");
        document.documentElement.classList.remove("comments-below-layout");
        document.body.classList.remove("comments-below-layout");
      }

      if (overflowsViewport) return true;

      // 2. Otherwise use sensible aspect ratio defaults
      const ratio = w / h;
      if (ratio > 1.6) return true;
      if (ratio < 1.1) return false;

      return false;
    };

    const syncCommentsLayout = () => {
      const forcedSide = userPrefersBelow && shouldForceSideLayout();
      applyCommentsLayout(userPrefersBelow, forcedSide);
    };

    syncCommentsLayout();
    layoutBtn.addEventListener("click", () => {
      userPrefersBelow = !userPrefersBelow;
      localStorage.setItem(LAYOUT_KEY, userPrefersBelow ? "below" : "side");
      syncCommentsLayout();
    });

    let resizeTicking = false;
    const handleLayoutResize = () => {
      if (resizeTicking) return;
      resizeTicking = true;
      requestAnimationFrame(() => {
        resizeTicking = false;
        syncCommentsLayout();
      });
    };
    window.addEventListener("resize", handleLayoutResize, { passive: true });
  }

  const PAGE = 20;
  const _p = new URLSearchParams(location.hash.slice(1));
  const targetCid = _p.get("comment");
  const targetRid = _p.get("reply");
  let sorting = _p.get("sorting") || "top",
    offset = 0,
    total = Infinity,
    loading = false,
    deepLinked = false,
    cHighlighted = false;

  sortBar.querySelectorAll(".csort-btn").forEach((b) => {
    const isActive = (b as HTMLElement).dataset["sorting"] === sorting;
    b.classList.toggle("active", isActive);
    b.setAttribute("aria-pressed", String(isActive));
  });

  list.onclick = (e) => {
    const btn = (e.target as Element).closest(".ts-btn") as HTMLElement | null;
    if (!btn) return;
    if (
      btn.closest(".spoiler-block") &&
      !btn
        .closest(".spoiler-block")!
        .classList.contains("revealed")
    )
      return;
    const video = document.getElementById("v") as HTMLVideoElement;
    video.currentTime = parseFloat(btn.dataset["t"]!);
    video.play().catch(() => {});
    document
      .getElementById("video-box")!
      .scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const sentinel = document.createElement("div");
  sentinel.id = "comments-sentinel";
  let io: IntersectionObserver | null = null;

  function getObserverRoot(): Element | Document | null {
    return mainLayout?.classList.contains("comments-below") ? null : wrap;
  }

  function setupIO(): void {
    if (io) io.disconnect();
    io = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) fetchPage();
      },
      { root: getObserverRoot() as Element | null, rootMargin: "200px" },
    );
    io.observe(sentinel);
  }

  function reset(): void {
    offset = 0;
    total = Infinity;
    loading = false;
    deepLinked = false;
    cHighlighted = false;
    if (io) { io.disconnect(); io = null; }
    sentinel.remove();
    list.innerHTML = "";
    document.getElementById("comments-prev-btn")?.remove();
  }

  onLayoutChange = () => {
    if (!sentinel.isConnected || offset >= total) return;
    setupIO();
  };

  async function fetchPage(): Promise<void> {
    if (loadToken !== activeCommentsLoadToken) return;
    if (loading || offset >= total) return;
    loading = true;

    if (targetCid && !deepLinked) {
      deepLinked = true;
      try {
        const pos = await apiFetch<{ offset?: number }>(
          `/api/comments/v1/position?episode_id=${epId}&id=${targetCid}&sorting=${sorting}`,
        ).catch(() => null);
        if (loadToken !== activeCommentsLoadToken) return;
        if (pos?.offset != null) {
          const pageStart = Math.floor(pos.offset / PAGE) * PAGE;
          if (pageStart > 0) {
            offset = pageStart;
            const prev = document.createElement("button");
            prev.id = "comments-prev-btn";
            prev.className = "load-prev-btn";
            prev.textContent = `이전 댓글 ${pageStart}개 보기`;
            prev.onclick = () => {
              prev.remove();
              reset();
              deepLinked = true;
              if (loadToken === activeCommentsLoadToken) void fetchPage();
            };
            list.before(prev);
          }
        } else {
          deepLinked = false;
        }
      } catch (_) {
        deepLinked = false;
      }
    }

    try {
      const data = await apiFetch<{ results?: CommentData[]; count?: number }>(
        `/api/comments/v1/list?episode_id=${epId}&offset=${offset}&limit=${PAGE}&sorting=${sorting}`,
      );
      if (loadToken !== activeCommentsLoadToken) return;
      const items = data.results ?? [];
      total = data.count ?? items.length;
      toggle.textContent = `댓글 ${total.toLocaleString()}개`;
      if (offset === 0 && items.length === 0) {
        list.innerHTML =
          '<p id="comments-empty">댓글이 없습니다.</p>';
        return;
      }
      for (const c of items)
        list.appendChild(buildCommentEl(c, false, null, () => sorting,
          (targetRid && String(c.id) === String(targetCid)) ? targetRid : null));
      offset += items.length;
      if (offset < total) {
        list.appendChild(sentinel);
        setupIO();
      } else sentinel.remove();

      if (targetCid && !cHighlighted) {
        const parentEl = list.querySelector(`[data-cid="${targetCid}"]`);
        if (parentEl) {
          cHighlighted = true;
          if (!targetRid) {
            window.ShareLink?.highlight(parentEl);
          } else {
            const replyBtn = parentEl.querySelector(".comment-replies-btn") as HTMLButtonElement | null;
            if (replyBtn && !replyBtn.classList.contains("open"))
              replyBtn.click();
            waitForEl(`[data-cid="${targetRid}"]`, list, 30000).then((replyEl) => {
              if (loadToken !== activeCommentsLoadToken) return;
              window.ShareLink?.highlight(replyEl ?? parentEl);
            });
          }
        } else if (offset < total) {
          setTimeout(() => {
            if (loadToken === activeCommentsLoadToken) void fetchPage();
          }, 80);
        }
      }
    } catch (e) {
      if (loadToken !== activeCommentsLoadToken) return;
      console.error("fetchPage:", e);
      if (offset === 0)
        list.innerHTML =
          '<p id="comments-empty">댓글을 불러올 수 없습니다.</p>';
    } finally {
      if (loadToken !== activeCommentsLoadToken) return;
      loading = false;
      // If the viewport isn't filled yet, trigger next page load automatically.
      if (offset < total && sentinel.isConnected) {
        if (sentinel.getBoundingClientRect().top < window.innerHeight + 300) {
          setTimeout(() => {
            if (loadToken === activeCommentsLoadToken) void fetchPage();
          }, 50);
        }
      }
    }
  }

  sortBar.onclick = (e) => {
    const btn = (e.target as Element).closest(".csort-btn") as HTMLElement | null;
    if (!btn || btn.classList.contains("active")) return;
    sortBar
      .querySelectorAll(".csort-btn")
      .forEach((b) => {
        b.classList.remove("active");
        b.setAttribute("aria-pressed", "false");
      });
    btn.classList.add("active");
    btn.setAttribute("aria-pressed", "true");
    sorting = btn.dataset["sorting"]!;
    reset();
    if (loadToken === activeCommentsLoadToken) void fetchPage();
  };

  void fetchPage();
}

function esc(s: string): string {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export {};
