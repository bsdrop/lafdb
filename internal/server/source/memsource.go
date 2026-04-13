package source

import (
	"log"
	"path/filepath"
	"strconv"
)

// MemData is a lightweight view of in-memory maps used by MemSource.
type MemData struct {
	EpisodesListByItemID map[int64][]byte
	EpisodeByEpisodeID   map[int64][]byte
	ItemByItemID         map[int64][]byte
	SeriesBySeriesID     map[int64][]byte
	EpisodeToItemID      map[int64]int64

	EndingItemIDs   map[int64]struct{}
	PlayableItemIDs map[int64]struct{}

	ReviewCountByItemID      map[int64][]byte
	ReviewListByItemID       map[int64][]byte
	StatisticsByItemID       map[int64][]byte
	CommentListByEpisodeID   map[int64][]byte
	CommentRepliesByParentID map[int64][]byte
	CommentShareByCommentID  map[int64]CommentShareEntry
	ReviewShareByReviewID    map[int64]ReviewShareEntry
	DRMKeyByEpisodeID        map[int64][]byte
}

// MemSource implements DataSource using in-memory maps.
type MemSource struct {
	dataDir string
	d       MemData
}

func NewMemSource(dataDir string, data MemData) *MemSource {
	return &MemSource{dataDir: dataDir, d: data}
}

func (m *MemSource) GetEpisodesList(id int64) ([]byte, bool) {
	v, ok := m.d.EpisodesListByItemID[id]
	return v, ok
}
func (m *MemSource) GetEpisode(id int64) ([]byte, bool) {
	v, ok := m.d.EpisodeByEpisodeID[id]
	return v, ok
}
func (m *MemSource) GetItem(id int64) ([]byte, bool) {
	v, ok := m.d.ItemByItemID[id]
	return v, ok
}
func (m *MemSource) GetSeries(id int64) ([]byte, bool) {
	v, ok := m.d.SeriesBySeriesID[id]
	return v, ok
}
func (m *MemSource) EpisodeItemID(epID int64) (int64, bool) {
	v, ok := m.d.EpisodeToItemID[epID]
	return v, ok
}
func (m *MemSource) GetReviewCount(id int64) ([]byte, bool) {
	v, ok := m.d.ReviewCountByItemID[id]
	return v, ok
}
func (m *MemSource) GetReviewList(id int64) ([]byte, bool) {
	v, ok := m.d.ReviewListByItemID[id]
	return v, ok
}
func (m *MemSource) GetStatistics(id int64) ([]byte, bool) {
	v, ok := m.d.StatisticsByItemID[id]
	return v, ok
}
func (m *MemSource) GetCommentCount(id int64) ([]byte, bool) {
	if raw, ok := m.d.CommentListByEpisodeID[id]; ok {
		if b, ok := deriveCommentCountJSON(raw); ok {
			return b, true
		}
	}
	path := filepath.Join(m.dataDir, "comments/v1/list", strconv.FormatInt(id, 10)+".json")
	raw, _, err := loadAndNormalizeJSON(path)
	if err != nil {
		log.Printf("warning: comment count miss %d (list cache miss, disk miss at %s: %v)", id, path, err)
		return nil, false
	}
	b, ok := deriveCommentCountJSON(raw)
	if !ok {
		log.Printf("warning: comment count decode miss %d (list present at %s)", id, path)
		return nil, false
	}
	log.Printf("warning: mem cache miss for comment count %d, derived from comment list", id)
	return b, true
}
func (m *MemSource) GetCommentList(id int64) ([]byte, bool) {
	v, ok := m.d.CommentListByEpisodeID[id]
	if ok {
		return v, ok
	}
	path := filepath.Join(m.dataDir, "comments/v1/list", strconv.FormatInt(id, 10)+".json")
	b, _, err := loadAndNormalizeJSON(path)
	if err != nil {
		log.Printf("warning: comment list miss %d (cache miss, disk miss at %s: %v)", id, path, err)
		return nil, false
	}
	log.Printf("warning: mem cache miss for comment list %d, served from disk fallback", id)
	return b, true
}
func (m *MemSource) GetCommentReplies(id int64) ([]byte, bool) {
	v, ok := m.d.CommentRepliesByParentID[id]
	if ok {
		return v, ok
	}
	path := filepath.Join(m.dataDir, "comments/v1/replies", strconv.FormatInt(id, 10)+".json")
	b, _, err := loadAndNormalizeJSON(path)
	if err != nil {
		log.Printf("warning: comment replies miss %d (cache miss, disk miss at %s: %v)", id, path, err)
		return nil, false
	}
	log.Printf("warning: mem cache miss for comment replies %d, served from disk fallback", id)
	return b, true
}
func (m *MemSource) GetDRMKey(id int64) ([]byte, bool) {
	v, ok := m.d.DRMKeyByEpisodeID[id]
	if ok {
		return v, ok
	}
	path := filepath.Join(m.dataDir, "mediacloud/keys", strconv.FormatInt(id, 10)+".json")
	b, _, err := loadAndNormalizeJSON(path)
	if err != nil {
		return nil, false
	}
	log.Printf("warning: mem cache miss for DRM key %d, served from disk fallback", id)
	return b, true
}
func (m *MemSource) GetCommentShare(id int64) (CommentShareEntry, bool) {
	v, ok := m.d.CommentShareByCommentID[id]
	if ok {
		return v, ok
	}
	ds := &DiskSource{
		dataDir:       m.dataDir,
		episodeToItem: m.d.EpisodeToItemID,
	}
	v, ok = ds.GetCommentShare(id)
	if ok {
		log.Printf("warning: mem cache miss for comment share %d, served from disk fallback", id)
	}
	return v, ok
}
func (m *MemSource) GetReviewShare(id int64) (ReviewShareEntry, bool) {
	v, ok := m.d.ReviewShareByReviewID[id]
	if ok {
		return v, ok
	}
	ds := &DiskSource{dataDir: m.dataDir}
	v, ok = ds.GetReviewShare(id)
	if ok {
		log.Printf("warning: mem cache miss for review share %d, served from disk fallback", id)
	}
	return v, ok
}
func (m *MemSource) GetPlayableItemIDs() map[int64]struct{} { return m.d.PlayableItemIDs }
func (m *MemSource) GetEndingItemIDs() map[int64]struct{}   { return m.d.EndingItemIDs }

func (m *MemSource) ForEachCommentBlob(fn func(raw []byte)) {
	for _, raw := range m.d.CommentListByEpisodeID {
		fn(raw)
	}
	for _, raw := range m.d.CommentRepliesByParentID {
		fn(raw)
	}
}

func (m *MemSource) ForEachReviewBlob(fn func(itemID int64, raw []byte)) {
	for itemID, raw := range m.d.ReviewListByItemID {
		fn(itemID, raw)
	}
}
