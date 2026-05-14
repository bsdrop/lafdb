package source

// DataSource abstracts access to the underlying JSON data.
// Two implementations:
//   - MemSource: all data loaded into RAM from Store (fast, high memory)
//   - DiskSource: reads JSON files on demand (slow per-request, minimal memory)
type DataSource interface {
	GetEpisodesList(itemID int64) ([]byte, bool)
	GetEpisode(episodeID int64) ([]byte, bool)
	GetItem(itemID int64) ([]byte, bool)
	GetSeries(seriesID int64) ([]byte, bool)
	EpisodeItemID(episodeID int64) (int64, bool)
	GetReviewCount(itemID int64) ([]byte, bool)
	GetReviewList(itemID int64) ([]byte, bool)
	GetStatistics(itemID int64) ([]byte, bool)
	GetCommentCount(episodeID int64) ([]byte, bool)
	GetCommentList(episodeID int64) ([]byte, bool)
	GetCommentReplies(parentID int64) ([]byte, bool)
	GetCommentShare(commentID int64) (CommentShareEntry, bool)
	GetReviewShare(reviewID int64) (ReviewShareEntry, bool)
	GetDRMKey(episodeID int64) ([]byte, bool)
	GetPlayableItemIDs() map[int64]struct{}
	GetEndingItemIDs() map[int64]struct{}

	// Iterators used by share index builders.
	ForEachCommentBlob(fn func(raw []byte))
	ForEachReviewBlob(fn func(itemID int64, raw []byte))
}
