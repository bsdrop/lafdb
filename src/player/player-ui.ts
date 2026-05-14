import { WatchHistory, updateEpisodeHistoryMeta } from "../watch-history";
import { rewriteCdnUrl } from "../shared/cdn";
import { parseShareTime } from "../shared/time";
import { ensureExtStatus, extSend, getExtRoute, getMyName, initExt, isExtEnabled, isExtLoggedIn } from "../shared/ext";

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
    mpvCopy?: () => void;
  }
}

function rewriteCDN(url: string): string {
  return rewriteCdnUrl(url);
}
window.rewriteCDN = rewriteCDN;

function isAppleMobileLike(): boolean {
  const ua = navigator.userAgent || "";
  const platform = navigator.platform || "";
  const touchPoints = navigator.maxTouchPoints || 0;
  return /\b(iPhone|iPad|iPod)\b/i.test(ua) || (platform === "MacIntel" && touchPoints > 1);
}

const EXT_INVENTORY_COMMENT_URL = "https://laftel.net/inventory?category=comment";

function apiPathToExtPath(url: string): string {
  const path = url.startsWith("/api/") ? url.slice(4) : url;
  const [pathname, search = ""] = path.split("?", 2);
  const normalizedPath = pathname.endsWith("/") ? pathname : `${pathname}/`;
  return search ? `${normalizedPath}?${search}` : normalizedPath;
}

function toCommentSortKeyDate(value: string | undefined): number {
  const d = value ? new Date(/[Zz]|[+-]\d{2}:?\d{2}$/.test(value) ? value : value + "+09:00") : null;
  const t = d?.getTime();
  return Number.isFinite(t) ? (t as number) : 0;
}

function sortMergedComments(items: CommentData[], sorting: string): CommentData[] {
  const out = [...items];
  out.sort((a, b) => {
    if (sorting === "oldest") {
      const byCreated = toCommentSortKeyDate(a.created) - toCommentSortKeyDate(b.created);
      if (byCreated !== 0) return byCreated;
      return Number(a.id) - Number(b.id);
    }

    const byLikes = (b.count_like ?? 0) - (a.count_like ?? 0);
    if (byLikes !== 0) return byLikes;
    const byReplies = (b.count_reply_comment ?? 0) - (a.count_reply_comment ?? 0);
    if (byReplies !== 0) return byReplies;
    const byCreated = toCommentSortKeyDate(b.created) - toCommentSortKeyDate(a.created);
    if (byCreated !== 0) return byCreated;
    return Number(b.id) - Number(a.id);
  });
  return out;
}

async function fetchCommentListRoute<T>(url: string): Promise<T> {
  await ensureExtStatus();
  if (isExtEnabled() && isExtLoggedIn() && getExtRoute() === "direct") {
    const path = apiPathToExtPath(url);
    const parsed = new URL(path, "https://api.laftel.net");
    if (parsed.pathname === "/comments/v1/list/" && !parsed.searchParams.has("mine")) {
      const falseUrl = new URL(parsed.toString());
      const trueUrl = new URL(parsed.toString());
      falseUrl.searchParams.set("mine", "false");
      trueUrl.searchParams.set("mine", "true");

      const [publicRes, mineRes] = await Promise.all([
        extSend({ type: "api", method: "GET", path: `${falseUrl.pathname}${falseUrl.search}` }),
        extSend({ type: "api", method: "GET", path: `${trueUrl.pathname}${trueUrl.search}` }),
      ]);
      if (!publicRes?.ok) throw new Error(publicRes?.error ?? `HTTP ${publicRes?.status ?? "extension"}`);
      if (!mineRes?.ok) throw new Error(mineRes?.error ?? `HTTP ${mineRes?.status ?? "extension"}`);

      const merged = new Map<string, CommentData>();
      for (const item of (publicRes.data?.results ?? []) as CommentData[]) merged.set(String(item.id), item);
      for (const item of (mineRes.data?.results ?? []) as CommentData[]) merged.set(String(item.id), item);

      const sorting = parsed.searchParams.get("sorting") ?? "top";
      const mergedResults = sortMergedComments(Array.from(merged.values()), sorting);
      return {
        ...(publicRes.data ?? {}),
        count: Math.max(publicRes.data?.count ?? 0, mineRes.data?.count ?? 0, mergedResults.length),
        results: mergedResults,
      } as T;
    }

    const res = await extSend({ type: "api", method: "GET", path });
    if (!res?.ok) throw new Error(res?.error ?? `HTTP ${res?.status ?? "extension"}`);
    return res.data as T;
  }
  return apiFetch<T>(url);
}

async function fetchCommentCountRoute(epId: string): Promise<number | null> {
  const url = `/api/comments/v1/count?episode_id=${encodeURIComponent(epId)}`;
  await ensureExtStatus();
  if (!(isExtEnabled() && isExtLoggedIn() && getExtRoute() === "direct")) return null;
  const res = await extSend({ type: "api", method: "GET", path: apiPathToExtPath(url) });
  if (!res?.ok) throw new Error(res?.error ?? `HTTP ${res?.status ?? "extension"}`);
  return typeof res.data?.comment_count === "number" ? res.data.comment_count : null;
}

function buildInventoryGuideHtml(label = "라프텔 댓글함"): string {
  return `<a class="ext-action-btn" href="${EXT_INVENTORY_COMMENT_URL}" target="_blank" rel="noreferrer">${label}</a>`;
}

function showInventoryGuideAfter(el: HTMLElement, text: string): void {
  el.nextElementSibling?.classList.contains("ext-inventory-guide") && el.nextElementSibling.remove();
  const guide = document.createElement("div");
  guide.className = "ext-inventory-guide";
  guide.innerHTML = `${esc(text)} ${buildInventoryGuideHtml("수정/삭제하러 가기")}`;
  el.after(guide);
}

const ShareSheet = (() => {
  const overlay = document.getElementById("share-overlay")!;
  const sheet = document.getElementById("share-sheet")!;
  const timeRow = document.getElementById("share-time-row")!;
  const timeToggle = document.getElementById("share-time-toggle") as HTMLInputElement;
  const laftelToggle = document.getElementById("share-laftel-toggle") as HTMLInputElement;
  const rowsEl = document.getElementById("share-rows")!;

  let _epId: string | null = null,
    _itemId: string | null = null,
    _epTitle = "",
    _getTime: (() => number) | null = null;

  const handle = document.getElementById("share-handle");
  let raised = false;

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
    laftelToggle.checked = localStorage.getItem("share_laftel_url") !== "no";
    laftelToggle.onchange = () => {
      if (laftelToggle.checked) localStorage.removeItem("share_laftel_url");
      else localStorage.setItem("share_laftel_url", "no");
      render();
    };
    render();
    timeToggle.onchange = render;

    raised = false;
    sheet.style.transform = "";
    overlay.classList.add("open");
    sheet.classList.add("open");
    sheet.setAttribute("aria-hidden", "false");
  }

  function close(): void {
    raised = false;
    sheet.style.transition = "";
    sheet.style.transform = "";
    overlay.classList.remove("open");
    sheet.classList.remove("open");
    sheet.setAttribute("aria-hidden", "true");
  }

  function buildUrls(): Array<{ label: string; url: string; withTime?: boolean }> {
    const base = location.origin;
    const useLaftel = localStorage.getItem("share_laftel_url") !== "no";
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
    const useLaftel = localStorage.getItem("share_laftel_url") !== "no";
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
    let copied = false;
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
    } catch (e) {
      console.error("[PLAYER] clipboard write failed; falling back to execCommand:", e);
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;top:-9999px";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
        copied = true;
      } catch (fallbackError) {
        console.error("[PLAYER] clipboard fallback failed:", fallbackError);
      }
      ta.remove();
    }
    if (copied) {
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
          console.error("[PLAYER] native share failed:", err);
      }
    }
  });

  overlay.addEventListener("click", close);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && sheet.classList.contains("open")) close();
  });

  if (handle) {
    let touchStartY = 0;
    let raisedPx = 0;
    handle.addEventListener("touchstart", (e) => {
      touchStartY = e.touches[0].clientY;
      raisedPx = -Math.round(window.innerHeight * 0.42);
      sheet.style.transition = "none";
    }, { passive: true });
    handle.addEventListener("touchmove", (e) => {
      const dy = e.changedTouches[0].clientY - touchStartY;
      const base = raised ? raisedPx : 0;
      sheet.style.transform = `translateY(${Math.max(raisedPx, base + dy)}px)`;
    }, { passive: true });
    handle.addEventListener("touchend", (e) => {
      const dy = e.changedTouches[0].clientY - touchStartY;
      sheet.style.transition = "";
      if (raised) {
        if (dy > 80) {
          raised = false;
          sheet.style.transform = "";
        } else {
          sheet.style.transform = `translateY(${raisedPx}px)`;
        }
      } else {
        if (dy < -80) {
          raised = true;
          sheet.style.transform = `translateY(${raisedPx}px)`;
        } else if (dy > 80) {
          sheet.style.transform = "";
          close();
        } else {
          sheet.style.transform = "";
        }
      }
    }, { passive: true });
  }

  return { open, close };
})();

let autoSkip = localStorage.getItem("player_autoskip") === "on";
let autoPlay = localStorage.getItem("player_autoplay") !== "off";
const AUTO_SKIP_EPSILON_SECONDS = 0.075;
const AUTO_SKIP_NEAR_END_GRACE_SECONDS = 5;
const AUTO_SKIP_NEAR_END_WINDOW_SECONDS = 3;
const btnAutoSkip = document.getElementById("btn-autoskip") as HTMLButtonElement;
const btnAutoPlay = document.getElementById("btn-autoplay") as HTMLButtonElement;
const autoPlayDelayInput = document.getElementById("input-autoplay-delay") as HTMLInputElement | null;
function shouldShowTimelineBar(): boolean {
  return localStorage.getItem("player_timeline_bar") !== "off";
}
function applyTimelineBarVisibility(): void {
  const bar = document.getElementById("timeline-bar");
  if (!bar) return;
  bar.hidden = !shouldShowTimelineBar();
}
function getAutoPlayDelaySeconds(): number {
  const raw = parseFloat(localStorage.getItem("player_autoplay_delay") ?? localStorage.getItem("player_autoskip_delay") ?? "0");
  if (!Number.isFinite(raw)) return 0;
  return Math.max(0, raw);
}
function setAutoPlayDelaySeconds(value: number): void {
  const next = Number.isFinite(value) ? Math.max(0, Math.round(value * 10) / 10) : 0;
  localStorage.removeItem("player_autoskip_delay");
  if (next === 0) localStorage.removeItem("player_autoplay_delay");
  else localStorage.setItem("player_autoplay_delay", String(next));
  if (autoPlayDelayInput) {
    autoPlayDelayInput.value = Number.isInteger(next) ? String(next) : next.toFixed(1);
  }
}
function syncOptBtns(): void {
  btnAutoSkip.classList.toggle("on", autoSkip);
  btnAutoSkip.textContent = autoSkip ? "켜짐" : "꺼짐";
  btnAutoSkip.setAttribute("aria-pressed", String(autoSkip));
  btnAutoPlay.classList.toggle("on", autoPlay);
  btnAutoPlay.textContent = autoPlay ? "켜짐" : "꺼짐";
  btnAutoPlay.setAttribute("aria-pressed", String(autoPlay));
  if (autoPlayDelayInput) setAutoPlayDelaySeconds(getAutoPlayDelaySeconds());
  applyTimelineBarVisibility();
}
syncOptBtns();
window.addEventListener("storage", (e) => {
  if (e.key === "player_timeline_bar") applyTimelineBarVisibility();
});
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
autoPlayDelayInput?.addEventListener("change", () => {
  setAutoPlayDelaySeconds(parseFloat(autoPlayDelayInput.value));
});
autoPlayDelayInput?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") autoPlayDelayInput.blur();
});
autoPlayDelayInput?.addEventListener("blur", () => {
  setAutoPlayDelaySeconds(parseFloat(autoPlayDelayInput.value));
});

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

const params = new URLSearchParams(location.hash.slice(1));
let epId = params.get("epId");
const itemId = params.get("itemId");

let _currentEpTitle = "";
let _currentEpHistoryLabel = "";
let _currentItemId: string | null = itemId ?? null;
let mediaSessionAc: AbortController | null = null;
let markerAc: AbortController | null = null;
let markerLoadToken = 0;

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
  btn.href = `/item/${id}`;
  btn.style.display = "";
}
if (_currentItemId) updateItemBtn(_currentItemId);

async function initUIForEpisode(id: string): Promise<void> {
  const loadToken = ++markerLoadToken;
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
    if (loadToken !== markerLoadToken || id !== epId) return;
    setupMarkers(info["markers"] as MarkerData | null | undefined);
  } catch (e) {
    console.error("markers fetch:", e);
    if (loadToken !== markerLoadToken || id !== epId) return;
    setupMarkers(null);
  }

  setupAutoplay(id);
  setupProgressSave();
  setupMediaSession();
  loadComments(id);
  setupShareButton();
  setupFullscreenButton();
  setupCaptureButton();
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

let _volumeToastTimer: ReturnType<typeof setTimeout> | null = null;
function showVolumeToast(video: HTMLVideoElement): void {
  const box = document.getElementById("video-box");
  if (!box) return;
  let toast = document.getElementById("volume-toast") as HTMLDivElement | null;
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "volume-toast";
    toast.style.cssText = [
      "position:absolute", "top:50%", "left:50%",
      "transform:translate(-50%,-50%)",
      "z-index:30", "pointer-events:none",
      "background:rgba(0,0,0,.55)", "border-radius:10px",
      "padding:10px 18px",
      'font:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
      "color:#fff", "text-align:center",
      "transition:opacity .15s",
    ].join(";");
    box.appendChild(toast);
  }
  const label = video.muted || video.volume <= 0 ? "음소거" : `볼륨 ${Math.round(video.volume * 100)}%`;
  toast.innerHTML = `<span style="font-size:18px;font-weight:700;line-height:1.1;">${label}</span>`;
  toast.style.opacity = "1";
  if (_volumeToastTimer) clearTimeout(_volumeToastTimer);
  _volumeToastTimer = setTimeout(() => {
    if (toast) toast.style.opacity = "0";
  }, 800);
}

document.addEventListener("keydown", (e) => {
  if ((e.target as Element).matches("input, textarea, [contenteditable]")) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const v = document.getElementById("v") as HTMLVideoElement | null;
  if (e.key === " ") {
    if (!v) return;
    if (e.target === v || document.activeElement === v) return;
    e.preventDefault();
    if (v.paused) v.play().catch((err) => console.error("[PLAYER] keyboard play failed:", err));
    else v.pause();
    return;
  }
  if ((e.key === "," || e.key === ".") && v) {
    e.preventDefault();
    const frame = 1 / 24; // FUCK
    const dir = e.key === "." ? 1 : -1;
    const dur = Number.isFinite(v.duration) ? v.duration : Infinity;
    const next = Math.max(0, Math.min(dur, v.currentTime + dir * frame));
    v.currentTime = next;
    return;
  }
  if (e.key.toLowerCase() === "s" && !e.shiftKey && v) {
    e.preventDefault();
    return void saveCurrentFramePng(v);
  }
  if (e.key.toLowerCase() === "m" && !e.shiftKey && v) {
    e.preventDefault();
    v.muted = !v.muted;
    showVolumeToast(v);
    return;
  }
  if ((e.key === "ArrowUp" || e.key === "ArrowDown") && v) {
    e.preventDefault();
    const delta = e.key === "ArrowUp" ? 0.05 : -0.05;
    const next = Math.max(0, Math.min(1, Math.round((v.volume + delta) * 100) / 100));
    v.volume = next;
    v.muted = next <= 0;
    showVolumeToast(v);
    return;
  }
  if (e.key.toLowerCase() === "f" && !e.shiftKey && v) {
    e.preventDefault();
    togglePlayerFullscreen();
    return;
  }
});

function setupMediaSession(): void {
  if (!("mediaSession" in navigator)) return;
  const video = document.getElementById("v") as HTMLVideoElement;
  const ms = navigator.mediaSession;
  mediaSessionAc?.abort();
  mediaSessionAc = new AbortController();
  const signal = mediaSessionAc.signal;

  function syncMetadata(): void {
    try {
      ms.metadata = new MediaMetadata({ title: _currentEpTitle || document.title });
    } catch (e) { console.error("[PLAYER] media session metadata update failed:", e); }
  }
  syncMetadata();
  const titleEl = document.getElementById("ep-title");
  if (titleEl) {
    const observer = new MutationObserver(syncMetadata);
    observer.observe(titleEl, { childList: true });
    signal.addEventListener("abort", () => observer.disconnect(), { once: true });
  }

  function syncPlaybackState(): void {
    try { ms.playbackState = video.paused ? "paused" : "playing"; } catch (e) { console.error("[PLAYER] media session playbackState update failed:", e); }
  }
  video.addEventListener("play", syncPlaybackState, { signal });
  video.addEventListener("pause", syncPlaybackState, { signal });
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
    } catch (e) { console.error("[PLAYER] media session positionState update failed:", e); }
  }
  let _posTimer: ReturnType<typeof setTimeout> | 0 = 0;
  video.addEventListener("timeupdate", () => {
    if (_posTimer) return;
    _posTimer = setTimeout(() => { _posTimer = 0; syncPositionState(); }, 1000);
  }, { signal });
  signal.addEventListener("abort", () => {
    if (_posTimer) clearTimeout(_posTimer);
    _posTimer = 0;
  }, { once: true });
  video.addEventListener("loadedmetadata", syncPositionState, { signal });
  video.addEventListener("durationchange", syncPositionState, { signal });
  video.addEventListener("seeked",         syncPositionState, { signal });
  video.addEventListener("ratechange",     syncPositionState, { signal });

  function safeSeek(t: number): void {
    try {
      const dur = video.duration;
      if (!dur || !isFinite(dur)) return;
      video.currentTime = Math.max(0, Math.min(t, dur));
    } catch (e) { console.error("[PLAYER] media session seek failed:", e); }
  }

  const videoWithFastSeek = video as HTMLVideoElement & { fastSeek?: (t: number) => void };

  const handlers: Record<string, (details?: MediaSessionActionDetails | null) => void> = {
    play:         () => { try { video.play().catch((err) => console.error("[PLAYER] media session play failed:", err)); } catch (e) { console.error("[PLAYER] media session play threw:", e); } },
    pause:        () => { try { video.pause(); } catch (e) { console.error("[PLAYER] media session pause failed:", e); } },
    seekforward:  (details) => safeSeek(video.currentTime + (details?.seekOffset ?? 10)),
    seekbackward: (details) => safeSeek(video.currentTime - (details?.seekOffset ?? 10)),
    seekto:       (details) => {
      if (details?.seekTime == null) return;
      if (details.fastSeek && videoWithFastSeek.fastSeek) {
        try { videoWithFastSeek.fastSeek(details.seekTime); } catch (e) { console.error("[PLAYER] media session fastSeek failed:", e); safeSeek(details.seekTime); }
      } else {
        safeSeek(details.seekTime);
      }
    },
  };

  for (const [action, handler] of Object.entries(handlers)) {
    try { ms.setActionHandler(action as MediaSessionAction, handler); } catch (e) { console.error(`[PLAYER] media session action handler failed (${action}):`, e); }
  }
}

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
      _currentEpTitle,
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

function togglePlayerFullscreen(): void {
  const box = document.getElementById("video-box");
  if (!box) return;
  if (document.fullscreenElement) {
    document.exitFullscreen?.();
  } else {
    box.requestFullscreen?.();
  }
}

function syncPlayerFullscreenClass(): void {
  const box = document.getElementById("video-box");
  if (!box) return;
  box.classList.toggle("is-box-fullscreen", document.fullscreenElement === box);
}

let fullscreenCoercionInProgress = false;

async function forceBoxFullscreenFromNativeRequest(): Promise<void> {
  const box = document.getElementById("video-box");
  if (!box) return;
  if (document.fullscreenElement === box) {
    syncPlayerFullscreenClass();
    return;
  }

  fullscreenCoercionInProgress = true;
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen?.();
    }
    await box.requestFullscreen?.();
  } finally {
    fullscreenCoercionInProgress = false;
  }
}

document.addEventListener("fullscreenchange", () => {
  syncPlayerFullscreenClass();
  const box = document.getElementById("video-box");
  if (!box) return;
  if (fullscreenCoercionInProgress) return;
  if (document.fullscreenElement && document.fullscreenElement !== box) {
    void forceBoxFullscreenFromNativeRequest();
  }
});

function setupFullscreenButton(): void {
  const btn = document.getElementById("btn-fullscreen") as HTMLButtonElement | null;
  if (!btn || btn.dataset["bound"] === "yes") return;
  btn.dataset["bound"] = "yes";
  btn.addEventListener("click", () => {
    togglePlayerFullscreen();
  });
}

function setupCaptureButton(): void {
  const video = document.getElementById("v") as HTMLVideoElement | null;
  const btn = document.getElementById("btn-capture") as HTMLButtonElement | null;
  if (!video || !btn || btn.dataset["bound"] === "yes") return;
  btn.dataset["bound"] = "yes";
  btn.addEventListener("click", () => {
    btn.blur();
    const popup = isAppleMobileLike() ? window.open("", "_blank", "noopener,noreferrer") : null;
    void saveCurrentFramePng(video, popup);
  });
}

function buildCurrentMpvCommand(): string | null {
  const p = new URLSearchParams(location.hash.slice(1));
  const player = (window as Window & { _currentPlayer?: { _mpdUrl?: string; _keyHex?: string } | null })._currentPlayer;
  const mpdUrl = p.get("mpd") || player?._mpdUrl || null;
  if (!mpdUrl) return null;
  const keyHex = p.get("key") || player?._keyHex || "";
  return keyHex
    ? `mpv "ytdl://${mpdUrl}" --ytdl-raw-options=allow-unplayable-formats= --demuxer-lavf-o=decryption_key=${keyHex}`
    : `mpv "ytdl://${mpdUrl}"`;
}

let _mpvToastTimer: ReturnType<typeof setTimeout> | null = null;
function showMpvCopyToast(message: string): void {
  const host = document.getElementById("ep-info");
  if (!host) return;
  let toast = document.getElementById("mpv-copy-toast") as HTMLDivElement | null;
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "mpv-copy-toast";
    toast.className = "ep-copy-toast";
    host.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add("show");
  if (_mpvToastTimer) clearTimeout(_mpvToastTimer);
  _mpvToastTimer = setTimeout(() => {
    toast?.classList.remove("show");
  }, 1500);
}

function formatCaptureTimestamp(seconds: number): string {
  const totalMs = Math.max(0, Math.floor(seconds * 1000));
  const h = Math.floor(totalMs / 3600000);
  const m = Math.floor((totalMs % 3600000) / 60000);
  const s = Math.floor((totalMs % 60000) / 1000);
  const ms = totalMs % 1000;
  return `${String(h).padStart(2, "0")}-${String(m).padStart(2, "0")}-${String(s).padStart(2, "0")}-${String(ms).padStart(3, "0")}`;
}

async function saveCurrentFramePng(video: HTMLVideoElement, popup: Window | null = null): Promise<void> {
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (!width || !height) {
    popup?.close();
    alert("아직 프레임을 캡처할 수 없습니다.");
    return;
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    popup?.close();
    alert("캡처용 캔버스를 만들 수 없습니다.");
    return;
  }

  try {
    ctx.drawImage(video, 0, 0, width, height);
  } catch (e) {
    console.error("[PLAYER] capture drawImage failed:", e);
    popup?.close();
    alert("현재 브라우저에서는 이 프레임을 캡처할 수 없습니다.");
    return;
  }

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) {
    popup?.close();
    alert("PNG 생성에 실패했습니다.");
    return;
  }

  const baseTitle = (_currentEpTitle || epId || "capture")
    .replace(/[\\/:*?"<>|]+/g, " ")
    .trim()
    .replace(/\s+/g, "_");
  const filename = `${baseTitle || "capture"}_${formatCaptureTimestamp(video.currentTime)}.png`;
  const url = URL.createObjectURL(blob);
  if (popup) {
    try {
      popup.location.href = url;
      popup.document.title = filename;
      showMpvCopyToast("새 탭에서 열었습니다. 길게 눌러 저장하세요");
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      return;
    } catch (e) {
      console.error("[PLAYER] capture popup navigation failed:", e);
      popup.close();
    }
  }
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showMpvCopyToast("PNG가 저장되었습니다");
}

async function handleMpvCopy(): Promise<void> {
  const cmd = buildCurrentMpvCommand();
  if (!cmd) {
    alert("현재 재생 정보가 없어 mpv 명령을 만들 수 없습니다.");
    return;
  }
  try {
    await navigator.clipboard.writeText(cmd);
    showMpvCopyToast("명령이 복사되었습니다");
  } catch (e) {
    console.error("[PLAYER] mpv command clipboard copy failed:", e);
    alert("클립보드 복사에 실패했습니다.");
  }
}

window.mpvCopy = () => void handleMpvCopy();

interface MarkerData {
  opening?: { start: number; end: number };
  ending?: { start: number; end: number };
}

function setupMarkers(markers: MarkerData | null | undefined): void {
  const video = document.getElementById("v") as HTMLVideoElement;
  const btnOpen = document.getElementById("skip-opening") as HTMLButtonElement;
  const btnEnd = document.getElementById("skip-ending") as HTMLButtonElement;
  const timelineTrack = document.getElementById("timeline-track");

  markerAc?.abort();
  markerAc = new AbortController();
  const signal = markerAc.signal;

  btnOpen.classList.remove("visible");
  btnEnd.classList.remove("visible");
  btnOpen.onclick = null;
  btnEnd.onclick = null;
  timelineTrack?.querySelectorAll(".tl-marker").forEach((el) => el.remove());

  type SkipPlayer = { skipRanges: Array<{ start: number; end: number }> } | null | undefined;
  const p = (window as Window & { _currentPlayer?: SkipPlayer })._currentPlayer;
  if (p) {
    p.skipRanges = markers
      ? [
          ...(markers.opening ? [markers.opening] : []),
          ...(markers.ending ? [markers.ending] : []),
        ]
      : [];
  }
  if (!markers) return;

  let autoSkipAc: AbortController | null = null;
  let pendingAutoSkipKey: string | null = null;

  function cancelScheduledAutoSkip(): void {
    autoSkipAc?.abort();
    autoSkipAc = null;
    pendingAutoSkipKey = null;
  }
  signal.addEventListener("abort", cancelScheduledAutoSkip, { once: true });

  function normalizeSkipTarget(time: number): number {
    const dur = video.duration;
    if (isFinite(dur) && dur > 0 && time >= dur - AUTO_SKIP_EPSILON_SECONDS) {
      return Math.max(0, dur - AUTO_SKIP_EPSILON_SECONDS);
    }
    return Math.max(0, time);
  }

  function skipTo(time: number): void {
    cancelScheduledAutoSkip();
    video.currentTime = normalizeSkipTarget(time);
  }

  function scheduleAutoSkip(
    kind: "opening" | "ending",
    seg: { start: number; end: number },
    currentTime: number,
  ): void {
    const target = normalizeSkipTarget(seg.end);
    if (target <= currentTime + AUTO_SKIP_EPSILON_SECONDS) return;

    const dur = video.duration;
    const nearEndEntry =
      kind === "ending" &&
      isFinite(dur) &&
      dur > 0 &&
      dur - currentTime <= AUTO_SKIP_NEAR_END_WINDOW_SECONDS;
    const delaySeconds = nearEndEntry
      ? AUTO_SKIP_NEAR_END_GRACE_SECONDS
      : 0;
    const key = `${kind}:${seg.start}:${seg.end}:${target}:${delaySeconds}`;
    if (pendingAutoSkipKey === key) return;

    cancelScheduledAutoSkip();
    pendingAutoSkipKey = key;
    const ac = new AbortController();
    autoSkipAc = ac;
    const timer = setTimeout(() => {
      if (ac.signal.aborted) return;
      autoSkipAc = null;
      pendingAutoSkipKey = null;
      const t = video.currentTime;
      if (t >= seg.start && t < seg.end) video.currentTime = target;
    }, delaySeconds * 1000);
    ac.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
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
      { once: true, signal },
    );

  video.addEventListener("seeking", cancelScheduledAutoSkip, { signal });
  video.addEventListener("ended", cancelScheduledAutoSkip, { signal });

  video.addEventListener("timeupdate", () => {
    const t = video.currentTime;
    let inAnySkipRange = false;
    if (markers!.opening) {
      const { start, end } = markers!.opening;
      const inSeg = t >= start && t < end;
      inAnySkipRange ||= inSeg;
      btnOpen.classList.toggle("visible", inSeg);
      if (inSeg && autoSkip) scheduleAutoSkip("opening", markers!.opening, t);
    } else {
      btnOpen.classList.remove("visible");
    }
    if (markers!.ending) {
      const { start, end } = markers!.ending;
      const inSeg = t >= start && t < end;
      inAnySkipRange ||= inSeg;
      const endingWindow = parseFloat(localStorage.getItem("player_ending_skip_window") ?? "10");
      const inWindow = endingWindow < 0 || (endingWindow > 0 && t - start < endingWindow);
      btnEnd.classList.toggle("visible", inSeg && inWindow);
      if (inSeg && autoSkip) scheduleAutoSkip("ending", markers!.ending, t);
    } else {
      btnEnd.classList.remove("visible");
    }
    if (!inAnySkipRange || !autoSkip) cancelScheduledAutoSkip();
  }, { signal });
  btnOpen.onclick = () => {
    if (markers!.opening) skipTo(markers!.opening.end);
  };
  btnEnd.onclick = () => {
    if (markers!.ending) skipTo(markers!.ending.end);
  };
}

(function setupTimeline() {
  const video = document.getElementById("v") as HTMLVideoElement;
  const bar = document.getElementById("timeline-bar")!;
  const progress = document.getElementById("timeline-progress") as HTMLElement;
  applyTimelineBarVisibility();

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
    if (wasPlaying) video.play().catch((err) => console.error("[PLAYER] timeline resume play failed:", err));
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

(function setupTimeSync() {
  const video = document.getElementById("v") as HTMLVideoElement;
  const _tParam = params.get("t");
  const startT =
    _tParam !== null
      ? (parseShareTime(_tParam) ?? 0)
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

function shouldResetNearEndProgress(epId: string | number): boolean {
  if (!autoSkip) return false;
  const progress = WatchHistory.getProgress(String(epId));
  const savedT = Number(progress?.t ?? 0);
  const savedDur = Number(progress?.dur ?? 0);
  return savedT >= 1 && savedDur > 1 && savedT >= savedDur - 1;
}

async function buildEpUrl(id: string | number, opts?: { resetNearEndProgress?: boolean }): Promise<string | null> {
  try {
    const info = await apiFetch<{ dash_url?: string; keys?: Array<{ key_id?: string; key?: string }> }>(`/api/episodes/v3/${id}/video`);
    if (!info.dash_url) return null;
    const localDash = rewriteCDN(info.dash_url);
    const key = info.keys?.[0] ?? {};
    let url = `player.html#epId=${id}&mpd=${encodeURIComponent(localDash)}&kid=${key.key_id ?? ""}&key=${key.key ?? ""}`;
    if (_currentItemId) url += `&itemId=${_currentItemId}`;
    if (opts?.resetNearEndProgress && shouldResetNearEndProgress(id)) url += "&t=0";
    return url;
  } catch (e) {
    console.error("[PLAYER] build episode URL failed:", e);
    return null;
  }
}

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

  function navigateToBuiltUrl(url: string): void {
    const hashIdx = url.indexOf("#");
    if (hashIdx !== -1) {
      const newHash = url.substring(hashIdx + 1);
      if (location.hash !== "#" + newHash) {
        location.hash = newHash;
      } else {
        console.log("[PLAYER] Hash identical, forcing re-route");
        window.dispatchEvent(new HashChangeEvent("hashchange"));
      }
    } else {
      location.href = url;
    }
  }

  async function navigate(id: string | number): Promise<void> {
    const url = await buildEpUrl(id, { resetNearEndProgress: true }).catch((e: Error) => {
      console.error("buildEpUrl:", e);
      return null;
    });
    if (url) {
      navigateToBuiltUrl(url);
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
  let autoplayNextTimer: ReturnType<typeof setTimeout> | null = null;
  video._prevWebkitMode = video.webkitPresentationMode ?? "inline";

  function cancelPendingAutoplayNext(): void {
    if (autoplayNextTimer !== null) {
      clearTimeout(autoplayNextTimer);
      autoplayNextTimer = null;
    }
  }
  signal.addEventListener("abort", cancelPendingAutoplayNext, { once: true });

  async function tryAutoplayNext(trigger: string): Promise<void> {
    if (!autoPlay || autoplayTriggered) return;
    console.log(`[PLAYER] tryAutoplayNext triggered by: ${trigger}`);
    if (currentIdx < 0 || currentIdx + 1 >= epList.length) {
      if (epList.length === 0) await loadEpList();
      if (currentIdx < 0 || currentIdx + 1 >= epList.length) {
        pendingPiPAutoNext = false;
        return;
      }
    }
    autoplayTriggered = true;
    const url = await buildEpUrl(
      epList[currentIdx + 1].id,
      { resetNearEndProgress: true },
    ).catch((e: Error) => {
      console.error("buildEpUrl (autoplay):", e);
      return null;
    });
    if (!url) {
      autoplayTriggered = false;
      return;
    }
    pendingPiPAutoNext = false;
    cancelPendingAutoplayNext();
    console.log("[PLAYER] Navigating to next episode:", url);
    navigateToBuiltUrl(url);
  }

  const onErr = (e: unknown) => console.error("tryAutoplayNext:", e);
  function isNearEnd(): boolean {
    const dur = video.duration;
    return isFinite(dur) && dur > 0 && (video.ended || dur - video.currentTime < 2);
  }
  function requestAutoplayNext(trigger: string): void {
    if (!autoPlay || autoplayTriggered || autoplayNextTimer !== null) return;
    const delaySeconds = getAutoPlayDelaySeconds();
    if (delaySeconds <= 0) {
      tryAutoplayNext(trigger).catch(onErr);
      return;
    }
    console.log(`[PLAYER] scheduling autoplay next in ${delaySeconds}s (${trigger})`);
    autoplayNextTimer = setTimeout(() => {
      autoplayNextTimer = null;
      if (!isNearEnd()) return;
      tryAutoplayNext(`${trigger}, delayed ${delaySeconds}s`).catch(onErr);
    }, delaySeconds * 1000);
  }
  video.addEventListener("ended", () => {
    const inPiP =
      document.pictureInPictureElement === video ||
      video.webkitPresentationMode === "picture-in-picture";
    pendingPiPAutoNext = inPiP;
    requestAutoplayNext(inPiP ? "ended event (PiP)" : "ended event");
  }, { signal });
  video.addEventListener("seeking", cancelPendingAutoplayNext, { signal });

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
    } catch (e) {
      console.error("[PLAYER] autoplay buffered range read failed:", e);
      return;
    }

    if (dur - bufferedEnd > 0.2) return;
    if (bufferedEnd - ct > 0.2) return;

    requestAutoplayNext("timeupdate threshold");
  }, { signal });

  function onLeavePiP(): void {
    if (pendingPiPAutoNext || isNearEnd())
      requestAutoplayNext("leave PiP");
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

interface CommentData {
  id: string | number;
  content?: string;
  is_spoiler?: boolean;
  is_click_like?: boolean;
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
      `<span class="ts-btn" data-t="${parseTsSecs(ts)}" role="button" tabindex="0">${ts}</span>`,
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
  const canExtAct = isExtEnabled() && isExtLoggedIn();
  const avatarHtml = c.profile?.image && !manualCommentThumbs
    ? `<img class="comment-avatar" src="${esc(rewriteCDN(c.profile.image))}" alt="" loading="lazy">`
    : `<div class="comment-avatar"></div>`;
  const dateHtml = c.created
    ? `<span class="comment-date" data-ts="${esc(c.created)}">${fmtTs(c.created)}</span>`
    : "";
  const likesHtml =
    canExtAct
      ? `<button class="comment-like-btn${c.is_click_like ? " active" : ""}" data-liked="${c.is_click_like ? "yes" : "no"}" aria-pressed="${c.is_click_like ? "true" : "false"}">♥ ${(c.count_like ?? 0).toLocaleString()}</button>`
      : ((c.count_like ?? 0) > 0 ? `<span class="comment-likes">♥ ${(c.count_like ?? 0).toLocaleString()}</span>` : "");
  const repliesHtml =
    !isReply && ((c.count_reply_comment ?? 0) > 0 || canExtAct)
      ? `<button class="comment-replies-btn">답글 ${(c.count_reply_comment ?? 0).toLocaleString()}개</button>`
      : "";

  const copyBtnHtml = `<button class="link-copy-btn comment-copy-btn" title="링크 복사" aria-label="댓글 링크 복사">🔗</button>`;
  const myName = getMyName();
  const isMine = !!myName && c.profile?.name === myName;
  const myActionsHtml = (canExtAct && isMine)
    ? `<button class="ext-action-btn" data-action="edit-comment">수정</button><button class="ext-action-btn ext-action-del" data-action="del-comment">삭제</button>`
    : "";

  el.innerHTML = `
	<div class="comment-header">${avatarHtml}<span class="comment-user">${esc(c.profile?.name ?? "익명")}</span></div>
	${buildCommentTextHtml(c.content, isSpoiler)}
	<div class="comment-footer">${likesHtml}${repliesHtml}${dateHtml}${copyBtnHtml}${myActionsHtml}</div>
	${!isReply ? `<div class="replies"></div>` : ""}`;

  if (isMine) {
    el.querySelector("[data-action='edit-comment']")?.addEventListener("click", () => {
      openCommentEdit(el, c);
    });
    el.querySelector("[data-action='del-comment']")?.addEventListener("click", async () => {
      if (!confirm("댓글을 삭제할까요?")) return;
      const res = await extSend({ type: "api", method: "DELETE", path: `/comments/v1/${c.id}/`, statusOnly: true });
      if (res?.ok || res?.status === 204) {
        el.remove();
      } else {
        alert("삭제 실패: " + (res?.error ?? res?.status ?? "알 수 없는 오류"));
      }
    });
  }

  const likeBtn = el.querySelector(".comment-like-btn") as HTMLButtonElement | null;
  if (likeBtn) {
    likeBtn.addEventListener("click", async () => {
      const currentlyLiked = likeBtn.dataset["liked"] === "yes";
      const nextLiked = !currentlyLiked;
      c.is_click_like = nextLiked;
      c.count_like = Math.max(0, (c.count_like ?? 0) + (nextLiked ? 1 : -1));
      likeBtn.dataset["liked"] = nextLiked ? "yes" : "no";
      likeBtn.classList.toggle("active", nextLiked);
      likeBtn.setAttribute("aria-pressed", nextLiked ? "true" : "false");
      likeBtn.textContent = `♥ ${(c.count_like ?? 0).toLocaleString()}`;
      likeBtn.disabled = true;
      void extSend({
        type: "api",
        method: "PATCH",
        path: `/comments/v1/${c.id}/like/`,
        body: JSON.stringify({ is_active: nextLiked }),
      }).catch((e) => console.error("comment like failed:", e));
      likeBtn.disabled = false;
    });
  }

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
      rNextCursor: string | null = null,
      rLoading = false,
      rOpened = false,
      rDeepLinked = false;

    function updateRepliesButtonText(): void {
      repliesBtn!.textContent = `답글 ${(c.count_reply_comment ?? 0).toLocaleString()}개`;
    }

    function ensureReplyComposer(): HTMLDivElement {
      let wrap = repliesContainer.querySelector(".ext-reply-wrap") as HTMLDivElement | null;
      if (wrap) return wrap;
      wrap = document.createElement("div");
      wrap.className = "ext-reply-wrap";
      wrap.innerHTML = `
<textarea class="ext-textarea ext-reply-content" rows="2" placeholder="답글 작성..."></textarea>
<div class="ext-form-row">
  <label class="ext-spoiler-label"><input type="checkbox" class="ext-reply-spoiler"> 스포일러</label>
  <button class="ext-action-btn ext-reply-submit">등록</button>
  <span class="ext-err ext-reply-err"></span>
</div>`;
      repliesContainer.prepend(wrap);
      const submitBtn = wrap.querySelector(".ext-reply-submit") as HTMLButtonElement;
      submitBtn.addEventListener("click", async () => {
        const contentEl = wrap!.querySelector(".ext-reply-content") as HTMLTextAreaElement;
        const spoilerEl = wrap!.querySelector(".ext-reply-spoiler") as HTMLInputElement;
        const errEl = wrap!.querySelector(".ext-reply-err") as HTMLElement;
        const content = contentEl.value.trim();
        if (!content) {
          errEl.textContent = "내용을 입력하세요.";
          return;
        }
        submitBtn.disabled = true;
        errEl.textContent = "";
        const res = await extSend({
          type: "api",
          method: "POST",
          path: "/comments/v1/list/",
          body: JSON.stringify({
            episode: epId ? Number(epId) : undefined,
            parent_comment: Number(c.id),
            content,
            is_spoiler: spoilerEl.checked,
          }),
        });
        if (res?.ok) {
          contentEl.value = "";
          spoilerEl.checked = false;
          errEl.textContent = "등록 시도 완료";
          c.count_reply_comment = (c.count_reply_comment ?? 0) + 1;
          updateRepliesButtonText();
          if (!rOpened) repliesBtn!.click();
          if (!rLoading) {
            rOffset = 0;
            rTotal = Infinity;
            repliesContainer.querySelectorAll(".reply, .reply-load-more, .reply-prev-btn").forEach((node) => node.remove());
            void fetchReplies();
          }
        } else {
          errEl.textContent = "실패: " + (res?.error ?? res?.status ?? "알 수 없는 오류");
        }
        submitBtn.disabled = false;
      });
      return wrap;
    }

    async function fetchReplies(): Promise<void> {
      if (rLoading || (rNextCursor === null && rOffset >= rTotal)) return;
      rLoading = true;
      repliesBtn!.textContent = "로딩 중...";
      try {
        if (seekReplyId && !rDeepLinked) {
          rDeepLinked = true;
          try {
            const pos = await apiFetch<{ offset?: number }>(
              `/api/comments/v1/reply-position?parent_comment_id=${c.id}&id=${seekReplyId}`,
            ).catch((e: Error) => {
              console.error("[PLAYER] reply position fetch failed:", e);
              return null;
            });
            if (pos?.offset != null) {
              const pageStart = Math.floor(pos.offset / REPLY_PAGE) * REPLY_PAGE;
              if (pageStart > 0) {
                rOffset = pageStart;
                rNextCursor = null;
                const prev = document.createElement("button");
                prev.className = "load-prev-btn reply-prev-btn";
                prev.textContent = `이전 답글 ${pageStart}개 보기`;
                prev.onclick = () => {
                  prev.remove();
                  rOffset = 0;
                  rTotal = Infinity;
                  rNextCursor = null;
                  rDeepLinked = true;
                  repliesContainer.innerHTML = "";
                  fetchReplies();
                };
                repliesContainer.before(prev);
              }
            }
          } catch (e) { console.error("[PLAYER] deep-link reply setup failed:", e); }
        }
        const fetchUrl = rNextCursor
          ? `/api${new URL(rNextCursor).pathname}${new URL(rNextCursor).search}`
          : `/api/comments/v1/list?parent_comment_id=${c.id}&sorting=oldest&offset=${rOffset}&limit=${REPLY_PAGE}`;
        const data = await fetchCommentListRoute<{ results?: CommentData[]; count?: number; next?: string | null }>(fetchUrl);
        const replies = data.results ?? [];
        if (data.count != null) {
          rTotal = c.count_reply_comment ?? data.count;
          rNextCursor = null;
        } else if (data.next) {
          rNextCursor = data.next;
          if (!Number.isFinite(rTotal)) rTotal = c.count_reply_comment ?? Infinity;
        } else {
          rNextCursor = null;
          if (!Number.isFinite(rTotal)) rTotal = rOffset + replies.length;
        }
        repliesContainer.querySelector(".reply-load-more")?.remove();
        for (const r of replies)
          repliesContainer.appendChild(
            buildCommentEl(r, true, c.id, getSorting),
          );
        rOffset += replies.length;
        const rHasMore = rNextCursor !== null || rOffset < rTotal;
        if (rHasMore) {
          const more = document.createElement("button");
          more.className = "comments-load-more reply-load-more";
          more.textContent = Number.isFinite(rTotal)
            ? `답글 더 보기 (${rTotal - rOffset}개 남음)`
            : "답글 더 보기";
          more.addEventListener("click", fetchReplies);
          repliesContainer.appendChild(more);
        }
        c.count_reply_comment = Math.max(c.count_reply_comment ?? 0, Number.isFinite(rTotal) ? rTotal : rOffset);
        updateRepliesButtonText();
        if (seekReplyId && rHasMore &&
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
      if (canExtAct) ensureReplyComposer();
      if (!isOpen || rOpened) return;
      rOpened = true;
      fetchReplies();
    });
    if (canExtAct) ensureReplyComposer();
    updateRepliesButtonText();
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
    nextCursor: string | null = null,
    loading = false,
    deepLinked = false,
    cHighlighted = false;

  void fetchCommentCountRoute(epId).then((count) => {
    if (loadToken !== activeCommentsLoadToken || count == null) return;
    total = count;
    toggle.textContent = `댓글 ${count.toLocaleString()}개`;
  }).catch((e) => {
    console.error("[PLAYER] comment count fetch failed:", e);
  });

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
    video.play().catch((err) => console.error("[PLAYER] comment seek play failed:", err));
    document
      .getElementById("video-box")!
      .scrollIntoView({ behavior: "smooth", block: "start" });
  };
  list.onkeydown = (e) => {
    const btn = (e.target as Element).closest(".ts-btn") as HTMLElement | null;
    if (!btn) return;
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    btn.click();
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
    nextCursor = null;
    loading = false;
    deepLinked = false;
    cHighlighted = false;
    if (io) { io.disconnect(); io = null; }
    sentinel.remove();
    list.innerHTML = "";
    document.getElementById("comments-prev-btn")?.remove();
  }

  onLayoutChange = () => {
    if (!sentinel.isConnected || (nextCursor === null && offset >= total)) return;
    setupIO();
  };

  async function fetchPage(): Promise<void> {
    if (loadToken !== activeCommentsLoadToken) return;
    if (loading || (nextCursor === null && offset >= total)) return;
    loading = true;

    if (targetCid && !deepLinked) {
      deepLinked = true;
      try {
        const pos = await apiFetch<{ offset?: number }>(
          `/api/comments/v1/position?episode_id=${epId}&id=${targetCid}&sorting=${sorting}`,
        ).catch((e: Error) => {
          console.error("[PLAYER] comment position fetch failed:", e);
          return null;
        });
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
      } catch (e) {
        console.error("[PLAYER] deep-link comment position handling failed:", e);
        deepLinked = false;
      }
    }

    try {
      const fetchUrl = nextCursor
        ? `/api${new URL(nextCursor).pathname}${new URL(nextCursor).search}`
        : `/api/comments/v1/list?episode_id=${epId}&offset=${offset}&limit=${PAGE}&sorting=${sorting}`;
      const data = await fetchCommentListRoute<{ results?: CommentData[]; count?: number; next?: string | null }>(fetchUrl);
      if (loadToken !== activeCommentsLoadToken) return;
      const items = data.results ?? [];
      if (data.count != null) {
        total = data.count;
        nextCursor = null;
      } else if (data.next) {
        nextCursor = data.next;
      } else {
        nextCursor = null;
        if (!Number.isFinite(total)) total = offset + items.length;
      }
      if (Number.isFinite(total)) toggle.textContent = `댓글 ${total.toLocaleString()}개`;
      if (offset === 0 && items.length === 0) {
        list.innerHTML =
          '<p id="comments-empty">댓글이 없습니다.</p>';
        return;
      }
      for (const c of items)
        list.appendChild(buildCommentEl(c, false, null, () => sorting,
          (targetRid && String(c.id) === String(targetCid)) ? targetRid : null));
      offset += items.length;
      const hasMore = nextCursor !== null || offset < total;
      if (hasMore) {
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
      if ((nextCursor !== null || offset < total) && sentinel.isConnected) {
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
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function openCommentEdit(el: HTMLElement, comment: CommentData): void {
  const form = document.createElement("div");
  form.className = "ext-edit-form";
  form.innerHTML = `
<textarea class="ext-textarea" rows="3">${esc(comment.content ?? "")}</textarea>
<div class="ext-form-row">
  <label class="ext-spoiler-label"><input type="checkbox" class="ext-spoiler-chk"${comment.is_spoiler ? " checked" : ""}> 스포일러</label>
  <button class="ext-action-btn" data-action="save">저장</button>
  <button class="ext-action-btn" data-action="cancel">취소</button>
  <span class="ext-err"></span>
</div>`;

  el.style.display = "none";
  el.after(form);

  form.querySelector("[data-action='cancel']")?.addEventListener("click", () => {
    form.remove();
    el.style.display = "";
  });

  form.querySelector("[data-action='save']")?.addEventListener("click", async () => {
    const content = (form.querySelector(".ext-textarea") as HTMLTextAreaElement).value.trim();
    const is_spoiler = (form.querySelector(".ext-spoiler-chk") as HTMLInputElement).checked;
    const btn = form.querySelector("[data-action='save']") as HTMLButtonElement;
    const errEl = form.querySelector(".ext-err") as HTMLElement;
    btn.disabled = true; errEl.textContent = "";
    const res = await extSend({
      type: "api", method: "PATCH",
      path: `/comments/v1/${comment.id}/`,
      body: JSON.stringify({ content, is_spoiler: is_spoiler }),
    });
    if (res?.ok) {
      form.remove();
      el.style.display = "";
      comment.content = content;
      comment.is_spoiler = is_spoiler;
      const textEl = el.querySelector(".comment-text");
      if (textEl) textEl.innerHTML = buildCommentTextHtml(content, is_spoiler).replace(/^<div[^>]*>|<\/div>$/g, "");
      showInventoryGuideAfter(el, "반영이 늦으면 라프텔 댓글함에서 다시 확인하거나 수정/삭제할 수 있습니다.");
    } else {
      errEl.textContent = "저장 실패: " + (res?.error ?? res?.status ?? "알 수 없는 오류");
      btn.disabled = false;
    }
  });
}

let extCommentFormEpId: string | null = null;

function setupExtCommentForm(currentEpId: string): void {
  extCommentFormEpId = currentEpId;
  let wrap = document.getElementById("ext-comment-wrap");
  if (!wrap) {
    wrap = document.createElement("div");
    wrap.id = "ext-comment-wrap";
    wrap.innerHTML = `
<div id="ext-comment-form">
  <textarea id="ext-comment-content" class="ext-textarea" rows="2" placeholder="댓글 작성 (라프텔 연동)..."></textarea>
  <div class="ext-comment-toolbar">
    <div class="ext-inventory-inline">${buildInventoryGuideHtml()}</div>
    <div class="ext-comment-actions">
      <label class="ext-spoiler-label"><input type="checkbox" id="ext-comment-spoiler"> 스포일러</label>
      <span class="ext-toolbar-sep">|</span>
      <button class="ext-action-btn" id="ext-comment-submit">등록</button>
    </div>
    <span class="ext-err" id="ext-comment-err"></span>
  </div>
</div>`;
    const list = document.getElementById("comments-list");
    list?.before(wrap);

    document.getElementById("ext-comment-submit")?.addEventListener("click", async () => {
      const content = (document.getElementById("ext-comment-content") as HTMLTextAreaElement).value.trim();
      const is_spoiler = (document.getElementById("ext-comment-spoiler") as HTMLInputElement).checked;
      const btn = document.getElementById("ext-comment-submit") as HTMLButtonElement;
      const errEl = document.getElementById("ext-comment-err")!;
      if (!content) { errEl.textContent = "내용을 입력하세요."; return; }
      btn.disabled = true; errEl.textContent = "";
      const res = await extSend({
        type: "api", method: "POST",
        path: "/comments/v1/list/",
        body: JSON.stringify({ episode: Number(extCommentFormEpId), content, is_spoiler }),
      });
      if (res?.ok) {
        (document.getElementById("ext-comment-content") as HTMLTextAreaElement).value = "";
        errEl.innerHTML = `등록 시도 완료. 반영 여부는 댓글함에서 확인할 수 있습니다. ${buildInventoryGuideHtml("바로 열기")}`;
        btn.disabled = false;
      } else {
        errEl.textContent = "실패: " + (res?.error ?? res?.status ?? "알 수 없는 오류");
        btn.disabled = false;
      }
    });
  } else {
    // epId changed; just update the reference (extCommentFormEpId already updated above)
  }
}

initExt((loggedIn) => {
  if (!loggedIn) return;
  // If episode already loaded, set up the form now
  if (epId) setupExtCommentForm(epId);
});

// Re-setup form when episode changes
// Also update form epId on episode change
window.addEventListener("hashchange", () => {
  const p = new URLSearchParams(location.hash.slice(1));
  const newId = p.get("epId");
  if (newId && newId !== extCommentFormEpId) {
    extCommentFormEpId = newId;
    // setupExtCommentForm is idempotent; re-call to update epId reference
    const existingForm = document.getElementById("ext-comment-wrap");
    if (existingForm) extCommentFormEpId = newId;
  }
});

export {};
