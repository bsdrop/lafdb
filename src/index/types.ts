export type OfflineScope = {
	items: boolean;
	episodes: boolean;
};

export type OfflineMetaState = {
	ready: boolean;
	itemCount: number;
	episodeCount: number;
	updatedAt: string;
	scopes: OfflineScope;
	syncState: {
		inProgress: boolean;
		stage: "items" | "episodes" | "";
		nextItemIndex: number;
		totalItems: number;
	};
};

export type OfflineStatusState = {
	phase: "idle" | "syncing" | "ready" | "error";
	message: string;
	downloaded: number;
	total: number;
	error: string;
};

export type OfflineItemRecord = {
	id: number | string;
	name: string;
	genre: string[];
	medium: string;
	images: Array<{ img_url?: string; option_name?: string }>;
	is_laftel_original: boolean;
	is_ending: boolean;
	avg_rating: number;
	air_year_quarter: string;
	latest_episode_release_datetime: string;
	_sortRecent: number;
	_nameLower: string;
	_choseong: string;
	_disassembled: string;
	_search: string;
};

export type OfflineEpisodeRecord = {
	id: number | string;
	item_id: number | string;
	item_name: string;
	episode_num: string;
	title: string;
	running_time: string;
	thumbnail_path: string;
	is_free: boolean;
	has_preview: boolean;
};

export type RawItem = {
	id: number | string;
	name?: string;
	title?: string;
	genre?: string[];
	tags?: string[];
	medium?: string;
	images?: Array<{ img_url?: string; option_name?: string }>;
	is_laftel_original?: boolean;
	is_ending?: boolean;
	avg_rating?: number;
	air_year_quarter?: string;
	latest_episode_release_datetime?: string;
};

export type RawEpisode = {
	id: number | string;
	item_id?: number | string;
	episode_num?: string | number;
	episode_order?: string | number;
	subject?: string;
	title?: string;
	running_time?: string;
	thumbnail_path?: string;
	is_free?: boolean;
	has_preview?: boolean;
};

export interface AutocompleteItem {
	name?: string;
	title?: string;
}
