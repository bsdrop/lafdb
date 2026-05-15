import { normalizeStoredTimestamps } from "./watch-history";
import { initAutocomplete } from "./index/autocomplete";
import { initFeed } from "./index/feed";
import { initSettings } from "./index/settings";

normalizeStoredTimestamps();

function focusInitialSearch(): void {
  if (document.activeElement && document.activeElement !== document.body) return;
  const search = document.getElementById("search") as HTMLInputElement | null;
  if (!search) return;
  search.focus({ preventScroll: true });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", focusInitialSearch, { once: true });
} else {
  focusInitialSearch();
}

const feed = initFeed();

initAutocomplete({
  runSearch: feed.runSearch,
});

initSettings({
  onRefreshFeed: () => {
    void feed.fetchPage(true);
  },
});
