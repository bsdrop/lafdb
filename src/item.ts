import { escapeHtml } from "./shared/text";
import { formatDateTimeKo, formatRelativeTimeKo, formatRuntimeKo } from "./shared/time";
import { rewriteCdnUrl } from "./shared/cdn";
import { WatchHistory, updateItemHistoryMeta } from "./watch-history";
import { ensureExtStatus, extSend, getExtRoute, getMyName, initExt, isExtEnabled, isExtLoggedIn } from "./shared/ext";

if (localStorage.getItem("cv_auto") === "yes") document.body.classList.add("cv-auto");
function getRouteParams() {
	const params = new URLSearchParams(location.hash.slice(1));
	return {
		itemId: params.get("id"),
		targetReviewId: params.get("review"),
		reviewSorting: params.get("sorting"),
	};
}

let { itemId, targetReviewId, reviewSorting } = getRouteParams();
const manualThumbs =
	localStorage.getItem("offline_metadata_mode") === "yes" &&
	localStorage.getItem("manual_thumbnail_load") === "yes";

interface SentinelElement extends HTMLDivElement {
	_load?: () => void;
}

function attachManualThumb(el: HTMLElement | null, src: string | null, text = "썸네일 불러오기") {
	if (!el || !src) return;
	el.dataset["thumb"] = src;
	el.textContent = text;
	el.setAttribute("aria-label", text);
	const canBeKeyboardButton = !el.closest("a");
	if (canBeKeyboardButton) {
		el.setAttribute("role", "button");
		el.setAttribute("tabindex", "0");
	}
	let loaded = false;
	const loadThumb = (e: MouseEvent | KeyboardEvent) => {
		e.preventDefault();
		e.stopPropagation();
		if (loaded) return;
		loaded = true;
		const target = e.currentTarget as HTMLElement | null;
		if (!target) return;
		if (target.id === "item-thumb") {
			const img = document.createElement("img");
			img.id = "item-thumb";
			img.className = target.className.replace("item-thumb-manual", "").trim();
			img.src = src;
			img.alt = "";
			img.loading = "lazy";
			img.style.cssText =
				"width:120px;height:170px;border-radius:10px;object-fit:cover;flex-shrink:0;";
			target.replaceWith(img);
			return;
		}
		target.classList.remove("ep-thumb-manual");
		target.textContent = "";
		const img = document.createElement("img");
		img.src = src;
		img.loading = "lazy";
		img.alt = "";
		target.appendChild(img);
	};
	el.addEventListener("click", loadThumb);
	if (canBeKeyboardButton) {
		el.addEventListener("keydown", (e: KeyboardEvent) => {
			if (e.key !== "Enter" && e.key !== " ") return;
			loadThumb(e);
		});
	}
}

// Review state – declared early so the auto-tab click below can use them
// without hitting a temporal dead zone.
const REV_PAGE = 20;
let revOffset = 0,
	revTotal = Infinity,
	revLoading = false;
let revSorting = (targetReviewId && reviewSorting) ? reviewSorting : "like";
let revDeepLinked = false; // true once the position-seek has been done
let revHighlighted = false; // true once the target review has been scrolled to

// Apply initial active sort button state
function syncReviewSortButtons(): void {
	document.querySelectorAll("#rev-sort .sort-btn").forEach((b) => {
		const isActive = (b as HTMLElement).dataset["sorting"] === revSorting;
		b.classList.toggle("active", isActive);
		b.setAttribute("aria-pressed", String(isActive));
	});
}
syncReviewSortButtons();

// ── Tabs ─────────────────────────────────────────────────────────────────────
let reviewsLoaded = false;
function setActiveTab(tab: string | undefined): void {
	document.querySelectorAll<HTMLElement>(".tab").forEach((t) => {
		const selected = t.dataset["tab"] === tab;
		t.classList.toggle("active", selected);
		t.setAttribute("aria-selected", String(selected));
	});
	const episodesPanel = document.getElementById("tab-episodes")!;
	const reviewsPanel = document.getElementById("tab-reviews")!;
	const showEpisodes = tab === "episodes";
	episodesPanel.style.display = showEpisodes ? "" : "none";
	episodesPanel.toggleAttribute("hidden", !showEpisodes);
	reviewsPanel.style.display = tab === "reviews" ? "" : "none";
	reviewsPanel.toggleAttribute("hidden", tab !== "reviews");
}
document.querySelectorAll(".tab").forEach((btn) => {
	btn.addEventListener("click", () => {
		const tab = (btn as HTMLElement).dataset["tab"];
		setActiveTab(tab);
		if (tab === "reviews" && !reviewsLoaded) {
			reviewsLoaded = true;
			loadReviews();
		}
	});
	btn.addEventListener("keydown", (e) => {
		if (!(e instanceof KeyboardEvent)) return;
		if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
		e.preventDefault();
		const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>(".tab"));
		const index = tabs.indexOf(btn as HTMLButtonElement);
		const nextIndex = e.key === "ArrowRight"
			? (index + 1) % tabs.length
			: (index - 1 + tabs.length) % tabs.length;
		tabs[nextIndex]?.focus();
		tabs[nextIndex]?.click();
	});
});

function activateTab(tab: "episodes" | "reviews"): void {
	(document.querySelector(`.tab[data-tab="${tab}"]`) as HTMLElement | null)?.click();
}

// Auto-switch to reviews tab when deep-linking to a review
if (targetReviewId) {
	activateTab("reviews");
}

// ── Utilities ─────────────────────────────────────────────────────────────────
const esc = escapeHtml;
const fmtRuntime = formatRuntimeKo;
const fmtDate = formatDateTimeKo;
const fmtRelTime = formatRelativeTimeKo;

let timePref: string = localStorage.getItem("time_pref") || "relative";
function fmtDateByPref(s: string | null | undefined): string {
	return timePref === "relative" ? fmtRelTime(s) : fmtDate(s);
}
function rerenderDates(): void {
	document
		.querySelectorAll<HTMLElement>(".review-date[data-ts]")
		.forEach((el) => {
			el.textContent = fmtDateByPref(el.dataset["ts"]);
		});
}
// click any date to toggle relative ↔ absolute
document.addEventListener("click", (e) => {
	if (!(e.target as Element).closest(".review-date[data-ts]")) return;
	timePref = timePref === "relative" ? "absolute" : "relative";
	localStorage.setItem("time_pref", timePref);
	rerenderDates();
});

function skelEps(n = 6): void {
	document.getElementById("episodes")!.innerHTML = Array.from(
		{ length: n },
		() => '<div class="ep skel"></div>',
	).join("");
}
function skelRevs(n = 3): void {
	document.getElementById("reviews")!.innerHTML = Array.from(
		{ length: n },
		() => '<div class="review skel"></div>',
	).join("");
}

const EXT_INVENTORY_REVIEW_URL = "https://laftel.net/inventory?category=review";

function apiPathToExtPath(url: string): string {
	const path = url.startsWith("/api/") ? url.slice(4) : url;
	const [pathname, search = ""] = path.split("?", 2);
	const normalizedPath = pathname.endsWith("/") ? pathname : `${pathname}/`;
	return search ? `${normalizedPath}?${search}` : normalizedPath;
}

async function fetchReviewListRoute<T>(url: string): Promise<T> {
	await ensureExtStatus();
	if (isExtEnabled() && isExtLoggedIn() && getExtRoute() === "direct") {
		const res = await extSend({ type: "api", method: "GET", path: apiPathToExtPath(url) });
		if (!res?.ok) throw new Error(res?.error ?? `HTTP ${res?.status ?? "extension"}`);
		return res.data as T;
	}
	return apiFetch<T>(url);
}

function buildInventoryGuideHtml(label = "라프텔 리뷰함"): string {
	return `<a class="ext-action-btn" href="${EXT_INVENTORY_REVIEW_URL}" target="_blank" rel="noreferrer">${label}</a>`;
}

function showInventoryGuideAfter(el: HTMLElement, text: string): void {
	el.nextElementSibling?.classList.contains("ext-inventory-guide") && el.nextElementSibling.remove();
	const guide = document.createElement("div");
	guide.className = "ext-inventory-guide";
	guide.innerHTML = `${esc(text)} ${buildInventoryGuideHtml("수정/삭제하러 가기")}`;
	el.after(guide);
}

function buildReviewBodyHtml(content: string | undefined, isSpoiler: boolean): string {
	const safe = esc(content ?? "").replaceAll("\n", "<br>");
	if (!safe.trim()) return "";
	if (!isSpoiler) return `<p class="review-body">${safe}</p>`;
	return `<p class="review-body"><span class="review-spoiler" role="button" tabindex="0" title="스포일러 — 클릭하여 보기">${safe}</span></p>`;
}

function attachRevealSpoiler(root: ParentNode): void {
	const spoiler = root.querySelector(".review-spoiler");
	if (!spoiler) return;
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

function resetItemView(): void {
	document.title = "라트펠";
	const itemName = document.getElementById("item-name");
	if (itemName) {
		itemName.textContent = "";
		itemName.classList.add("skel");
	}
	const itemMeta = document.getElementById("item-meta");
	if (itemMeta) {
		itemMeta.textContent = "";
		itemMeta.classList.add("skel");
	}
	const itemDesc = document.getElementById("item-desc");
	if (itemDesc) {
		itemDesc.textContent = "";
		itemDesc.classList.add("skel");
		itemDesc.classList.remove("expanded");
	}
	document.getElementById("item-rating")?.remove();
	document.getElementById("item-badges")?.remove();
	const itemStats = document.getElementById("item-stats");
	if (itemStats) {
		itemStats.innerHTML = "";
		itemStats.classList.remove("show");
	}
	const seriesBar = document.getElementById("series-bar");
	if (seriesBar) {
		seriesBar.innerHTML = "";
		seriesBar.classList.remove("show");
	}
	const thumb = document.getElementById("item-thumb");
	if (thumb && thumb.tagName !== "DIV") {
		const div = document.createElement("div");
		div.id = "item-thumb";
		div.className = "skel";
		thumb.replaceWith(div);
	} else if (thumb) {
		thumb.className = "skel";
		thumb.textContent = "";
	}
	document.getElementById("episodes")!.innerHTML = "";
	document.getElementById("reviews")!.innerHTML = "";
	document.getElementById("rev-prev-btn")?.remove();
	updateSentinel("ep-sentinel", false, loadEpisodes);
	updateSentinel("rev-sentinel", false, loadReviews);
}

// ── Item info ─────────────────────────────────────────────────────────────────
async function loadItem(): Promise<void> {
	if (!itemId) {
		document.getElementById("item-name")!.textContent =
			"항목을 찾을 수 없습니다.";
		return;
	}
	skelEps();

	try {
		const [item, stats] = await Promise.all([
			apiFetch<any>(`/api/items/v4/${itemId}`).catch((err: any) => { console.error("item fetch failed:", err); return null; }),
			apiFetch<any>(`/api/items/v1/${itemId}/statistics/`).catch((err: any) => { console.error("stats fetch failed:", err); return null; }),
		]);

		if (!item) {
			document.getElementById("item-name")!.textContent =
				"불러오기에 실패하였습니다.";
			return;
		}

		document.title = item.name ?? "";

		// thumbnail
		const thumbEl = document.getElementById("item-thumb")!;
		const thumbUrl =
			item.images?.find((i: any) => i.option_name === "home_default")
				?.img_url ??
			item.images?.[0]?.img_url ??
			"";
		updateItemHistoryMeta(String(itemId), {
			itemName: item.name ?? undefined,
			itemThumbPath: thumbUrl || undefined,
			itemMedium: item.medium ?? undefined,
		});
		thumbEl.classList.remove("skel");
		if (thumbUrl) {
			if (manualThumbs) {
				thumbEl.classList.add("item-thumb-manual");
				attachManualThumb(thumbEl as HTMLElement, thumbUrl);
			} else {
				const img = document.createElement("img");
				img.id = "item-thumb";
				img.className = thumbEl.className;
				img.src = thumbUrl;
				img.alt = "";
				img.loading = "lazy";
				img.style.cssText =
					"width:120px;height:170px;border-radius:10px;object-fit:cover;flex-shrink:0;";
				thumbEl.replaceWith(img);
			}
		}

		// name
		const nameEl = document.getElementById("item-name")!;
		nameEl.classList.remove("skel");
		nameEl.textContent = item.name ?? "";

		// meta
		const metaEl = document.getElementById("item-meta")!;
		metaEl.classList.remove("skel");
		const parts = [];
		if (item.medium) parts.push(item.medium);
		if (item.air_year_quarter) parts.push(item.air_year_quarter);
		const directors = (item.directors ?? [])
			.map((d: any) => d.name)
			.filter(Boolean);
		if (directors.length)
			parts.push("감독: " + directors.join(", "));
		const companies = (item.production_companies ?? [])
			.map((c: any) => c.name)
			.filter(Boolean);
		if (companies.length) parts.push(companies.join(", "));
		metaEl.textContent = parts.join(" · ");

		// badges + rating
		const infoEl = document.getElementById("item-info")!;
		if (item.avg_rating) {
			const r =
				document.getElementById("item-rating") ||
				document.createElement("div");
			r.id = "item-rating";
			r.textContent = "★ " + item.avg_rating.toFixed(1);
			infoEl.insertBefore(r, metaEl);
		}
		const genres = item.genre ?? [];
		const badges = document.createElement("div");
		badges.id = "item-badges";
		badges.style.cssText = "display:flex;flex-wrap:wrap;gap:6px;";
		for (const g of genres.slice(0, 4)) {
			const b = document.createElement("span");
			b.className = "badge";
			b.textContent = g as string;
			badges.appendChild(b);
		}
		if (item.is_laftel_original) {
			const b = document.createElement("span");
			b.className = "badge exclusive";
			b.textContent = "독점";
			badges.appendChild(b);
		}
		if (item.is_ending) {
			const b = document.createElement("span");
			b.className = "badge";
			b.textContent = "완결";
			badges.appendChild(b);
		}
		if (item.is_new_release) {
			const b = document.createElement("span");
			b.className = "badge accent";
			b.textContent = "신작";
			badges.appendChild(b);
		}
		infoEl.appendChild(badges);

		// description
		const descEl = document.getElementById("item-desc")!;
		descEl.classList.remove("skel");
		descEl.textContent = item.description ?? item.synopsis ?? "";
		descEl.addEventListener("click", () =>
			descEl.classList.toggle("expanded"),
		);

		// statistics
		if (stats && stats.count_score > 0) {
			renderStats(stats);
		}

		// series
		const sid = item.series_id ?? item.seriesId;
		if (sid) loadSeries(sid);

		loadEpisodes();
	} catch (e) {
		console.error("loadItem failed:", e);
		document.getElementById("item-name")!.textContent = "불러오기에 실패하였습니다.";
	}
}

// ── Statistics ────────────────────────────────────────────────────────────────
function renderStats(stats: any): void {
	const el = document.getElementById("item-stats")!;
	const levels = [5, 10, 15, 20, 25, 30, 35, 40, 45, 50];
	const counts = levels.map(
		(k) =>
			stats[`count_score_${String(k).padStart(2, "0")}`] || 0,
	);
	const maxCnt = Math.max(...counts, 1);
	const chartH = 138; // px — bar area height (excl. label)

	const barsHtml = levels
		.map((k, i) => {
			const cnt = counts[i];
			const h = Math.round((cnt / maxCnt) * chartH);
			const label = (k / 10).toFixed(1);
			const tip = `★${label}	${cnt.toLocaleString()}명`;
			return (
				`<div class="vbar-col" data-tip="${esc(tip)}">` +
				`<div class="vbar-fill" style="height:${h}px"></div>` +
				`<span class="vbar-lbl">${label}</span>` +
				`</div>`
			);
		})
		.join("");

	const avg =
		typeof stats.average_score === "number"
			? stats.average_score.toFixed(1)
			: stats.average_score;
	el.innerHTML = `
<div class="stats-summary">
<span class="stats-star">★</span>
<span class="stats-avg">${esc(String(avg))}</span>
<span class="stats-meta">${Number(stats.count_score).toLocaleString()}명</span>
</div>
<div class="stats-vchart">${barsHtml}</div>`;
	el.classList.add("show");
}

// ── Series ────────────────────────────────────────────────────────────────────
async function loadSeries(sid: string | number): Promise<void> {
	try {
		const data = await apiFetch<any>(`/api/items/v2/series/${sid}`);
		const items = Array.isArray(data)
			? data
			: (data?.results ?? []);
		if (items.length < 2) return;
		const bar = document.getElementById("series-bar")!;
		bar.classList.add("show");
		bar.innerHTML = "";
		for (const s of items) {
			const link = document.createElement("a");
			link.className =
				"series-btn" +
				(String(s.id) === String(itemId) ? " active" : "");
			link.textContent = s.name ?? s.title ?? s.id;
			link.href = `item.html#id=${s.id}`;
			link.addEventListener("click", (e: MouseEvent) => {
				if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
				e.preventDefault();
				location.href = link.href;
			});
			bar.appendChild(link);
		}
	} catch (e) {
		console.error("series fetch failed:", e);
	}
}

// ── Episodes ──────────────────────────────────────────────────────────────────
const EP_PAGE = 30;
let epOffset = 0,
	epTotal = Infinity,
	epLoading = false;
let epSort = "oldest";

// apply saved sort button state
document.querySelectorAll("#ep-sort .sort-btn").forEach((b) => {
	const isActive = (b as HTMLElement).dataset["sort"] === epSort;
	b.classList.toggle("active", isActive);
	b.setAttribute("aria-pressed", String(isActive));
});

async function loadEpisodes(reset = false): Promise<void> {
	if (reset) {
		epOffset = 0;
		epTotal = Infinity;
		epLoading = false;
	}
	if (epLoading || epOffset >= epTotal) return;
	epLoading = true;
	if (epOffset === 0) skelEps();

	try {
		const data = await apiFetch<any>(
			`/api/episodes/v3/list?item_id=${itemId}&offset=${epOffset}&limit=${EP_PAGE}&sort=${epSort}`,
		);
		const items = data.results ?? [];
		epTotal = data.count ?? items.length;

		const container = document.getElementById("episodes")!;
		if (epOffset === 0) container.innerHTML = "";

		if (items.length === 0 && epOffset === 0) {
			container.innerHTML =
				'<p id="status-msg">에피소드가 없습니다.</p>';
			return;
		}

		for (const ep of items) {
			const div = document.createElement("a");
			div.className = "ep";
			div.href = `/player.html#epId=${ep.id}`;
			div.onclick = (e) => {
				if (e.ctrlKey || e.metaKey || e.button === 1) return;
				e.preventDefault();
				play(ep.id);
			};
			const canPlay =
				((window as any).isAccessibleEpisode?.(ep.id) ?? false) ||
				(ep.is_free ?? false);
			const badgeClass = canPlay ? "ok" : "no";
			const badgeText = canPlay ? "재생 가능" : "재생 불가";
			const runtime = fmtRuntime(ep.running_time);
			div.innerHTML = `
<div class="ep-thumb-wrap">
	<div class="ep-thumb ${manualThumbs && ep.thumbnail_path ? "ep-thumb-manual" : ""}">${ep.thumbnail_path ? (manualThumbs ? "썸네일 불러오기" : "") : "▶"}</div>
	${runtime ? `<span class="ep-runtime">${runtime}</span>` : ""}
</div>
<span class="ep-num">${esc(ep.episode_num ?? ep.episode_order ?? "")}</span>
<span class="ep-title">${esc(ep.subject ?? ep.title ?? "Untitled")}</span>
<span class="ep-badge ${badgeClass}">${badgeText}</span>`;

			const thumbWrap = div.querySelector(".ep-thumb-wrap")!;
			const thumb = div.querySelector(".ep-thumb") as HTMLElement;

			if (ep.thumbnail_path && !manualThumbs) {
				const img = document.createElement("img");
				img.src = ep.thumbnail_path;
				img.loading = "lazy";
				img.alt = "";
				thumb.appendChild(img);
			} else if (ep.thumbnail_path && manualThumbs) {
				attachManualThumb(thumb, ep.thumbnail_path);
			}

			const hist = WatchHistory.getProgress(String(ep.id));
			const histT = Number(hist?.t ?? 0);
			const histDur = Number(hist?.dur ?? 0);
			if (histT > 0 && histDur > 0) {
				const pct = Math.min(100, Math.round(histT / histDur * 100));
				const bar = document.createElement("div");
				bar.className = "ep-progress";
				bar.innerHTML = `<div class="ep-progress-bar" style="width:${pct}%"></div>`;
				thumbWrap.appendChild(bar);
			}

			container.appendChild(div);
		}

		epOffset += items.length;
		updateSentinel(
			"ep-sentinel",
			epOffset < epTotal,
			loadEpisodes,
		);
	} catch (e) {
		console.error("loadEpisodes failed:", e);
		if (epOffset === 0)
			document.getElementById("episodes")!.innerHTML =
				'<p id="status-msg">에피소드를 불러올 수 없습니다.</p>';
	} finally {
		epLoading = false;
		// If the viewport isn't filled yet, trigger next page load automatically.
		if (epOffset < epTotal) {
			const el = document.getElementById("ep-sentinel");
			if (el && el.getBoundingClientRect().top < window.innerHeight + 300) {
				setTimeout(() => void loadEpisodes(), 50);
			}
		}
	}
}

document
	.getElementById("ep-sort")
	?.addEventListener("click", (e) => {
		const btn = (e.target as Element | null)?.closest<HTMLButtonElement>(".sort-btn[data-sort]");
		if (!btn || btn.classList.contains("active")) return;
		document
			.querySelectorAll("#ep-sort .sort-btn")
			.forEach((b) => {
				b.classList.remove("active");
				b.setAttribute("aria-pressed", "false");
			});
		btn.classList.add("active");
		btn.setAttribute("aria-pressed", "true");
		epSort = btn.dataset["sort"] || "oldest";
		updateSentinel("ep-sentinel", false, loadEpisodes);
		loadEpisodes(true);
	});

// ── Reviews ───────────────────────────────────────────────────────────────────
// (revOffset, revTotal, revLoading, revSorting, REV_PAGE declared at top)

async function loadReviews(reset = false): Promise<void> {
	if (reset) {
		revOffset = 0;
		revTotal = Infinity;
		revLoading = false;
		revDeepLinked = false;
		revHighlighted = false;
	}
	if (revLoading || revOffset >= revTotal) return;

	// Deep-link: look up target review's page via position API (runs once)
	if (targetReviewId && !revDeepLinked) {
		revDeepLinked = true;
		try {
			const pos = await apiFetch<any>(
				`/api/reviews/v2/position?item_id=${itemId}&id=${targetReviewId}&sorting=${revSorting}`,
			).catch(() => null);
			if (pos?.offset != null) {
				const pageStart =
					Math.floor(pos.offset / REV_PAGE) * REV_PAGE;
				if (pageStart > 0) {
					revOffset = pageStart;
					// Show "load previous" button above reviews
					const prev = document.createElement("button");
					prev.id = "rev-prev-btn";
					prev.className = "load-prev-btn";
					prev.textContent = `이전 리뷰 ${pageStart}개 보기`;
					prev.onclick = () => {
						prev.remove();
						revOffset = 0;
						revTotal = Infinity;
						revLoading = false;
						revDeepLinked = true; // don't re-seek
						revHighlighted = false;
						document.getElementById("reviews")!.innerHTML = "";
						updateSentinel("rev-sentinel", false, loadReviews);
						loadReviews();
					};
					document
						.getElementById("reviews")!
						.before(prev);
				}
			} else {
				// Position API unavailable (server not updated yet) –
				// fall back to sequential page loading.
				revDeepLinked = false;
			}
		} catch (_) {
			revDeepLinked = false; // retry on next page if position API errors
		}
	}

	revLoading = true;
	if (revOffset === 0) skelRevs();

	try {
		const data = await fetchReviewListRoute<any>(
			`/api/reviews/v2/list?item_id=${itemId}&offset=${revOffset}&limit=${REV_PAGE}&sorting=${revSorting}`,
		);
		const items = data.results ?? [];
		revTotal = data.count ?? items.length;

		const container = document.getElementById("reviews")!;
		if (revOffset === 0) container.innerHTML = "";

		if (items.length === 0 && revOffset === 0) {
			container.innerHTML =
				'<p id="status-msg">리뷰가 없습니다.</p>';
			return;
		}

		for (const r of items) {
			const el = document.createElement("div");
			el.className = "review";
			if (r.id) el.dataset["rid"] = String(r.id);
			const date = fmtDateByPref(r.created);
			const hasScore = r.score > 0;
			const hasContent = (r.content ?? "").trim().length > 0;
			const isSpoiler = !!r.is_spoiler;
			const liked = !!r.is_click_like;

			const avatarHtml = r.profile?.image
				? `<img class="review-avatar" src="${esc(r.profile.image)}" alt="" loading="lazy">`
				: `<div class="review-avatar"></div>`;

			const myName = getMyName();
			const isMine = !!myName && r.profile?.name === myName;
			const myActionsHtml = (isMine && r.id)
				? `<button class="ext-action-btn" data-action="edit-review">수정</button><button class="ext-action-btn ext-action-del" data-action="del-review">삭제</button>`
				: "";

			el.innerHTML = `
<div class="review-header">
	${avatarHtml}
	<span class="review-user">${esc(r.profile?.name ?? "익명")}</span>
	${hasScore ? `<span class="review-score">★ ${Number(r.score).toFixed(1)}</span>` : ""}
</div>
${hasContent ? buildReviewBodyHtml(r.content, isSpoiler) : ""}
<div class="review-footer">
	${r.id ? `<button class="ext-action-btn review-like-btn${liked ? " active" : ""}" data-liked="${liked ? "yes" : "no"}">♥ ${(r.count_like ?? 0).toLocaleString()}</button>` : `${r.count_like > 0 ? `<span class="review-likes">♥ ${r.count_like}</span>` : ""}`}
	${r.created ? `<span class="review-date" data-ts="${esc(r.created)}">${date}</span>` : ""}
	${r.id ? `<button class="link-copy-btn review-copy-btn" title="링크 복사" aria-label="리뷰 링크 복사">🔗</button>` : ""}
	${myActionsHtml}
</div>`;

			if (r.id) {
				const rid = String(r.id);
				const likeBtn = el.querySelector(".review-like-btn") as HTMLButtonElement | null;
				if (likeBtn) {
					likeBtn.addEventListener("click", async () => {
						const currentlyLiked = likeBtn.dataset["liked"] === "yes";
						likeBtn.disabled = true;
						const res = await extSend({
							type: "api",
							method: "PATCH",
							path: `/reviews/v1/${rid}/like/`,
							body: JSON.stringify({ is_active: !currentlyLiked }),
						});
						if (res?.ok) {
							const nextLiked = !currentlyLiked;
							const currentCount = r.count_like ?? 0;
							r.is_click_like = nextLiked;
							r.count_like = Math.max(0, currentCount + (nextLiked ? 1 : -1));
							likeBtn.dataset["liked"] = nextLiked ? "yes" : "no";
							likeBtn.classList.toggle("active", nextLiked);
							likeBtn.textContent = `♥ ${(r.count_like ?? 0).toLocaleString()}`;
						}
						likeBtn.disabled = false;
					});
				}
				el.querySelector(".review-copy-btn")?.addEventListener("click", (e) => {
					e.stopPropagation();
					const sortingPart = revSorting
						? `?sorting=${encodeURIComponent(revSorting)}`
						: "";
					const url = `${location.origin}/review/${rid}${sortingPart}`;
					(window as any).ShareLink?.copy(url, e.currentTarget as HTMLElement, { successText: "✓", resetText: "🔗" });
				});

				if (isMine) {
					el.querySelector("[data-action='edit-review']")?.addEventListener("click", () => {
						openReviewEdit(el, rid, r.score ?? 0, r.content ?? "");
					});
					el.querySelector("[data-action='del-review']")?.addEventListener("click", async () => {
						if (!confirm("리뷰를 삭제할까요?")) return;
						const res = await extSend({ type: "api", method: "DELETE", path: `/reviews/v1/${rid}/`, statusOnly: true });
						if (res?.ok || res?.status === 204) {
							el.remove();
						} else {
							alert("삭제에 실패했습니다: " + (res?.error ?? res?.status ?? "알 수 없는 오류"));
						}
					});
				}
			}
			attachRevealSpoiler(el);
			container.appendChild(el);
		}

		revOffset += items.length;
		updateSentinel(
			"rev-sentinel",
			revOffset < revTotal,
			loadReviews,
		);

		// deep-link: highlight the target review once it's in the DOM
		if (targetReviewId && !revHighlighted) {
			const revEl = container.querySelector(`[data-rid="${targetReviewId}"]`);
			if (revEl) {
				revHighlighted = true;
				(window as any).ShareLink?.highlight(revEl);
			} else if (revOffset < revTotal) {
				// Target not on this page; load next (fallback when position
				// API is unavailable or returned a wrong offset).
				setTimeout(() => loadReviews(), 80);
			}
		}
	} catch (e) {
		console.error("loadReviews failed:", e);
		if (revOffset === 0)
			document.getElementById("reviews")!.innerHTML =
				'<p id="status-msg">리뷰를 불러올 수 없습니다.</p>';
	} finally {
		revLoading = false;
		// If the viewport isn't filled yet, trigger next page load automatically.
		if (revOffset < revTotal) {
			const el = document.getElementById("rev-sentinel");
			if (el && el.getBoundingClientRect().top < window.innerHeight + 300) {
				setTimeout(() => void loadReviews(), 50);
			}
		}
	}
}

document
	.getElementById("rev-sort")!
	.addEventListener("click", (e) => {
		const btn = (e.target as Element).closest(".sort-btn") as HTMLElement | null;
		if (!btn || btn.classList.contains("active")) return;
		revSorting = btn.dataset["sorting"] || "like";
		syncReviewSortButtons();
		updateSentinel("rev-sentinel", false, loadReviews);
		loadReviews(true);
	});

// ── Play ──────────────────────────────────────────────────────────────────────
async function play(epId: string | number): Promise<void> {
	try {
		const info = await apiFetch<any>(`/api/episodes/v3/${epId}/video`);
		if (!info.dash_url) {
			alert("DASH URL이 없습니다.");
			return;
		}
		const localDash = rewriteCdnUrl(info.dash_url ?? "");
		const key = info.keys?.[0] ?? {};
		location.href = `player.html#epId=${epId}&mpd=${encodeURIComponent(localDash)}&kid=${key.key_id ?? ""}&key=${key.key ?? ""}`;
	} catch (e) {
		console.error("fetch video info failed:", e);
		alert("스트림 정보를 가져올 수 없습니다.");
	}
}

// ── Infinite scroll sentinel ──────────────────────────────────────────────────
const io = new IntersectionObserver(
	(entries) => {
		for (const e of entries)
			if (e.isIntersecting) (e.target as SentinelElement)._load?.();
	},
	{ rootMargin: "200px" },
);

function updateSentinel(id: string, hasMore: boolean, loadFn: () => void): void {
	let el = document.getElementById(id) as SentinelElement | null;
	if (!hasMore) {
		el?.remove();
		return;
	}
	if (!el) {
		el = document.createElement("div") as SentinelElement;
		el.id = id;
		el.style.cssText = "height:1px;margin:8px 0;";
		const container =
			id === "ep-sentinel"
				? document.getElementById("episodes")!
				: document.getElementById("reviews")!;
		container.after(el);
		setTimeout(() => io.observe(el!), 0);
	}
	el._load = loadFn;
}

loadItem();
document.getElementById("btn-load-all-thumbs")?.addEventListener("click", () => {
	document.querySelectorAll<HTMLElement>("[data-thumb]").forEach((el) => el.click());
});

function handleRouteChange(): void {
	const next = getRouteParams();
	const itemChanged = next.itemId !== itemId;
	itemId = next.itemId;
	targetReviewId = next.targetReviewId;
	reviewSorting = next.reviewSorting;
	revSorting = (targetReviewId && reviewSorting) ? reviewSorting : "like";
	syncReviewSortButtons();

	if (itemChanged) {
		epOffset = 0;
		epTotal = Infinity;
		epLoading = false;
		epSort = "oldest";
		document.querySelectorAll("#ep-sort .sort-btn").forEach((b) => {
			b.classList.toggle("active", (b as HTMLElement).dataset["sort"] === epSort);
		});
		revOffset = 0;
		revTotal = Infinity;
		revLoading = false;
		revDeepLinked = false;
		revHighlighted = false;
		reviewsLoaded = false;
		resetItemView();
		if (targetReviewId) activateTab("reviews");
		else activateTab("episodes");
		loadItem();
		return;
	}

	if (targetReviewId) {
		activateTab("reviews");
		updateSentinel("rev-sentinel", false, loadReviews);
		loadReviews(true);
	}
}

window.addEventListener("hashchange", handleRouteChange);

// ── Extension: review write/edit/delete ──────────────────────────────────────
let extRevInited = false;

function buildScoreOptions(selected: number): string {
	const scores = [0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0];
	return scores.map(v =>
		`<option value="${v}"${v === selected ? " selected" : ""}>★ ${v.toFixed(1)}</option>`
	).join("");
}

function openReviewEdit(el: HTMLElement, rid: string, curScore: number, curContent: string): void {
	const form = document.createElement("div");
	form.className = "ext-edit-form";
	form.innerHTML = `
<div class="ext-form-row">
	<select class="ext-score-sel">${buildScoreOptions(curScore || 5.0)}</select>
</div>
<textarea class="ext-textarea" rows="3" placeholder="리뷰 내용...">${esc(curContent)}</textarea>
<div class="ext-form-row">
	<label class="ext-spoiler-label"><input type="checkbox" class="ext-spoiler-chk"> 스포일러</label>
	<button class="ext-action-btn" data-action="save">저장</button>
	<button class="ext-action-btn" data-action="cancel">취소</button>
	<span class="ext-err"></span>
</div>`;
	(form.querySelector(".ext-spoiler-chk") as HTMLInputElement).checked =
		!!el.querySelector(".review-spoiler");

	el.style.display = "none";
	el.after(form);

	form.querySelector("[data-action='cancel']")?.addEventListener("click", () => {
		form.remove();
		el.style.display = "";
	});

	form.querySelector("[data-action='save']")?.addEventListener("click", async () => {
		const score = parseFloat((form.querySelector(".ext-score-sel") as HTMLSelectElement).value);
		const content = (form.querySelector(".ext-textarea") as HTMLTextAreaElement).value.trim();
		const isSpoiler = (form.querySelector(".ext-spoiler-chk") as HTMLInputElement | null)?.checked ?? false;
		const btn = form.querySelector("[data-action='save']") as HTMLButtonElement;
		const errEl = form.querySelector(".ext-err") as HTMLElement;
		btn.disabled = true;
		errEl.textContent = "";
		const res = await extSend({
			type: "api", method: "PATCH",
			path: `/reviews/v1/${rid}/`,
			body: JSON.stringify({ score, content, is_spoiler: isSpoiler }),
		});
		if (res?.ok) {
			form.remove();
			el.style.display = "";
			// Refresh the review content in-place
			const body = el.querySelector(".review-body");
			if (body) {
				body.outerHTML = buildReviewBodyHtml(content, isSpoiler);
			} else if (content) {
				el.querySelector(".review-header")?.insertAdjacentHTML("afterend", buildReviewBodyHtml(content, isSpoiler));
			}
			const scoreEl = el.querySelector(".review-score");
			if (scoreEl) scoreEl.textContent = `★ ${score.toFixed(1)}`;
			attachRevealSpoiler(el);
			showInventoryGuideAfter(el, "반영이 늦으면 라프텔 리뷰함에서 다시 확인하거나 수정/삭제할 수 있습니다.");
		} else {
			errEl.textContent = "저장 실패: " + (res?.error ?? res?.status ?? "알 수 없는 오류");
			btn.disabled = false;
		}
	});
}

function initExtReviews(): void {
	if (extRevInited) return;
	extRevInited = true;

	initExt((loggedIn) => {
		if (!loggedIn) return;

		const revPanel = document.getElementById("tab-reviews");
		if (!revPanel) return;

		const writeWrap = document.createElement("div");
		writeWrap.id = "ext-rev-wrap";
		writeWrap.innerHTML = `
<div id="ext-rev-form">
	<div class="ext-form-row">
		<select class="ext-score-sel" id="ext-rev-score">${buildScoreOptions(5.0)}</select>
		<span style="font-size:12px;color:#555;margin-left:4px;">라프텔 연동 — 리뷰 작성</span>
	</div>
	<textarea id="ext-rev-content" class="ext-textarea" rows="3" placeholder="리뷰 내용을 입력하세요..."></textarea>
	<div class="ext-form-row">
		<label class="ext-spoiler-label"><input type="checkbox" id="ext-rev-spoiler"> 스포일러</label>
		<button class="ext-action-btn" id="ext-rev-submit">등록</button>
		<span class="ext-err" id="ext-rev-err"></span>
	</div>
	<div class="ext-form-row">${buildInventoryGuideHtml()}</div>
</div>`;

		const sortBar = document.getElementById("rev-sort");
		if (sortBar) sortBar.after(writeWrap);
		else revPanel.prepend(writeWrap);

		document.getElementById("ext-rev-submit")?.addEventListener("click", async () => {
			const score = parseFloat((document.getElementById("ext-rev-score") as HTMLSelectElement).value);
			const content = (document.getElementById("ext-rev-content") as HTMLTextAreaElement).value.trim();
			const isSpoiler = (document.getElementById("ext-rev-spoiler") as HTMLInputElement).checked;
			const btn = document.getElementById("ext-rev-submit") as HTMLButtonElement;
			const errEl = document.getElementById("ext-rev-err")!;
			btn.disabled = true; errEl.textContent = "";

			const res = await extSend({
				type: "api", method: "POST",
				path: "/reviews/v1/list/",
				body: JSON.stringify({ item: Number(itemId), content, score, is_spoiler: isSpoiler }),
			});

			if (res?.ok) {
				btn.disabled = false;
				(document.getElementById("ext-rev-content") as HTMLTextAreaElement).value = "";
				(document.getElementById("ext-rev-spoiler") as HTMLInputElement).checked = false;
				errEl.innerHTML = `등록 시도 완료. 반영 여부는 리뷰함에서 확인할 수 있습니다. ${buildInventoryGuideHtml("바로 열기")}`;
				loadReviews(true);
			} else {
				errEl.textContent = "실패: " + (res?.error ?? res?.status ?? "알 수 없는 오류");
				btn.disabled = false;
			}
		});
	});
}

// Trigger ext review init when reviews tab is first opened
document.querySelectorAll(".tab").forEach((btn) => {
	btn.addEventListener("click", () => {
		if ((btn as HTMLElement).dataset["tab"] === "reviews") initExtReviews();
	});
});
if (targetReviewId) initExtReviews();
