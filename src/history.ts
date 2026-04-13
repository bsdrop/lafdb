import "./pwa";
import { rewriteCdnUrl } from "./shared/cdn";
import { escapeHtmlAttr } from "./shared/text";
import {
  clearAllWatchHistory,
  listWatchHistory,
  normalizeStoredTimestamps,
  removeEpisodeHistory,
  removeItemHistory,
  updateEpisodeHistoryMeta,
  updateItemHistoryMeta,
} from "./watch-history";

const esc = escapeHtmlAttr;

type ItemInfo = {
  name?: string;
  img?: string;
  medium?: string;
  images?: Array<{ img_url?: string; option_name?: string }>;
};

type EpisodeInfo = {
  title?: string;
  subject?: string;
  episode_num?: string | number;
};

const listEl = document.getElementById("history-list") as HTMLDivElement;
const emptyEl = document.getElementById("history-empty") as HTMLDivElement;
const countEl = document.getElementById("history-count") as HTMLSpanElement;
const btnClearAll = document.getElementById("btn-history-clear") as HTMLButtonElement;
const itemCache = new Map<string, ItemInfo>();
const episodeCache = new Map<string, EpisodeInfo>();
const manualThumbs =
  localStorage.getItem("offline_metadata_mode") === "yes" &&
  localStorage.getItem("manual_thumbnail_load") === "yes";

void render();

btnClearAll.addEventListener("click", () => {
  if (!confirm("시청 기록을 모두 삭제할까요?")) return;
  clearAllWatchHistory();
  void render();
});

async function render(): Promise<void> {
  normalizeStoredTimestamps();
  const groups = listWatchHistory();
  countEl.textContent = `작품 ${groups.length}건`;
  emptyEl.hidden = groups.length > 0;
  listEl.innerHTML = "";

  if (groups.length === 0) return;

  const infos = await Promise.all(groups.map((group) => getItemInfo(group.itemId, group.item)));
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    const info = infos[i];
    const episodeInfos = await Promise.all(
      group.progresses.slice(0, 12).map(({ epId, data }) => getEpisodeInfo(epId, data)),
    );
    const card = document.createElement("article");
    card.className = "history-card";

    const thumbSrc = info.img || info.images?.[0]?.img_url || "";
    const thumb = thumbSrc
      ? (manualThumbs
        ? `<button class="history-thumb-manual" type="button" data-thumb="${esc(rewriteCDN(thumbSrc))}">썸네일 불러오기</button>`
        : `<img class="history-thumb-img" src="${esc(rewriteCDN(thumbSrc))}" alt="" loading="lazy">`)
      : `<div class="history-thumb-fallback"></div>`;
    const progress = group.progresses[0]?.data ?? null;
    const progressText = progress
      ? `${fmtTime(Number(progress.t) || 0)} / ${fmtTime(Number(progress.dur) || 0)}`
      : "마지막 위치 없음";
    const latestInfo = episodeInfos[0] ?? null;
    const latestTitle = esc(
      formatEpisodeLabel(group.progresses[0]?.epId ?? group.latestEpisodeId, latestInfo) ||
      group.latestEpisodeTitle ||
      "최근 시청 에피소드",
    );
    const episodeRows = group.progresses
      .slice(0, 12)
      .map(({ epId, data }, index) => {
        const title = esc(formatEpisodeLabel(epId, episodeInfos[index]) || data.episodeTitle || `${epId}화`);
        const watched = fmtTime(Number(data.t) || 0);
        const duration = fmtTime(Number(data.dur) || 0);
        return `
<div class="history-ep-row">
	<a class="history-ep-main" href="/player.html#epId=${esc(epId)}&itemId=${esc(group.itemId)}">
		<span class="history-ep-name">${title}</span>
		<span class="history-ep-progress">${esc(watched)} / ${esc(duration)}</span>
	</a>
	<button class="history-ep-delete" type="button" data-ep-id="${esc(epId)}">삭제</button>
</div>
        `;
      })
      .join("");

    card.innerHTML = `
<a class="history-thumb" href="/item.html#id=${esc(group.itemId)}">${thumb}</a>
<div class="history-body">
	<div class="history-top">
	<div>
			<a class="history-title" href="/item.html#id=${esc(group.itemId)}">${esc(info.name || `작품 ${group.itemId}`)}</a>
			<div class="history-meta">${esc(info.medium || "")}</div>
		</div>
		<button class="history-delete" type="button" data-item-id="${esc(group.itemId)}">삭제</button>
	</div>
	<div class="history-episode">${latestTitle}</div>
	<div class="history-progress">${esc(progressText)}</div>
	<div class="history-actions">
		${group.latestEpisodeId ? `<a class="history-btn primary" href="/player.html#epId=${esc(group.latestEpisodeId)}&itemId=${esc(group.itemId)}">이어서 보기</a>` : ""}
		<a class="history-btn" href="/item.html#id=${esc(group.itemId)}">작품 보기</a>
	</div>
</div>
<div class="history-episodes">
	${episodeRows}
</div>
    `;
    listEl.appendChild(card);
  }

  listEl.querySelectorAll<HTMLButtonElement>(".history-delete").forEach((button) => {
    button.addEventListener("click", () => {
      const itemId = button.dataset.itemId;
      if (!itemId) return;
      if (!confirm("이 작품의 시청 기록을 삭제할까요?")) return;
      removeItemHistory(itemId);
      void render();
    });
  });

  listEl.querySelectorAll<HTMLButtonElement>(".history-ep-delete").forEach((button) => {
    button.addEventListener("click", () => {
      const epId = button.dataset.epId;
      if (!epId) return;
      if (!confirm("이 에피소드의 시청 기록을 삭제할까요?")) return;
      removeEpisodeHistory(epId);
      void render();
    });
  });

  listEl.querySelectorAll<HTMLButtonElement>(".history-thumb-manual").forEach((button) => {
    button.addEventListener("click", () => {
      const src = button.dataset.thumb;
      if (!src) return;
      const img = document.createElement("img");
      img.className = "history-thumb-img";
      img.src = src;
      img.alt = "";
      img.loading = "lazy";
      button.replaceWith(img);
    }, { once: true });
  });
}

async function getItemInfo(itemId: string, cached?: { itemName?: string; itemThumbPath?: string; itemMedium?: string } | null): Promise<ItemInfo> {
  if (itemCache.has(itemId)) return itemCache.get(itemId)!;
  if (cached?.itemThumbPath) {
    const local = {
      name: cached.itemName,
      img: cached.itemThumbPath,
      medium: cached.itemMedium,
    };
    itemCache.set(itemId, local);
    return local;
  }
  try {
    const json = await apiFetch<ItemInfo>(`/api/items/v4/${encodeURIComponent(itemId)}`);
    const thumbPath =
      json.images?.find((image: any) => image.option_name === "home_default")?.img_url ||
      json.images?.[0]?.img_url ||
      json.img;
    const merged = {
      ...json,
      name: json.name || cached?.itemName,
      img: thumbPath || cached?.itemThumbPath,
      medium: json.medium || cached?.itemMedium,
    };
    updateItemHistoryMeta(itemId, {
      itemName: merged.name,
      itemThumbPath: thumbPath,
      itemMedium: merged.medium,
    });
    itemCache.set(itemId, merged);
    return merged;
  } catch (_err) {
    const fallback: ItemInfo = {
      name: cached?.itemName,
      img: cached?.itemThumbPath,
      medium: cached?.itemMedium,
    };
    itemCache.set(itemId, fallback);
    return fallback;
  }
}

async function getEpisodeInfo(epId: string, cached?: { episodeTitle?: string; episodeNum?: string; title?: string } | null): Promise<EpisodeInfo> {
  if (episodeCache.has(epId)) return episodeCache.get(epId)!;
  if (cached?.episodeTitle || cached?.episodeNum) {
    const local = {
      subject: cached.episodeTitle ?? cached.title,
      episode_num: cached.episodeNum,
    };
    episodeCache.set(epId, local);
    return local;
  }
  try {
    const json = await apiFetch<EpisodeInfo>(`/api/episodes/v3/${encodeURIComponent(epId)}`);
    updateEpisodeHistoryMeta(epId, {
      episodeTitle: String(json.subject ?? json.title ?? "").trim() || undefined,
      episodeNum: String(json.episode_num ?? "").trim() || undefined,
    });
    episodeCache.set(epId, json);
    return json;
  } catch (_err) {
    const fallback: EpisodeInfo = {};
    episodeCache.set(epId, fallback);
    return fallback;
  }
}

function rewriteCDN(url: string): string {
  return rewriteCdnUrl(url);
}

function fmtTime(total: number): string {
  if (!Number.isFinite(total) || total <= 0) return "0:00";
  const sec = Math.floor(total);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

function formatEpisodeLabel(epId: string, info: EpisodeInfo | null | undefined): string {
  const title = String(info?.subject ?? info?.title ?? "").trim();
  const episodeNum = String(info?.episode_num ?? "").trim();
  if (episodeNum && title) return `${episodeNum}화 ${title}`;
  if (title) return title;
  if (episodeNum) return `${episodeNum}화`;
  return epId ? `에피소드 ${epId}` : "";
}
