import { normalizeStoredTimestamps } from "./watch-history";
import { initAutocomplete } from "./index/autocomplete";
import { initFeed } from "./index/feed";
import { initSettings } from "./index/settings";

normalizeStoredTimestamps();

function primeKeyboardFocus(): void {
	if (document.activeElement && document.activeElement !== document.body) return;
	document.body.tabIndex = -1;
	document.body.focus({ preventScroll: true });
}

if (document.readyState === "loading") {
	document.addEventListener("DOMContentLoaded", primeKeyboardFocus, { once: true });
} else {
	primeKeyboardFocus();
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
