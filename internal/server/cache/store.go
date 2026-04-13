package cache

import (
	"bytes"
	"encoding/gob"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	sourcepkg "github.com/bsdrop/lafdb/internal/server/source"
)

// --------------------
// Store
// --------------------

type Store struct {
	EpisodesListByItemID map[int64][]byte // laftel/episodes/v3/list/{item_id}.json
	EpisodeByEpisodeID   map[int64][]byte // laftel/episodes/v3/{episode_id}.json
	ItemByItemID         map[int64][]byte // laftel/items/v4/{item_id}.json
	SeriesBySeriesID     map[int64][]byte // laftel/items/v2/series/{series_id}.json

	// reverse index
	EpisodeToItemID map[int64]int64

	// precomputed sets
	EndingItemIDs   map[int64]struct{} // items where is_ending == true
	PlayableItemIDs map[int64]struct{} // items with at least one episode that has a DRM key

	// review counts: laftel/reviews/v1/count/{item_id}.json
	ReviewCountByItemID map[int64][]byte

	// raw JSON blobs
	ReviewListByItemID       map[int64][]byte // laftel/reviews/v2/list/{item_id}.json
	ReviewShareByReviewID    map[int64]sourcepkg.ReviewShareEntry
	StatisticsByItemID       map[int64][]byte // laftel/items/v1/{item_id}/statistics.json
	CommentListByEpisodeID   map[int64][]byte // laftel/comments/v1/list/{episode_id}.json
	CommentRepliesByParentID map[int64][]byte // laftel/comments/v1/replies/{parent_id}.json
	CommentShareByCommentID  map[int64]sourcepkg.CommentShareEntry
	DRMKeyByEpisodeID        map[int64][]byte // laftel/mediacloud/keys/{episode_id}.json
}

const storeVersion = 5

func (s *Store) SaveToFile(path string) error {
	start := time.Now()
	log.Printf("cache save: writing %s (optimized sequential)", path)
	path = filepath.Clean(path)
	if dir := filepath.Dir(path); dir != "." {
		if err := os.MkdirAll(dir, 0750); err != nil {
			return fmt.Errorf("mkdir cache dir: %w", err)
		}
	}
	tmp := path + ".tmp"

	f, err := os.OpenFile(filepath.Clean(tmp), os.O_RDWR|os.O_CREATE|os.O_TRUNC, 0600)
	if err != nil {
		return fmt.Errorf("create cache file: %w", err)
	}

	enc := gob.NewEncoder(f)

	// Write version
	if err := enc.Encode(storeVersion); err != nil {
		_ = f.Close()
		_ = os.Remove(tmp)
		return fmt.Errorf("encode version: %w", err)
	}

	encodeStep := func(name string, data any) error {
		estart := time.Now()
		if err := enc.Encode(data); err != nil {
			return fmt.Errorf("encode %s: %w", name, err)
		}
		log.Printf("cache save: encoded %s in %s", name, time.Since(estart))
		return nil
	}

	// We encode maps one by one. To save RAM, we can nil out maps after encoding
	// if we don't need the Store anymore. But NewStore is usually called just before
	// SaveToFile in the drm daemon, so we can afford to be destructive or just
	// trigger GC.
	steps := []struct {
		name string
		data any
	}{
		{"EpisodesListByItemID", s.EpisodesListByItemID},
		{"EpisodeByEpisodeID", s.EpisodeByEpisodeID},
		{"ItemByItemID", s.ItemByItemID},
		{"SeriesBySeriesID", s.SeriesBySeriesID},
		{"EpisodeToItemID", s.EpisodeToItemID},
		{"ReviewCountByItemID", s.ReviewCountByItemID},
		{"ReviewListByItemID", s.ReviewListByItemID},
		{"ReviewShareByReviewID", s.ReviewShareByReviewID},
		{"StatisticsByItemID", s.StatisticsByItemID},
		{"CommentListByEpisodeID", s.CommentListByEpisodeID},
		{"CommentRepliesByParentID", s.CommentRepliesByParentID},
		{"CommentShareByCommentID", s.CommentShareByCommentID},
		{"DRMKeyByEpisodeID", s.DRMKeyByEpisodeID},
	}

	for _, st := range steps {
		if err := encodeStep(st.name, st.data); err != nil {
			_ = f.Close()
			_ = os.Remove(tmp)
			return err
		}
		// st.data = nil // can't do this easily with the slice of structs
	}

	syncStart := time.Now()
	if err := f.Sync(); err != nil {
		_ = f.Close()
		_ = os.Remove(tmp)
		return fmt.Errorf("sync cache file: %w", err)
	}
	log.Printf("cache save: fsync took %s", time.Since(syncStart))
	if err := f.Close(); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("close cache file: %w", err)
	}
	renameStart := time.Now()
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("rename cache file: %w", err)
	}
	log.Printf("cache save: rename took %s", time.Since(renameStart))
	log.Printf("cache save: total took %s", time.Since(start))

	return nil
}

func LoadFromFile(path string) (*Store, error) {
	start := time.Now()
	f, err := os.Open(filepath.Clean(path))
	if err != nil {
		return nil, fmt.Errorf("open cache file: %w", err)
	}
	defer f.Close()

	dec := gob.NewDecoder(f)
	var version int
	if err := dec.Decode(&version); err != nil {
		return nil, fmt.Errorf("decode version: %w", err)
	}

	s := &Store{}

	if version == storeVersion {
		// Version 2: sequential encoding
		err = errors.Join(
			dec.Decode(&s.EpisodesListByItemID),
			dec.Decode(&s.EpisodeByEpisodeID),
			dec.Decode(&s.ItemByItemID),
			dec.Decode(&s.SeriesBySeriesID),
			dec.Decode(&s.EpisodeToItemID),
			dec.Decode(&s.ReviewCountByItemID),
			dec.Decode(&s.ReviewListByItemID),
			dec.Decode(&s.ReviewShareByReviewID),
			dec.Decode(&s.StatisticsByItemID),
			dec.Decode(&s.CommentListByEpisodeID),
			dec.Decode(&s.CommentRepliesByParentID),
			dec.Decode(&s.CommentShareByCommentID),
			dec.Decode(&s.DRMKeyByEpisodeID),
		)
		if err != nil {
			return nil, fmt.Errorf("decode cache maps (v2): %w", err)
		}
	} else if version == 1 || version > 1000 { // version 1 didn't have version tag, it started with a map
		// This is fallback for old format if needed, but since version wasn't there,
		// gob decode of int might fail or read part of a map.
		// Actually old format started with a struct.
		return nil, fmt.Errorf("unsupported cache version: %d (please rebuild cache)", version)
	}

	deriveStart := time.Now()
	s.initNilMaps()
	log.Printf("cache load: derived sets took %s (ending=%d playable=%d)", time.Since(deriveStart), len(s.EndingItemIDs), len(s.PlayableItemIDs))
	log.Printf("cache load: total took %s", time.Since(start))
	return s, nil
}

func (s *Store) initNilMaps() {
	if s.EpisodesListByItemID == nil {
		s.EpisodesListByItemID = make(map[int64][]byte)
	}
	if s.EpisodeByEpisodeID == nil {
		s.EpisodeByEpisodeID = make(map[int64][]byte)
	}
	if s.ItemByItemID == nil {
		s.ItemByItemID = make(map[int64][]byte)
	}
	if s.SeriesBySeriesID == nil {
		s.SeriesBySeriesID = make(map[int64][]byte)
	}
	if s.EpisodeToItemID == nil {
		s.EpisodeToItemID = make(map[int64]int64)
	}
	if s.ReviewCountByItemID == nil {
		s.ReviewCountByItemID = make(map[int64][]byte)
	}
	if s.ReviewListByItemID == nil {
		s.ReviewListByItemID = make(map[int64][]byte)
	}
	if s.ReviewShareByReviewID == nil {
		s.ReviewShareByReviewID = make(map[int64]sourcepkg.ReviewShareEntry)
	}
	if s.StatisticsByItemID == nil {
		s.StatisticsByItemID = make(map[int64][]byte)
	}
	if s.CommentListByEpisodeID == nil {
		s.CommentListByEpisodeID = make(map[int64][]byte)
	}
	if s.CommentRepliesByParentID == nil {
		s.CommentRepliesByParentID = make(map[int64][]byte)
	}
	if s.CommentShareByCommentID == nil {
		s.CommentShareByCommentID = make(map[int64]sourcepkg.CommentShareEntry)
	}
	if s.DRMKeyByEpisodeID == nil {
		s.DRMKeyByEpisodeID = make(map[int64][]byte)
	}
	if len(s.CommentShareByCommentID) == 0 && (len(s.CommentListByEpisodeID) > 0 || len(s.CommentRepliesByParentID) > 0) {
		s.buildCommentShareIndex()
	}
	if len(s.ReviewShareByReviewID) == 0 && len(s.ReviewListByItemID) > 0 {
		s.buildReviewShareIndex()
	}
	s.buildEndingSet()
	s.buildPlayableSet()
}

func (s *Store) buildEndingSet() {
	s.EndingItemIDs = make(map[int64]struct{}, len(s.ItemByItemID)/4)
	var item struct {
		IsEnding bool `json:"is_ending"`
	}
	for id, b := range s.ItemByItemID {
		if json.Unmarshal(b, &item) == nil && item.IsEnding {
			s.EndingItemIDs[id] = struct{}{}
		}
	}
}

func (s *Store) buildPlayableSet() {
	s.PlayableItemIDs = make(map[int64]struct{}, len(s.DRMKeyByEpisodeID))
	for epID := range s.DRMKeyByEpisodeID {
		if itemID, ok := s.EpisodeToItemID[epID]; ok {
			s.PlayableItemIDs[itemID] = struct{}{}
		}
	}
}

// --------------------
// Load all JSON files
// --------------------

func NewStore() (*Store, error) {
	s := &Store{
		EpisodesListByItemID:     make(map[int64][]byte, 8192),
		EpisodeByEpisodeID:       make(map[int64][]byte, 65536),
		ItemByItemID:             make(map[int64][]byte, 8192),
		SeriesBySeriesID:         make(map[int64][]byte, 8192),
		EpisodeToItemID:          make(map[int64]int64, 65536),
		ReviewCountByItemID:      make(map[int64][]byte, 8192),
		ReviewListByItemID:       make(map[int64][]byte, 8192),
		ReviewShareByReviewID:    make(map[int64]sourcepkg.ReviewShareEntry, 131072),
		StatisticsByItemID:       make(map[int64][]byte, 8192),
		CommentListByEpisodeID:   make(map[int64][]byte, 65536),
		CommentRepliesByParentID: make(map[int64][]byte, 65536),
		CommentShareByCommentID:  make(map[int64]sourcepkg.CommentShareEntry, 262144),
		DRMKeyByEpisodeID:        make(map[int64][]byte, 65536),
	}

	// 1) items
	log.Printf("loading items/v4 ...")
	if err := WalkJSONDirProgress("items/v4", "./laftel/items/v4", func(path string) error {
		id, err := FileIDFromPath(path)
		if err != nil {
			return err
		}
		b, _, err := loadAndNormalizeJSON(path)
		if err != nil {
			return err
		}
		s.ItemByItemID[id] = b
		return nil
	}); err != nil {
		return nil, err
	}
	log.Printf("items/v4 done: %d files", len(s.ItemByItemID))

	// 2) series
	log.Printf("loading items/v2/series ...")
	if err := WalkJSONDirProgress("items/v2/series", "./laftel/items/v2/series", func(path string) error {
		id, err := FileIDFromPath(path)
		if err != nil {
			return err
		}
		b, _, err := loadAndNormalizeJSON(path)
		if err != nil {
			return err
		}
		s.SeriesBySeriesID[id] = b
		return nil
	}); err != nil {
		return nil, err
	}
	log.Printf("items/v2/series done: %d files", len(s.SeriesBySeriesID))

	// 3) episode single
	log.Printf("loading episodes/v3 ...")
	if err := WalkJSONDirProgress("episodes/v3", "./laftel/episodes/v3", func(path string) error {
		if strings.Contains(filepath.ToSlash(path), "episodes/v3/list/") {
			return nil
		}
		id, err := FileIDFromPath(path)
		if err != nil {
			return err
		}
		b, _, err := loadAndNormalizeJSON(path)
		if err != nil {
			return err
		}
		s.EpisodeByEpisodeID[id] = b
		return nil
	}); err != nil {
		return nil, err
	}
	log.Printf("episodes/v3 done: %d files", len(s.EpisodeByEpisodeID))

	// 4) episode list by item_id
	log.Printf("loading episodes/v3/list ...")
	if err := WalkJSONDirProgress("episodes/v3/list", "./laftel/episodes/v3/list", func(path string) error {
		itemID, err := FileIDFromPath(path)
		if err != nil {
			return err
		}
		b, parsed, err := loadAndNormalizeJSON(path)
		if err != nil {
			return err
		}
		s.EpisodesListByItemID[itemID] = b

		var episodeIDs []int64
		if parsed != nil {
			episodeIDs, err = extractEpisodeIDsFromList(parsed)
		} else {
			episodeIDs, err = extractEpisodeIDsFromListBytes(b)
		}
		if err != nil {
			return fmt.Errorf("%s: extract episode ids: %w", path, err)
		}
		for _, episodeID := range episodeIDs {
			if _, exists := s.EpisodeToItemID[episodeID]; !exists {
				s.EpisodeToItemID[episodeID] = itemID
			}
		}
		return nil
	}); err != nil {
		return nil, err
	}
	log.Printf("episodes/v3/list done: %d files", len(s.EpisodesListByItemID))

	// 5) review counts
	log.Printf("loading reviews/v1/count ...")
	if err := WalkJSONDirProgress("reviews/v1/count", "./laftel/reviews/v1/count", func(path string) error {
		id, err := FileIDFromPath(path)
		if err != nil {
			return err
		}
		b, _, err := loadAndNormalizeJSON(path)
		if err != nil {
			return err
		}
		s.ReviewCountByItemID[id] = b
		return nil
	}); err != nil {
		log.Printf("warning: reviews/v1/count load failed (skipping): %v", err)
	}
	log.Printf("reviews/v1/count done: %d files", len(s.ReviewCountByItemID))

	// 6) review lists
	if err := WalkJSONDirProgress("reviews/v2/list", "./laftel/reviews/v2/list", func(path string) error {
		id, err := FileIDFromPath(path)
		if err != nil {
			return err
		}
		b, _, err := loadAndNormalizeJSON(path)
		if err != nil {
			return err
		}
		s.ReviewListByItemID[id] = b
		return nil
	}); err != nil {
		log.Printf("warning: reviews/v2/list load failed (skipping): %v", err)
	}
	log.Printf("reviews/v2/list done: %d files", len(s.ReviewListByItemID))

	// 7) statistics (laftel/items/v1/{id}/statistics.json)
	if err := WalkFilesProgress("items/v1/statistics", "./laftel/items/v1", func(path string, d fs.DirEntry) bool {
		return filepath.Base(path) == "statistics.json"
	}, func(path string) error {
		n, err := strconv.ParseInt(filepath.Base(filepath.Dir(path)), 10, 32)
		if err != nil {
			return nil
		}
		b, _, err := loadAndNormalizeJSON(path)
		if err != nil {
			log.Printf("warning: %s: %v", path, err)
			return nil
		}
		s.StatisticsByItemID[int64(n)] = b
		return nil
	}); err != nil {
		log.Printf("warning: items/v1/statistics load failed (skipping): %v", err)
	}
	log.Printf("items/v1/statistics done: %d files", len(s.StatisticsByItemID))

	// 8) comment lists
	log.Printf("loading comments/v1/list ...")
	if err := WalkJSONDirProgress("comments/v1/list", "./laftel/comments/v1/list", func(path string) error {
		id, err := FileIDFromPath(path)
		if err != nil {
			return err
		}
		b, _, err := loadAndNormalizeJSON(path)
		if err != nil {
			return err
		}
		s.CommentListByEpisodeID[id] = b
		return nil
	}); err != nil {
		log.Printf("warning: comments/v1/list load failed (skipping): %v", err)
	}
	log.Printf("comments/v1/list done: %d files", len(s.CommentListByEpisodeID))

	// 9) comment replies
	log.Printf("loading comments/v1/replies ...")
	if err := WalkJSONDirProgress("comments/v1/replies", "./laftel/comments/v1/replies", func(path string) error {
		id, err := FileIDFromPath(path)
		if err != nil {
			return err
		}
		b, _, err := loadAndNormalizeJSON(path)
		if err != nil {
			return err
		}
		s.CommentRepliesByParentID[id] = b
		return nil
	}); err != nil {
		log.Printf("warning: comments/v1/replies load failed (skipping): %v", err)
	}
	log.Printf("comments/v1/replies done: %d files", len(s.CommentRepliesByParentID))

	// 10) DRM keys
	log.Printf("loading mediacloud/keys ...")
	if err := WalkJSONDirProgress("mediacloud/keys", "./laftel/mediacloud/keys", func(path string) error {
		id, err := FileIDFromPath(path)
		if err != nil {
			return err
		}
		b, _, err := loadAndNormalizeJSON(path)
		if err != nil {
			return err
		}
		s.DRMKeyByEpisodeID[id] = b
		return nil
	}); err != nil {
		log.Printf("warning: mediacloud/keys load failed (skipping): %v", err)
	}
	log.Printf("mediacloud/keys done: %d files", len(s.DRMKeyByEpisodeID))

	log.Printf("building derived indexes/sets ...")
	s.buildReviewShareIndex()
	log.Printf("derived: review share index ready (%d reviews)", len(s.ReviewShareByReviewID))
	s.buildCommentShareIndex()
	log.Printf("derived: comment share index ready (%d comments)", len(s.CommentShareByCommentID))
	s.buildEndingSet()
	log.Printf("derived: ending set ready (%d items)", len(s.EndingItemIDs))
	s.buildPlayableSet()
	log.Printf("derived: playable set ready (%d items)", len(s.PlayableItemIDs))
	return s, nil
}

func (s *Store) buildCommentShareIndex() {
	if s.CommentShareByCommentID == nil {
		s.CommentShareByCommentID = make(map[int64]sourcepkg.CommentShareEntry, len(s.CommentListByEpisodeID)*16)
	} else {
		clear(s.CommentShareByCommentID)
	}

	for episodeID, raw := range s.CommentListByEpisodeID {
		for _, entry := range sourcepkg.ParseCommentShareEntries(raw, episodeID, s.EpisodeToItemID) {
			s.CommentShareByCommentID[entry.CommentID] = entry
		}
	}
	for _, raw := range s.CommentRepliesByParentID {
		for _, entry := range sourcepkg.ParseCommentShareEntries(raw, 0, s.EpisodeToItemID) {
			s.CommentShareByCommentID[entry.CommentID] = entry
		}
	}
}

func (s *Store) buildReviewShareIndex() {
	if s.ReviewShareByReviewID == nil {
		s.ReviewShareByReviewID = make(map[int64]sourcepkg.ReviewShareEntry, len(s.ReviewListByItemID)*16)
	} else {
		clear(s.ReviewShareByReviewID)
	}
	for itemID, raw := range s.ReviewListByItemID {
		for _, entry := range sourcepkg.ParseReviewShareEntries(raw, itemID) {
			s.ReviewShareByReviewID[entry.ReviewID] = entry
		}
	}
}

// --------------------
// Helpers
// --------------------

func normalizeString(s string) string {
	s = strings.ReplaceAll(s, "\r\n", "\n")
	s = strings.ReplaceAll(s, ".laftel.net", ".latfel.net")
	return s
}

func normalizeJSONValue(v any, parentKey string) any {
	switch x := v.(type) {
	case map[string]any:
		for k, vv := range x {
			// strip hls_url everywhere except inside highlight_video
			if k == "hls_url" && parentKey != "highlight_video" {
				delete(x, k)
				continue
			}
			x[k] = normalizeJSONValue(vv, k)
		}
		return x
	case []any:
		for i, vv := range x {
			x[i] = normalizeJSONValue(vv, parentKey)
		}
		return x
	case string:
		return normalizeString(x)
	default:
		return x
	}
}

func loadAndNormalizeJSON(path string) ([]byte, any, error) {
	raw, err := os.ReadFile(filepath.Clean(path))
	if err != nil {
		return nil, nil, err
	}
	raw = normalizeJSONBytes(raw)
	if !bytes.Contains(raw, []byte(`"hls_url"`)) {
		var compact bytes.Buffer
		compact.Grow(len(raw))
		if err := json.Compact(&compact, raw); err != nil {
			return nil, nil, fmt.Errorf("compact %s: %w", path, err)
		}
		return compact.Bytes(), nil, nil
	}
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		return nil, nil, fmt.Errorf("unmarshal %s: %w", path, err)
	}
	v = normalizeJSONValue(v, "")
	b, err := json.Marshal(v)
	if err != nil {
		return nil, nil, fmt.Errorf("marshal %s: %w", path, err)
	}
	return b, v, nil
}

func normalizeJSONBytes(raw []byte) []byte {
	if bytes.Contains(raw, []byte("\r\n")) {
		raw = bytes.ReplaceAll(raw, []byte("\r\n"), []byte("\n"))
	}
	if bytes.Contains(raw, []byte(".laftel.net")) {
		raw = bytes.ReplaceAll(raw, []byte(".laftel.net"), []byte(".latfel.net"))
	}
	return raw
}

func FileIDFromPath(path string) (int64, error) {
	base := filepath.Base(path)
	name := strings.TrimSuffix(base, filepath.Ext(base))
	return strconv.ParseInt(name, 10, 64)
}

func extractEpisodeIDsFromList(parsed any) ([]int64, error) {
	if parsed == nil {
		return nil, errors.New("list json not parsed")
	}
	root, ok := parsed.(map[string]any)
	if !ok {
		return nil, errors.New("list json is not object")
	}
	results, ok := root["results"].([]any)
	if !ok {
		return nil, errors.New("list json missing results array")
	}
	var ids []int64
	for _, r := range results {
		robj, ok := r.(map[string]any)
		if !ok {
			continue
		}
		idv, ok := robj["id"]
		if !ok {
			continue
		}
		if n, ok := idv.(float64); ok {
			ids = append(ids, int64(n))
		}
	}
	return ids, nil
}

func extractEpisodeIDsFromListBytes(raw []byte) ([]int64, error) {
	var page struct {
		Results []struct {
			ID int64 `json:"id"`
		} `json:"results"`
	}
	if err := json.Unmarshal(raw, &page); err != nil {
		return nil, err
	}
	ids := make([]int64, 0, len(page.Results))
	for _, ep := range page.Results {
		ids = append(ids, ep.ID)
	}
	return ids, nil
}

func WalkJSONDirProgress(label, root string, fn func(path string) error) error {
	return WalkFilesProgress(label, root, func(path string, d fs.DirEntry) bool {
		return filepath.Ext(path) == ".json"
	}, fn)
}
