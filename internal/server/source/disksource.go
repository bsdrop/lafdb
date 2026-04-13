package source

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"strconv"

	searchpkg "github.com/bsdrop/lafdb/internal/server/search"
)

// DiskSource implements DataSource by reading JSON files on demand.
// Only three lightweight indexes are kept in RAM:
//   - episodeToItem (ep ID -> item ID)
//   - playable (item IDs with a DRM key)
//   - ending   (item IDs where is_ending == true; set externally after index build)
type DiskSource struct {
	dataDir       string
	episodeToItem map[int64]int64
	playable      map[int64]struct{}
	ending        map[int64]struct{}
}

// NewDiskSource scans episodes/v3/list and mediacloud/keys to build the
// episodeToItem and playable maps. Call ds.ending = idx.EndingItemIDs()
// after BuildIndexFromDisk to complete initialisation.
func NewDiskSource(dataDir string) (*DiskSource, error) {
	ds := &DiskSource{
		dataDir:       dataDir,
		episodeToItem: make(map[int64]int64, 65536),
		playable:      make(map[int64]struct{}, 4096),
		ending:        make(map[int64]struct{}, 1024),
	}

	episodeListRoot, err := resolveWalkRoot(filepath.Join(dataDir, "episodes/v3/list"))
	if err != nil {
		return nil, err
	}
	log.Printf("[disk] scanning episodes/v3/list ...")
	_ = filepath.WalkDir(episodeListRoot, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || filepath.Ext(path) != ".json" {
			return nil
		}
		itemID, err := FileIDFromPath(path)
		if err != nil {
			return nil
		}
		raw, err := os.ReadFile(filepath.Clean(path))
		if err != nil {
			return nil
		}
		var doc struct {
			Results []struct {
				ID int64 `json:"id"`
			} `json:"results"`
		}
		if json.Unmarshal(raw, &doc) != nil {
			return nil
		}
		for _, ep := range doc.Results {
			if _, exists := ds.episodeToItem[ep.ID]; !exists {
				ds.episodeToItem[ep.ID] = itemID
			}
		}
		return nil
	})
	log.Printf("[disk] episodeToItem: %d entries", len(ds.episodeToItem))

	keysRoot, err := resolveWalkRoot(filepath.Join(dataDir, "mediacloud/keys"))
	if err != nil {
		return nil, err
	}
	log.Printf("[disk] scanning mediacloud/keys ...")
	_ = filepath.WalkDir(keysRoot, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || filepath.Ext(path) != ".json" {
			return nil
		}
		epID, err := FileIDFromPath(path)
		if err != nil {
			return nil
		}
		if itemID, ok := ds.episodeToItem[epID]; ok {
			ds.playable[itemID] = struct{}{}
		}
		return nil
	})
	log.Printf("[disk] playable items: %d", len(ds.playable))

	return ds, nil
}

// BuildIndexFromDisk reads items, review counts and statistics from disk to
// build the search index. The temporary byte maps are GC'd after Build returns.
func BuildIndexFromDisk(dataDir string) (*searchpkg.Index, error) {
	items := make(map[int64][]byte, 8192)
	reviewCounts := make(map[int64][]byte, 8192)
	statistics := make(map[int64][]byte, 8192)

	log.Printf("[disk] reading items/v4 for search index ...")
	_ = filepath.WalkDir(filepath.Join(dataDir, "items/v4"), func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || filepath.Ext(path) != ".json" {
			return nil
		}
		id, err := FileIDFromPath(path)
		if err != nil {
			return nil
		}
		b, _, err := loadAndNormalizeJSON(path)
		if err != nil {
			return nil
		}
		items[id] = b
		return nil
	})

	_ = filepath.WalkDir(filepath.Join(dataDir, "reviews/v1/count"), func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || filepath.Ext(path) != ".json" {
			return nil
		}
		id, err := FileIDFromPath(path)
		if err != nil {
			return nil
		}
		b, _, err := loadAndNormalizeJSON(path)
		if err != nil {
			return nil
		}
		reviewCounts[id] = b
		return nil
	})

	_ = filepath.WalkDir(filepath.Join(dataDir, "items/v1"), func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || filepath.Base(path) != "statistics.json" {
			return nil
		}
		n, err := strconv.ParseInt(filepath.Base(filepath.Dir(path)), 10, 64)
		if err != nil {
			return nil
		}
		b, _, err := loadAndNormalizeJSON(path)
		if err != nil {
			return nil
		}
		statistics[n] = b
		return nil
	})

	log.Printf("[disk] index input: %d items, %d reviews, %d stats",
		len(items), len(reviewCounts), len(statistics))
	return searchpkg.Build(items, reviewCounts, statistics)
}

func (d *DiskSource) readJSONID(dir string, id int64) ([]byte, bool) {
	path := filepath.Join(d.dataDir, dir, fmt.Sprintf("%d.json", id))
	b, _, err := loadAndNormalizeJSON(path)
	if err != nil {
		return nil, false
	}
	return b, true
}

func (d *DiskSource) GetEpisodesList(id int64) ([]byte, bool) {
	return d.readJSONID("episodes/v3/list", id)
}
func (d *DiskSource) GetEpisode(id int64) ([]byte, bool) { return d.readJSONID("episodes/v3", id) }
func (d *DiskSource) GetItem(id int64) ([]byte, bool)    { return d.readJSONID("items/v4", id) }
func (d *DiskSource) GetSeries(id int64) ([]byte, bool)  { return d.readJSONID("items/v2/series", id) }
func (d *DiskSource) EpisodeItemID(epID int64) (int64, bool) {
	v, ok := d.episodeToItem[epID]
	return v, ok
}
func (d *DiskSource) GetReviewCount(id int64) ([]byte, bool) {
	return d.readJSONID("reviews/v1/count", id)
}
func (d *DiskSource) GetReviewList(id int64) ([]byte, bool) {
	return d.readJSONID("reviews/v2/list", id)
}
func (d *DiskSource) GetStatistics(id int64) ([]byte, bool) {
	path := filepath.Join(d.dataDir, "items/v1", fmt.Sprintf("%d", id), "statistics.json")
	b, _, err := loadAndNormalizeJSON(path)
	if err != nil {
		return nil, false
	}
	return b, true
}
func (d *DiskSource) GetCommentCount(id int64) ([]byte, bool) {
	raw, ok := d.readJSONID("comments/v1/list", id)
	if !ok {
		return nil, false
	}
	return deriveCommentCountJSON(raw)
}
func (d *DiskSource) GetCommentList(id int64) ([]byte, bool) {
	return d.readJSONID("comments/v1/list", id)
}
func (d *DiskSource) GetCommentReplies(id int64) ([]byte, bool) {
	return d.readJSONID("comments/v1/replies", id)
}
func (d *DiskSource) GetCommentShare(targetID int64) (CommentShareEntry, bool) {
	var target CommentShareEntry
	found := false
	d.ForEachCommentBlob(func(raw []byte) {
		if found {
			return
		}
		for _, entry := range ParseCommentShareEntries(raw, 0, d.episodeToItem) {
			if entry.CommentID == targetID {
				target = entry
				found = true
				return
			}
		}
	})
	return target, found
}
func (d *DiskSource) GetReviewShare(targetID int64) (ReviewShareEntry, bool) {
	var target ReviewShareEntry
	found := false
	d.ForEachReviewBlob(func(itemID int64, raw []byte) {
		if found {
			return
		}
		for _, entry := range ParseReviewShareEntries(raw, itemID) {
			if entry.ReviewID == targetID {
				target = entry
				found = true
				return
			}
		}
	})
	return target, found
}
func (d *DiskSource) GetDRMKey(id int64) ([]byte, bool)      { return d.readJSONID("mediacloud/keys", id) }
func (d *DiskSource) GetPlayableItemIDs() map[int64]struct{} { return d.playable }
func (d *DiskSource) GetEndingItemIDs() map[int64]struct{}   { return d.ending }

func (d *DiskSource) SetEndingItemIDs(ending map[int64]struct{}) {
	d.ending = ending
}

func (d *DiskSource) ForEachCommentBlob(fn func(raw []byte)) {
	for _, root := range []string{
		filepath.Join(d.dataDir, "comments", "v1", "list"),
		filepath.Join(d.dataDir, "comments", "v1", "replies"),
	} {
		_ = filepath.WalkDir(root, func(path string, dir fs.DirEntry, err error) error {
			if err != nil || dir.IsDir() || filepath.Ext(path) != ".json" {
				return nil
			}
			raw, readErr := os.ReadFile(path)
			if readErr == nil {
				fn(raw)
			}
			return nil
		})
	}
}

func (d *DiskSource) ForEachReviewBlob(fn func(itemID int64, raw []byte)) {
	root := filepath.Join(d.dataDir, "reviews", "v2", "list")
	_ = filepath.WalkDir(root, func(path string, dir fs.DirEntry, err error) error {
		if err != nil || dir.IsDir() || filepath.Ext(path) != ".json" {
			return nil
		}
		itemID, parseErr := FileIDFromPath(path)
		if parseErr != nil {
			return nil
		}
		raw, readErr := os.ReadFile(path)
		if readErr == nil {
			fn(itemID, raw)
		}
		return nil
	})
}
