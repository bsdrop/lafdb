package source

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
	d MemData
}

func NewMemSource(_ string, data MemData) *MemSource {
	return &MemSource{d: data}
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
	return nil, false
}
func (m *MemSource) GetCommentList(id int64) ([]byte, bool) {
	v, ok := m.d.CommentListByEpisodeID[id]
	return v, ok
}
func (m *MemSource) GetCommentReplies(id int64) ([]byte, bool) {
	v, ok := m.d.CommentRepliesByParentID[id]
	return v, ok
}
func (m *MemSource) GetDRMKey(id int64) ([]byte, bool) {
	v, ok := m.d.DRMKeyByEpisodeID[id]
	return v, ok
}
func (m *MemSource) GetCommentShare(id int64) (CommentShareEntry, bool) {
	v, ok := m.d.CommentShareByCommentID[id]
	return v, ok
}
func (m *MemSource) GetReviewShare(id int64) (ReviewShareEntry, bool) {
	v, ok := m.d.ReviewShareByReviewID[id]
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
