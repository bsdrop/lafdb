import { normalizeStoredTimestamps } from "./watch-history";
import { initAutocomplete } from "./index/autocomplete";
import { initFeed } from "./index/feed";
import { initSettings } from "./index/settings";

normalizeStoredTimestamps();

const feed = initFeed();

initAutocomplete({
	runSearch: feed.runSearch,
});

initSettings({
	onRefreshFeed: () => {
		void feed.fetchPage(true);
	},
});
