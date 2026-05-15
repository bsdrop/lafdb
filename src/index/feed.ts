import { escapeHtmlAttr } from "../shared/text";
import { EXCLUSIVE_SCAN_PAGE_LIMIT } from "./constants";
import {
  getOfflineSearchBlockedMessage,
  hasDownloadedOfflineItems,
  isManualThumbsEnabled,
  isOfflineItemModeReady,
  isOfflineModeEnabled,
  queryOfflineItems,
  shouldPreferOfflineItemSearch,
} from "./offline-sync";

const esc = escapeHtmlAttr;
const PAGE = 24;
const html = (s: TemplateStringsArray, ...args: any[]) => s.map((p, i) => p + (args[i] || "")).join("");

export type FeedState = {
  q: string;
  sort: string;
  genre: string | null;
  medium: string | null;
  original: string | null;
  ending: string | null;
};

export type FeedController = {
  fetchPage: (reset?: boolean) => Promise<void>;
  runSearch: (q: string) => void;
  syncChipsToState: () => void;
};

export function initFeed(): FeedController {
  const searchEl = document.getElementById("search") as HTMLInputElement;
  const feedStatusEl = document.getElementById("feed-status")!;
  const gridEl = document.getElementById("grid")!;
  const sentinelEl = document.getElementById("sentinel")!;
  const sortChipsEl = document.getElementById("sort-chips")!;
  const filtersEl = document.getElementById("filters")!;

  let state: FeedState = {
    q: "",
    sort: "recent",
    genre: null,
    medium: null,
    original: null,
    ending: "true",
  };
  let offset = 0;
  let total = Infinity;
  let loading = false;
  let fetchGen = 0;
  let mode: "discover" | "search" = "discover";
  let feedMessage = "";
  let isNetworkOffline = !navigator.onLine;

  if (localStorage.getItem("hide_no_access") === null) {
    localStorage.setItem("hide_no_access", "yes");
  }

  function setFeedStatus(message = "") {
    feedMessage = message;
    const parts = [];
    if (isNetworkOffline) parts.push("오프라인 상태입니다.");
    if (feedMessage) parts.push(feedMessage);
    const text = parts.join(" ");
    feedStatusEl.textContent = text;
    feedStatusEl.classList.toggle("show", !!text);
    feedStatusEl.classList.toggle("offline", isNetworkOffline);
  }

  window.addEventListener("online", () => {
    isNetworkOffline = false;
    setFeedStatus(feedMessage);
  });
  window.addEventListener("offline", () => {
    isNetworkOffline = true;
    setFeedStatus(feedMessage);
    if (!hasDownloadedOfflineItems()) {
      loading = false;
      fetchGen++;
      gridEl.innerHTML = "";
    }
  });

  function skelGrid(n = PAGE) {
    gridEl.innerHTML = Array.from(
      { length: n },
      () => `
<div class="card">
	<div class="card-thumb skel"></div>
	<div class="card-body">
		<div class="skel" style="height:13px;margin-top:6px;width:80%"></div>
		<div class="skel" style="height:11px;margin-top:4px;width:50%"></div>
	</div>
</div>`,
    ).join("");
  }

  function applyHideNo() {
    const hide = localStorage.getItem("hide_no_access") === "yes";
    document.querySelectorAll<HTMLElement>("#grid .card[data-accessible]").forEach((c) => {
      c.style.display = hide && c.dataset["accessible"] === "0" ? "none" : "";
    });
  }

  function renderItems(items: Array<Record<string, any>>, reset: boolean) {
    if (reset) gridEl.innerHTML = "";
    if (items.length === 0 && reset) {
      gridEl.innerHTML = '<p id="no-results">결과가 없습니다.</p>';
      return;
    }
    for (const item of items) {
      const thumb =
        item.images?.find((i: { option_name?: string }) => i.option_name === "home_default")?.img_url ??
        item.images?.[0]?.img_url ??
        "";

      const card = document.createElement("a");
      card.className = "card";

      const itemId = item.id;
      card.href = `item.html#id=${encodeURIComponent(itemId)}`;
      card.addEventListener("click", (e) => {
        if (e.ctrlKey || e.metaKey || e.button === 1) return;
        e.preventDefault();
        location.href = card.href;
      });

      const thumbEl = thumb
        ? isManualThumbsEnabled()
          ? `<div class="card-thumb card-thumb-manual" data-thumb="${esc(thumb)}">썸네일 불러오기</div>`
          : `<img class="card-thumb" src="${esc(thumb)}" alt="" loading="lazy" width="170" height="255" decoding="async">`
        : `<div class="card-thumb card-thumb-fallback">▶</div>`;

      const badges: string[] = [];
      const accessible = (window as any).isAccessibleItem?.(itemId);
      if (accessible != null) card.dataset["accessible"] = accessible ? "1" : "0";
      if (accessible === true) badges.push(`<span class="card-badge ok">재생 가능</span>`);
      else if (accessible === false) badges.push(`<span class="card-badge no">재생 불가</span>`);
      if (item.is_laftel_original) badges.push(`<span class="card-badge exclusive">독점</span>`);
      if (item.is_ending) badges.push(`<span class="card-badge end">완결</span>`);

      card.innerHTML = `
			${thumbEl}
<div class="card-body">
	<div class="card-title">${esc(item.name ?? "")}</div>
	<div class="card-sub">${esc((item.genre ?? []).slice(0, 2).join(" · "))}</div>
	${badges.join("")}
</div>`;
      card.querySelector<HTMLElement>(".card-thumb-manual")?.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const el = e.currentTarget as HTMLElement;
        const src = el.dataset["thumb"];
        if (!src) return;
        el.outerHTML = `<img class="card-thumb" src="${esc(src)}" alt="" loading="lazy" width="170" height="255" decoding="async">`;
      });
      gridEl.appendChild(card);
    }
    applyHideNo();
  }

  function buildSearchParams(currentOffset: number) {
    if (mode === "search") {
      const params = new URLSearchParams({
        keyword: state.q,
        viewing_only: "false",
        offset: String(currentOffset),
        size: String(PAGE),
      });
      if (state.ending != null) params.set("ending", state.ending);
      return {
        url: `/api/search/v3/keyword?${params}`,
        isExclusiveOnly: state.original === "true",
      };
    }

    const params = new URLSearchParams({
      offset: String(currentOffset),
      size: String(PAGE),
    });
    if (state.sort) params.set("sort", state.sort);
    if (state.genre) params.set("genres", state.genre);
    if (state.medium) params.set("medium", state.medium);
    if (state.original != null) params.set("original", state.original);
    if (state.ending != null) params.set("ending", state.ending);
    return {
      url: `/api/search/v1/discover?${params}`,
      isExclusiveOnly: state.original === "true",
    };
  }

  async function fetchPage(reset = false) {
    if (reset) {
      offset = 0;
      total = Infinity;
      loading = false;
      fetchGen++;
    }
    if (loading || offset >= total) return;
    loading = true;
    const gen = fetchGen;
    const isFirstPage = offset === 0;
    const offlineBlockedMessage = "오프라인 상태이며, 저장된 작품 메타데이터가 없습니다.";

    if (isNetworkOffline) {
      if (hasDownloadedOfflineItems()) {
        try {
          const result = await queryOfflineItems(state, offset, PAGE);
          if (gen !== fetchGen) return;
          total = result.total;
          offset += result.items.length;
          renderItems(result.items, isFirstPage);
          setFeedStatus("저장된 작품 메타데이터로 표시 중입니다.");
          return;
        } finally {
          if (gen === fetchGen) loading = false;
        }
      }

      total = 0;
      offset = 0;
      gridEl.innerHTML = "";
      setFeedStatus(offlineBlockedMessage);
      loading = false;
      return;
    }

    if (isOfflineModeEnabled() && !hasDownloadedOfflineItems()) {
      total = 0;
      offset = 0;
      gridEl.innerHTML = "";
      setFeedStatus(getOfflineSearchBlockedMessage());
      loading = false;
      return;
    }

    if (offset === 0) skelGrid();
    setFeedStatus(isFirstPage ? "" : "다음 페이지를 불러오는 중...");

    try {
      if (shouldPreferOfflineItemSearch()) {
        const result = await queryOfflineItems(state, offset, PAGE);
        if (gen !== fetchGen) return;
        total = result.total;
        offset += result.items.length;
        renderItems(result.items, isFirstPage);
        setFeedStatus(
          isFirstPage ? "" : `오프라인 메타데이터에서 ${offset.toLocaleString()}/${total.toLocaleString()}개 불러옴`,
        );
        return;
      }

      const items: Array<Record<string, any>> = [];
      let nextOffset = offset;
      let nextTotal = total;
      const { isExclusiveOnly } = buildSearchParams(nextOffset);
      let pagesScanned = 0;

      while (nextOffset < nextTotal) {
        const { url } = buildSearchParams(nextOffset);
        const data = await apiFetch<any>(url);
        if (gen !== fetchGen) return;

        const batch = data.results ?? [];
        nextTotal = typeof data.count === "number" ? data.count : nextOffset + batch.length;

        const filtered = isExclusiveOnly ? batch.filter((item: any) => item.is_laftel_original) : batch;
        items.push(...filtered);
        nextOffset += batch.length;
        pagesScanned++;

        if (!isFirstPage) {
          const progress =
            nextTotal !== Infinity
              ? `${Math.min(nextOffset, nextTotal).toLocaleString()}/${nextTotal.toLocaleString()}`
              : `${nextOffset.toLocaleString()}개`;
          setFeedStatus(
            isExclusiveOnly ? `독점 필터 적용 중... ${progress}` : `다음 페이지를 불러오는 중... ${progress}`,
          );
        }

        if (!isExclusiveOnly || items.length >= PAGE || batch.length === 0) break;
        if (pagesScanned >= EXCLUSIVE_SCAN_PAGE_LIMIT) break;
      }

      total = nextTotal;
      offset = nextOffset;
      renderItems(items, isFirstPage);
      if (!isFirstPage) {
        if (items.length === 0 && offset < total && isExclusiveOnly) {
          const pageNum = Math.floor(offset / PAGE) + 1;
          setFeedStatus(`${pageNum}번 페이지를 읽고 있습니다.`);
        } else {
          setFeedStatus("");
        }
      }
    } catch (e) {
      if (gen !== fetchGen) return;
      console.warn("Fetch page failed, attempting offline fallback:", e);
      if (hasDownloadedOfflineItems()) {
        try {
          const result = await queryOfflineItems(state, offset, PAGE);
          if (gen !== fetchGen) return;
          total = result.total;
          offset += result.items.length;
          renderItems(result.items, isFirstPage);
          setFeedStatus(
            isNetworkOffline
              ? "오프라인 상태입니다. 저장된 작품 메타데이터로 표시 중입니다."
              : "온라인 요청에 실패하여, 저장된 작품 메타데이터로 표시 중입니다.",
          );
          return;
        } catch (fallbackErr) {
          console.error("Offline fallback also failed:", fallbackErr);
        }
      }
      setFeedStatus("불러오기에 실패하였습니다.");
      if (offset === 0) gridEl.innerHTML = "";
    } finally {
      if (gen === fetchGen) {
        loading = false;
        // If the viewport isn't filled yet, trigger next page load automatically.
        if (offset < total) {
          const r = sentinelEl.getBoundingClientRect();
          if (r.top < window.innerHeight + 300) {
            setTimeout(() => void fetchPage(), 50);
          }
        }
      }
    }
  }

  const io = new IntersectionObserver(
    (entries) => {
      if (entries[0].isIntersecting) void fetchPage();
    },
    { rootMargin: "300px" },
  );
  io.observe(sentinelEl);

  function runSearch(q: string) {
    state.q = q;
    mode = q ? "search" : "discover";
    sortChipsEl.style.display = q ? "none" : "";
    const hash = q ? "#q=" + encodeURIComponent(q) : "#";
    history.replaceState(null, "", hash);
    window.scrollTo({ top: 0, behavior: "instant" });
    syncChipsToState();
    void fetchPage(true);
  }

  filtersEl.addEventListener("click", (e) => {
    const chip = (e.target as Element).closest(".chip") as HTMLElement | null;
    if (!chip) return;

    if (chip.dataset["sort"]) {
      document.querySelectorAll(".chip[data-sort]").forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
      state.sort = chip.dataset["sort"]!;
    } else if (chip.dataset["genre"]) {
      const active = chip.classList.toggle("active");
      state.genre = active ? chip.dataset["genre"]! : null;
      if (active) {
        document.querySelectorAll(".chip[data-genre]").forEach((c) => {
          if (c !== chip) c.classList.remove("active");
        });
      }
    } else if (chip.dataset["medium"]) {
      const active = chip.classList.toggle("active");
      state.medium = active ? chip.dataset["medium"]! : null;
      if (active) {
        document.querySelectorAll(".chip[data-medium]").forEach((c) => {
          if (c !== chip) c.classList.remove("active");
        });
      }
    } else if (chip.dataset["original"]) {
      const active = chip.classList.toggle("active");
      state.original = active ? chip.dataset["original"]! : null;
      if (active) {
        document.querySelectorAll(".chip[data-original]").forEach((c) => {
          if (c !== chip) c.classList.remove("active");
        });
      }
      void fetchPage(true);
      return;
    } else if (chip.dataset["ending"]) {
      const active = chip.classList.toggle("active");
      state.ending = active ? chip.dataset["ending"]! : null;
      if (active) {
        document.querySelectorAll(".chip[data-ending]").forEach((c) => {
          if (c !== chip) c.classList.remove("active");
        });
      }
      void fetchPage(true);
      return;
    } else if (chip.dataset["hideNo"]) {
      const active = chip.classList.toggle("active");
      localStorage.setItem("hide_no_access", active ? "yes" : "no");
      applyHideNo();
      return;
    }

    searchEl.value = "";
    state.q = "";
    mode = "discover";
    sortChipsEl.style.display = "";
    void fetchPage(true);
  });

  if (localStorage.getItem("hide_no_access") === "yes") {
    document.querySelector(".chip[data-hide-no]")?.classList.add("active");
  }

  function syncChipsToState() {
    document
      .querySelectorAll<HTMLElement>(".chip[data-sort]")
      .forEach((c) => c.classList.toggle("active", c.dataset["sort"] === state.sort));
    document
      .querySelectorAll<HTMLElement>(".chip[data-genre]")
      .forEach((c) => c.classList.toggle("active", c.dataset["genre"] === state.genre));
    document
      .querySelectorAll<HTMLElement>(".chip[data-medium]")
      .forEach((c) => c.classList.toggle("active", c.dataset["medium"] === state.medium));
    document
      .querySelectorAll<HTMLElement>(".chip[data-original]")
      .forEach((c) => c.classList.toggle("active", c.dataset["original"] === state.original));
    document
      .querySelectorAll<HTMLElement>(".chip[data-ending]")
      .forEach((c) => c.classList.toggle("active", c.dataset["ending"] === state.ending));
    document
      .querySelector(".chip[data-hide-no]")
      ?.classList.toggle("active", localStorage.getItem("hide_no_access") === "yes");
    searchEl.value = state.q;
    sortChipsEl.style.display = state.q ? "none" : "";
  }

  window.addEventListener("popstate", syncChipsToState);

  const initQ = new URLSearchParams(location.hash.slice(1)).get("q");
  if (initQ) {
    searchEl.value = initQ;
    runSearch(initQ);
  } else {
    void fetchPage(true);
  }

  return { fetchPage, runSearch, syncChipsToState };
}
