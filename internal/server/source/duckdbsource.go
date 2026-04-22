package source

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"time"

	searchpkg "github.com/bsdrop/lafdb/internal/server/search"
	_ "github.com/duckdb/duckdb-go/v2"
)

// Bump when the schema changes to force a rebuild of existing cache files.
const duckDBSchemaVersion = 2

type DuckDBSource struct {
	db                          *sql.DB
	dataDir                     string
	episodeToItem               map[int64]int64
	playable                    map[int64]struct{}
	ending                      map[int64]struct{}
	commentListFileByCommentID  map[int64]int64
	commentReplyParentByReplyID map[int64]int64
}

func NewDuckDBSource(path, dataDir string) (*DuckDBSource, error) {
	db, err := sql.Open("duckdb", path)
	if err != nil {
		return nil, err
	}
	for _, q := range []string{
		`SET memory_limit='2GB'`,
		`SET threads=2`,
	} {
		if _, err := db.Exec(q); err != nil {
			log.Printf("duckdb: %s failed: %v", q, err)
		}
	}
	ds := &DuckDBSource{db: db, dataDir: dataDir}
	if err := ds.checkSchema(); err != nil {
		_ = db.Close()
		return nil, err
	}
	if err := ds.loadEpisodeToItem(); err != nil {
		_ = db.Close()
		return nil, err
	}
	if err := ds.loadSets(); err != nil {
		_ = db.Close()
		return nil, err
	}
	ds.buildCommentShareIndex()
	return ds, nil
}

func (d *DuckDBSource) Close() error {
	return d.db.Close()
}

func (d *DuckDBSource) checkSchema() error {
	var version string
	err := d.db.QueryRow(`SELECT value FROM meta WHERE key = 'schema_version'`).Scan(&version)
	if err != nil {
		return fmt.Errorf("duckdb schema not initialized: %w", err)
	}
	if version != strconv.Itoa(duckDBSchemaVersion) {
		return fmt.Errorf("unsupported duckdb schema version %q", version)
	}
	return nil
}

func (d *DuckDBSource) loadEpisodeToItem() error {
	rows, err := d.db.Query(`SELECT episode_id, item_id FROM episode_to_item`)
	if err != nil {
		return err
	}
	defer rows.Close()
	out := make(map[int64]int64)
	for rows.Next() {
		var episodeID, itemID int64
		if err := rows.Scan(&episodeID, &itemID); err != nil {
			return err
		}
		out[episodeID] = itemID
	}
	if err := rows.Err(); err != nil {
		return err
	}
	d.episodeToItem = out
	return nil
}

func (d *DuckDBSource) loadSets() error {
	var err error
	d.playable, err = loadIDSet(d.db, `SELECT item_id FROM playable_items`)
	if err != nil {
		return err
	}
	d.ending, err = loadIDSet(d.db, `SELECT item_id FROM ending_items`)
	return err
}

func loadIDSet(db *sql.DB, query string) (map[int64]struct{}, error) {
	rows, err := db.Query(query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make(map[int64]struct{})
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out[id] = struct{}{}
	}
	return out, rows.Err()
}

func (d *DuckDBSource) getBlob(kind string, id int64) ([]byte, bool) {
	var raw []byte
	err := d.db.QueryRow(`SELECT raw FROM json_blobs WHERE kind = ? AND id = ?`, kind, id).Scan(&raw)
	if err != nil {
		return nil, false
	}
	return raw, true
}

func (d *DuckDBSource) GetEpisodesList(id int64) ([]byte, bool) {
	return d.getBlob("episodes_list", id)
}
func (d *DuckDBSource) GetEpisode(id int64) ([]byte, bool)     { return d.getBlob("episode", id) }
func (d *DuckDBSource) GetItem(id int64) ([]byte, bool)        { return d.getBlob("item", id) }
func (d *DuckDBSource) GetSeries(id int64) ([]byte, bool)      { return d.getBlob("series", id) }
func (d *DuckDBSource) GetReviewCount(id int64) ([]byte, bool) { return d.getBlob("review_count", id) }
func (d *DuckDBSource) GetReviewList(id int64) ([]byte, bool)  { return d.getBlob("review_list", id) }
func (d *DuckDBSource) GetStatistics(id int64) ([]byte, bool)  { return d.getBlob("statistics", id) }
func (d *DuckDBSource) GetDRMKey(id int64) ([]byte, bool)      { return d.getBlob("drm_key", id) }
func (d *DuckDBSource) readDiskJSON(relPath string, id int64) ([]byte, bool) {
	b, _, err := loadAndNormalizeJSON(filepath.Join(d.dataDir, relPath, fmt.Sprintf("%d.json", id)))
	if err != nil {
		return nil, false
	}
	return b, true
}

func (d *DuckDBSource) GetCommentList(id int64) ([]byte, bool) {
	return d.readDiskJSON("comments/v1/list", id)
}
func (d *DuckDBSource) GetCommentReplies(id int64) ([]byte, bool) {
	return d.readDiskJSON("comments/v1/replies", id)
}

func (d *DuckDBSource) EpisodeItemID(epID int64) (int64, bool) {
	itemID, ok := d.episodeToItem[epID]
	return itemID, ok
}

func (d *DuckDBSource) GetCommentCount(id int64) ([]byte, bool) {
	raw, ok := d.GetCommentList(id)
	if !ok {
		return nil, false
	}
	return deriveCommentCountJSON(raw)
}

func (d *DuckDBSource) GetCommentShare(targetID int64) (CommentShareEntry, bool) {
	if episodeID, ok := d.commentListFileByCommentID[targetID]; ok {
		raw, ok := d.GetCommentList(episodeID)
		if !ok {
			return CommentShareEntry{}, false
		}
		return d.findCommentShareEntry(raw, targetID, episodeID)
	}
	if parentID, ok := d.commentReplyParentByReplyID[targetID]; ok {
		raw, ok := d.GetCommentReplies(parentID)
		if !ok {
			return CommentShareEntry{}, false
		}
		return d.findCommentShareEntry(raw, targetID, 0)
	}
	return CommentShareEntry{}, false
}

func (d *DuckDBSource) buildCommentShareIndex() {
	d.commentListFileByCommentID = make(map[int64]int64, 65536)
	d.commentReplyParentByReplyID = make(map[int64]int64, 16384)

	listRoot := filepath.Join(d.dataDir, "comments", "v1", "list")
	_ = filepath.WalkDir(listRoot, func(path string, dir fs.DirEntry, err error) error {
		if err != nil || dir.IsDir() || filepath.Ext(path) != ".json" {
			return nil
		}
		episodeID, err := FileIDFromPath(path)
		if err != nil {
			return nil
		}
		raw, readErr := os.ReadFile(path)
		if readErr != nil {
			return nil
		}
		for _, id := range parseCommentIDs(raw) {
			d.commentListFileByCommentID[id] = episodeID
		}
		return nil
	})

	replyRoot := filepath.Join(d.dataDir, "comments", "v1", "replies")
	_ = filepath.WalkDir(replyRoot, func(path string, dir fs.DirEntry, err error) error {
		if err != nil || dir.IsDir() || filepath.Ext(path) != ".json" {
			return nil
		}
		parentID, err := FileIDFromPath(path)
		if err != nil {
			return nil
		}
		raw, readErr := os.ReadFile(path)
		if readErr != nil {
			return nil
		}
		for _, entry := range parseCommentReplyIDs(raw, parentID) {
			d.commentReplyParentByReplyID[entry.replyID] = entry.parentID
		}
		return nil
	})

	log.Printf("[duckdb] comment share index: comments=%d replies=%d",
		len(d.commentListFileByCommentID), len(d.commentReplyParentByReplyID))
}

func (d *DuckDBSource) findCommentShareEntry(raw []byte, targetID int64, fallbackEpisodeID int64) (CommentShareEntry, bool) {
	for _, entry := range ParseCommentShareEntries(raw, fallbackEpisodeID, nil) {
		if entry.CommentID == targetID {
			if entry.ItemID == 0 && entry.EpisodeID > 0 {
				entry.ItemID, _ = d.EpisodeItemID(entry.EpisodeID)
			}
			return entry, true
		}
	}
	return CommentShareEntry{}, false
}

func (d *DuckDBSource) GetReviewShare(targetID int64) (ReviewShareEntry, bool) {
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

func (d *DuckDBSource) GetPlayableItemIDs() map[int64]struct{} { return d.playable }
func (d *DuckDBSource) GetEndingItemIDs() map[int64]struct{}   { return d.ending }

func (d *DuckDBSource) ForEachCommentBlob(fn func(raw []byte)) {
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

func (d *DuckDBSource) ForEachReviewBlob(fn func(itemID int64, raw []byte)) {
	d.forEachBlob("review_list", fn)
}

func (d *DuckDBSource) forEachBlob(kind string, fn func(id int64, raw []byte)) {
	rows, err := d.db.Query(`SELECT id, raw FROM json_blobs WHERE kind = ?`, kind)
	if err != nil {
		return
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		var raw []byte
		if rows.Scan(&id, &raw) == nil {
			fn(id, raw)
		}
	}
}

func BuildIndexFromDuckDB(path string) (*searchpkg.Index, error) {
	db, err := sql.Open("duckdb", path)
	if err != nil {
		return nil, err
	}
	defer db.Close()
	if _, err := db.Exec(`SET memory_limit='1GB'`); err != nil {
		log.Printf("duckdb: SET memory_limit failed: %v", err)
	}

	items, err := loadBlobMap(db, "item")
	if err != nil {
		return nil, err
	}
	reviewCounts, err := loadBlobMap(db, "review_count")
	if err != nil {
		return nil, err
	}
	statistics, err := loadBlobMap(db, "statistics")
	if err != nil {
		return nil, err
	}
	log.Printf("[duckdb] index input: %d items, %d reviews, %d stats", len(items), len(reviewCounts), len(statistics))
	return searchpkg.Build(items, reviewCounts, statistics)
}

func loadBlobMap(db *sql.DB, kind string) (map[int64][]byte, error) {
	rows, err := db.Query(`SELECT id, raw FROM json_blobs WHERE kind = ?`, kind)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make(map[int64][]byte)
	for rows.Next() {
		var id int64
		var raw []byte
		if err := rows.Scan(&id, &raw); err != nil {
			return nil, err
		}
		out[id] = raw
	}
	return out, rows.Err()
}

func BuildDuckDBFromDisk(dataDir, dbPath string) error {
	start := time.Now()
	dbPath = filepath.Clean(dbPath)
	if dir := filepath.Dir(dbPath); dir != "." {
		if err := os.MkdirAll(dir, 0750); err != nil {
			return err
		}
	}
	tmp := dbPath + ".tmp"
	_ = os.Remove(tmp)
	_ = os.Remove(tmp + ".wal")

	db, err := sql.Open("duckdb", tmp)
	if err != nil {
		return err
	}
	if _, err := db.Exec(`SET memory_limit='4GB'`); err != nil {
		log.Printf("duckdb: SET memory_limit failed: %v", err)
	}
	ok := false
	defer func() {
		_ = db.Close()
		if !ok {
			_ = os.Remove(tmp)
			_ = os.Remove(tmp + ".wal")
		}
	}()

	if err := initDuckDBSchema(db); err != nil {
		return err
	}
	if err := populateDuckDB(dataDir, db); err != nil {
		return err
	}
	if _, err := db.Exec(`CHECKPOINT`); err != nil {
		return err
	}
	_ = db.Close()
	if err := os.Rename(tmp, dbPath); err != nil {
		return err
	}
	ok = true
	log.Printf("duckdb cache built at %s in %s", dbPath, time.Since(start))
	return nil
}

func initDuckDBSchema(db *sql.DB) error {
	stmts := []string{
		`CREATE TABLE meta (key VARCHAR PRIMARY KEY, value VARCHAR)`,
		`CREATE TABLE json_blobs (kind VARCHAR, id BIGINT, raw BLOB, PRIMARY KEY(kind, id))`,
		`CREATE TABLE episode_to_item (episode_id BIGINT PRIMARY KEY, item_id BIGINT)`,
		`CREATE TABLE playable_items (item_id BIGINT PRIMARY KEY)`,
		`CREATE TABLE ending_items (item_id BIGINT PRIMARY KEY)`,
	}
	for _, stmt := range stmts {
		if _, err := db.Exec(stmt); err != nil {
			return err
		}
	}
	_, err := db.Exec(`INSERT INTO meta VALUES ('schema_version', ?)`, duckDBSchemaVersion)
	return err
}

// txInsertDir walks relDir, normalises each JSON file, inserts it as a blob of
// the given kind, and optionally calls fn for additional per-row work.
// All inserts go through the caller's transaction.
func txInsertDir(tx *sql.Tx, dataDir, label, relDir, kind string, fn func(id int64, raw []byte) error) error {
	insertBlob, err := tx.Prepare(`INSERT INTO json_blobs VALUES (?, ?, ?)`)
	if err != nil {
		return err
	}
	defer insertBlob.Close()

	root := filepath.Join(dataDir, relDir)
	if _, err := os.Stat(root); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			log.Printf("[duckdb] %s missing, skipping", label)
			return nil
		}
		return err
	}
	count := 0
	err = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			if path != root {
				return filepath.SkipDir
			}
			return nil
		}
		if filepath.Ext(path) != ".json" {
			return nil
		}
		id, err := FileIDFromPath(path)
		if err != nil {
			return nil
		}
		raw, _, err := loadAndNormalizeJSON(path)
		if err != nil {
			return nil
		}
		if _, err := insertBlob.Exec(kind, id, raw); err != nil {
			return err
		}
		count++
		if fn != nil {
			return fn(id, raw)
		}
		return nil
	})
	log.Printf("[duckdb] loaded %s: %d", label, count)
	return err
}

func populateDuckDB(dataDir string, db *sql.DB) error {
	// episodeToItem is built in phase 1 and reused in phase 4.
	episodeToItem := make(map[int64]int64, 131072)

	// runPhase executes fn in a dedicated transaction.  Splitting into multiple
	// transactions keeps each WAL small and avoids multi-GB memory pressure that
	// a single giant transaction would create for large datasets.
	runPhase := func(fn func(*sql.Tx) error) error {
		tx, err := db.Begin()
		if err != nil {
			return err
		}
		if err := fn(tx); err != nil {
			_ = tx.Rollback()
			return err
		}
		return tx.Commit()
	}

	// Phase 1: items, series, episodes, episode_lists.
	if err := runPhase(func(tx *sql.Tx) error {
		insertEnding, err := tx.Prepare(`INSERT OR IGNORE INTO ending_items VALUES (?)`)
		if err != nil {
			return err
		}
		defer insertEnding.Close()

		if err := txInsertDir(tx, dataDir, "items/v4", "items/v4", "item", func(id int64, raw []byte) error {
			var item struct {
				IsEnding bool `json:"is_ending"`
			}
			if json.Unmarshal(raw, &item) == nil && item.IsEnding {
				_, err := insertEnding.Exec(id)
				return err
			}
			return nil
		}); err != nil {
			return err
		}
		if err := txInsertDir(tx, dataDir, "items/v2/series", "items/v2/series", "series", nil); err != nil {
			return err
		}
		if err := txInsertDir(tx, dataDir, "episodes/v3", "episodes/v3", "episode", nil); err != nil {
			return err
		}

		insertEpisodeToItem, err := tx.Prepare(`INSERT OR IGNORE INTO episode_to_item VALUES (?, ?)`)
		if err != nil {
			return err
		}
		defer insertEpisodeToItem.Close()

		return txInsertDir(tx, dataDir, "episodes/v3/list", "episodes/v3/list", "episodes_list", func(itemID int64, raw []byte) error {
			episodeIDs, err := extractDuckDBEpisodeIDsFromList(raw)
			if err != nil {
				return nil
			}
			for _, episodeID := range episodeIDs {
				if _, exists := episodeToItem[episodeID]; exists {
					continue
				}
				episodeToItem[episodeID] = itemID
				if _, err := insertEpisodeToItem.Exec(episodeID, itemID); err != nil {
					return err
				}
			}
			return nil
		})
	}); err != nil {
		return err
	}

	// Phase 2: reviews and statistics.
	if err := runPhase(func(tx *sql.Tx) error {
		if err := txInsertDir(tx, dataDir, "reviews/v1/count", "reviews/v1/count", "review_count", nil); err != nil {
			return err
		}
		if err := txInsertDir(tx, dataDir, "reviews/v2/list", "reviews/v2/list", "review_list", nil); err != nil {
			return err
		}
		return insertStatistics(dataDir, tx)
	}); err != nil {
		return err
	}

	// Phase 3: DRM keys + playable items.
	// Comments are served directly from disk (see DuckDBSource.GetCommentList).
	if err := runPhase(func(tx *sql.Tx) error {
		insertPlayable, err := tx.Prepare(`INSERT OR IGNORE INTO playable_items VALUES (?)`)
		if err != nil {
			return err
		}
		defer insertPlayable.Close()

		return txInsertDir(tx, dataDir, "mediacloud/keys", "mediacloud/keys", "drm_key", func(epID int64, _ []byte) error {
			if itemID, ok := episodeToItem[epID]; ok {
				_, err := insertPlayable.Exec(itemID)
				return err
			}
			return nil
		})
	}); err != nil {
		return err
	}

	return nil
}

func extractDuckDBEpisodeIDsFromList(raw []byte) ([]int64, error) {
	var doc struct {
		Results []struct {
			ID int64 `json:"id"`
		} `json:"results"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, err
	}
	out := make([]int64, 0, len(doc.Results))
	for _, ep := range doc.Results {
		if ep.ID > 0 {
			out = append(out, ep.ID)
		}
	}
	return out, nil
}

func insertStatistics(dataDir string, tx *sql.Tx) error {
	insertBlob, err := tx.Prepare(`INSERT INTO json_blobs VALUES (?, ?, ?)`)
	if err != nil {
		return err
	}
	defer insertBlob.Close()

	root := filepath.Join(dataDir, "items/v1")
	if _, err := os.Stat(root); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	count := 0
	err = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || filepath.Base(path) != "statistics.json" {
			return nil
		}
		id, err := strconv.ParseInt(filepath.Base(filepath.Dir(path)), 10, 64)
		if err != nil {
			return nil
		}
		raw, _, err := loadAndNormalizeJSON(path)
		if err != nil {
			return nil
		}
		if _, err := insertBlob.Exec("statistics", id, raw); err != nil {
			return err
		}
		count++
		return nil
	})
	log.Printf("[duckdb] loaded items/v1/statistics: %d", count)
	return err
}
