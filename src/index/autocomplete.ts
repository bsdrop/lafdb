import { type AutocompleteItem } from "./types";
import {
  getOfflineAutocompleteItems,
  hasDownloadedOfflineItems,
  isOfflineModeEnabled,
  shouldPreferOfflineItemSearch,
} from "./offline-sync";

type InitAutocompleteOptions = {
  runSearch: (q: string) => void;
};

export function initAutocomplete({ runSearch }: InitAutocompleteOptions) {
  const acDrop = document.getElementById("ac-dropdown")!;
  const searchEl = document.getElementById("search") as HTMLInputElement;
  let acTimer: ReturnType<typeof setTimeout> | null = null;
  const AC_DELAY = Math.max(0, parseInt(localStorage.getItem("ac_delay") ?? "100", 10) || 100);

  function closeAc() {
    acDrop.classList.remove("show");
  }

  function isAcOpen() {
    return acDrop.classList.contains("show") && acDrop.children.length > 0;
  }

  function clearAc() {
    acDrop.classList.remove("show");
    acDrop.innerHTML = "";
  }

  searchEl.addEventListener("input", () => {
    if (acTimer) clearTimeout(acTimer);
    const q = searchEl.value.trim();
    if (!q) {
      clearAc();
      runSearch("");
      return;
    }

    acTimer = setTimeout(async () => {
      if (isOfflineModeEnabled() && !hasDownloadedOfflineItems()) {
        acDrop.innerHTML = '<div class="ac-item">오프라인 DB 동기화 또는 온라인 모드가 필요합니다.</div>';
        acDrop.classList.add("show");
        return;
      }
      let items: Array<string | AutocompleteItem> = [];
      if (shouldPreferOfflineItemSearch()) {
        items = await getOfflineAutocompleteItems(q, 8).catch((e) => {
          console.error("Offline autocomplete failed:", e);
          return [];
        });
      } else {
        try {
          items = await apiFetch<Array<string | AutocompleteItem>>(
            `/api/search/v1/auto_complete/?keyword=${encodeURIComponent(q)}`,
          );
        } catch (err) {
          console.warn("Online autocomplete failed, trying offline:", err);
          if (hasDownloadedOfflineItems()) {
            items = await getOfflineAutocompleteItems(q, 8).catch((e) => {
              console.error("Offline fallback autocomplete failed:", e);
              return [];
            });
          } else {
            acDrop.innerHTML = '<div class="ac-item">오프라인 상태입니다.</div>';
            acDrop.classList.add("show");
            return;
          }
        }
      }

      acDrop.innerHTML = "";
      if (!Array.isArray(items) || items.length === 0) {
        clearAc();
        return;
      }

      for (const s of items.slice(0, 8)) {
        const el = document.createElement("div");
        el.className = "ac-item";
        el.textContent =
          typeof s === "string" ? s : ((s as AutocompleteItem).name ?? (s as AutocompleteItem).title ?? String(s));
        el.addEventListener("mousedown", (e) => {
          e.preventDefault();
          searchEl.value = el.textContent!;
          clearAc();
          runSearch(el.textContent!);
        });
        acDrop.appendChild(el);
      }
      acDrop.classList.add("show");
    }, AC_DELAY);
  });

  searchEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      if (acTimer) clearTimeout(acTimer);
      clearAc();
      runSearch(searchEl.value.trim());
    }
    if (e.key === "Escape") {
      if (isAcOpen()) {
        e.preventDefault();
        closeAc();
        return;
      }
      searchEl.value = "";
      clearAc();
      runSearch("");
    }
  });
  searchEl.addEventListener("focus", () => {
    if (acDrop.children.length > 0) acDrop.classList.add("show");
  });
  searchEl.addEventListener("blur", () => setTimeout(closeAc, 150));
  document.addEventListener("click", (e) => {
    if (!searchEl.contains(e.target as Node) && !acDrop.contains(e.target as Node)) closeAc();
  });
  window.addEventListener("scroll", closeAc, { passive: true });
}
