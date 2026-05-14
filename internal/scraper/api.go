package scraper

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"github.com/bsdrop/lafdb/internal/lafutil"
)

const baseAPI = "https://api.laftel.net/api"

func errCode(prefix string, err error) string {
	if err == nil {
		return prefix
	}
	msg := err.Error()
	if len(msg) > 80 {
		msg = msg[:80]
	}
	return prefix + ":" + msg
}

func statusCode(st int) string {
	return "http" + strconv.Itoa(st)
}

func (s *Scraper) fetchJSON(url string) ([]byte, string, error) {
	body, status, err := s.get(url)
	if err != nil {
		return nil, "fetch", err
	}
	if status == 404 {
		return nil, "404", nil
	}
	if status != 200 {
		snippet := body
		if len(snippet) > 120 {
			snippet = snippet[:120]
		}
		return nil, statusCode(status), fmt.Errorf("url=%s body=%q", url, snippet)
	}
	return body, "200", nil
}

func (s *Scraper) shouldSkip(path string) bool {
	if s.flags.NoSkip {
		return false
	}
	return lafutil.FileFresh(path, s.cfg.FreshAge)
}

func (s *Scraper) failStampPath(category string, id int64) string {
	return filepath.Join(s.dir(".fail-stamps"), category, fmt.Sprintf("%d", id))
}

// shouldSkipFailed returns true when this ID 404'd within the last 6 hours.
func (s *Scraper) shouldSkipFailed(category string, id int64) bool {
	if s.flags.NoSkip {
		return false
	}
	return lafutil.FileFresh(s.failStampPath(category, id), s.cfg.FailFreshAge)
}

func (s *Scraper) writeFailStamp(category string, id int64) {
	p := s.failStampPath(category, id)
	_ = os.MkdirAll(filepath.Dir(p), 0750)
	now := time.Now()
	if err := os.Chtimes(p, now, now); err != nil {
		if f, err2 := os.OpenFile(p, os.O_CREATE|os.O_WRONLY, 0644); err2 == nil {
			_ = f.Close()
		}
	}
}

func (s *Scraper) clearFailStamp(category string, id int64) {
	_ = os.Remove(s.failStampPath(category, id))
}

func (s *Scraper) commentSkipAge() time.Duration {
	if s.flags.NoSkip {
		return 0
	}
	return s.cfg.CommentAge
}

func (s *Scraper) commentStampPath(epID int64) string {
	return filepath.Join(s.dir("comments/v1/.stamps"), fmt.Sprintf("%d", epID))
}

func (s *Scraper) touchCommentStamp(epID int64) {
	p := s.commentStampPath(epID)
	now := time.Now()
	if err := os.Chtimes(p, now, now); err != nil {
		if f, err2 := os.OpenFile(p, os.O_CREATE|os.O_WRONLY, 0644); err2 == nil {
			_ = f.Close()
		}
	}
}

// filterCommentEpIDs returns only the episode IDs whose comment stamp is stale
// (older than commentSkipAge), so Run() can pass a pre-filtered list to runPool.
func (s *Scraper) filterCommentEpIDs(epIDs []int64) []int64 {
	if s.flags.NoSkip {
		return epIDs
	}
	out := make([]int64, 0, len(epIDs))
	skipAge := s.commentSkipAge()
	for _, epID := range epIDs {
		if !lafutil.FileFresh(s.commentStampPath(epID), skipAge) {
			out = append(out, epID)
		}
	}
	return out
}

func (s *Scraper) fetchItem(id int64) string {
	path := filepath.Join(s.dir("items/v4"), fmt.Sprintf("%d.json", id))
	if s.shouldSkip(path) {
		return "skip"
	}
	if s.shouldSkipFailed("items", id) {
		return "skip"
	}

	body, st, err := s.fetchJSON(fmt.Sprintf("%s/items/v4/%d/", baseAPI, id))
	if err != nil {
		s.debugf("[item] %d: %v", id, err)
		return errCode(st, err)
	}
	if st == "404" {
		s.writeFailStamp("items", id)
		return "404"
	}
	if st != "200" {
		return st
	}

	if err := lafutil.WriteFile(path, lafutil.PrettyJSON(body)); err != nil {
		return errCode("write", err)
	}
	s.clearFailStamp("items", id)

	return "200"
}

func (s *Scraper) fetchSeries(seriesID int64) string {
	path := filepath.Join(s.dir("items/v2/series"), fmt.Sprintf("%d.json", seriesID))
	if s.shouldSkip(path) {
		return "skip"
	}
	if s.shouldSkipFailed("series", seriesID) {
		return "skip"
	}

	body, st, err := s.fetchJSON(fmt.Sprintf("%s/items/v2/series/%d/", baseAPI, seriesID))
	if err != nil {
		return errCode(st, err)
	}
	if st == "404" {
		s.writeFailStamp("series", seriesID)
		return "404"
	}
	if st != "200" {
		return st
	}

	if err := lafutil.WriteFile(path, lafutil.PrettyJSON(body)); err != nil {
		return errCode("write", err)
	}
	s.clearFailStamp("series", seriesID)
	return "200"
}

func (s *Scraper) fetchEpisodeList(itemID int64) string {
	if !lafutil.FileExists(filepath.Join(s.dir("items/v4"), fmt.Sprintf("%d.json", itemID))) {
		return "skip"
	}

	savePath := filepath.Join(s.dir("episodes/v3/list"), fmt.Sprintf("%d.json", itemID))
	if s.shouldSkip(savePath) {
		return "skip"
	}
	if s.shouldSkipFailed("ep-list", itemID) {
		return "skip"
	}

	var all []json.RawMessage
	var count int

	for offset := 0; ; offset += 300 {
		body, st, err := s.fetchJSON(fmt.Sprintf(
			"%s/episodes/v3/list/?item_id=%d&offset=%d&limit=300", baseAPI, itemID, offset))
		if err != nil {
			return errCode(st, err)
		}
		if st == "404" {
			if offset == 0 {
				s.writeFailStamp("ep-list", itemID)
				return "404"
			}
			break
		}
		if st != "200" {
			return st
		}

		var page struct {
			Count   int               `json:"count"`
			Results []json.RawMessage `json:"results"`
		}
		if err := json.Unmarshal(body, &page); err != nil {
			return errCode("json", err)
		}

		count = page.Count
		if len(page.Results) == 0 {
			break
		}
		all = append(all, page.Results...)

		if len(all) >= count {
			break
		}
	}

	if len(all) == 0 {
		s.writeFailStamp("ep-list", itemID)
		return "404"
	}

	out, _ := json.Marshal(map[string]any{
		"item_id": itemID,
		"count":   count,
		"results": all,
	})
	result := writeOrErr(savePath, out)
	if result == "200" {
		s.clearFailStamp("ep-list", itemID)
	}
	return result
}

func (s *Scraper) fetchEpisodeDetail(epID int64) string {
	path := filepath.Join(s.dir("episodes/v3"), fmt.Sprintf("%d.json", epID))
	if s.shouldSkip(path) {
		return "skip"
	}
	if s.shouldSkipFailed("ep-detail", epID) {
		return "skip"
	}

	body, st, err := s.fetchJSON(fmt.Sprintf("%s/episodes/v3/%d/", baseAPI, epID))
	if err != nil {
		return errCode(st, err)
	}
	if st == "404" {
		s.writeFailStamp("ep-detail", epID)
		return "404"
	}
	if st != "200" {
		return st
	}

	if err := lafutil.WriteFile(path, lafutil.PrettyJSON(body)); err != nil {
		return errCode("write", err)
	}
	s.clearFailStamp("ep-detail", epID)

	return "200"
}

func (s *Scraper) fetchReviews(itemID int64) string {
	path := filepath.Join(s.dir("reviews/v2/list"), fmt.Sprintf("%d.json", itemID))
	all := s.fetchPaginated(fmt.Sprintf(
		"%s/reviews/v2/list/?item_id=%d&sorting=newest&limit=500", baseAPI, itemID))
	out, _ := json.Marshal(map[string]any{"item_id": itemID, "count": len(all), "results": all})
	return writeTrackedList(
		path,
		out,
		"review",
		"item",
		itemID,
		modifiedListPath(s.cfg.Root, "reviews", "item", itemID),
	)
}

func (s *Scraper) fetchStatistics(itemID int64) string {
	dir := filepath.Join(s.dir("items/v1"), fmt.Sprintf("%d", itemID))
	_ = os.MkdirAll(dir, 0750)
	return s.fetchSimple(
		fmt.Sprintf("%s/items/v1/%d/statistics/", baseAPI, itemID),
		filepath.Join(dir, "statistics.json"),
	)
}

func (s *Scraper) fetchComments(epID int64) string {
	path := filepath.Join(s.dir("comments/v1/list"), fmt.Sprintf("%d.json", epID))
	all := s.fetchPaginated(fmt.Sprintf(
		"%s/comments/v1/list/?episode_id=%d&sorting=top&limit=500&mine=false", baseAPI, epID))
	out, _ := json.Marshal(map[string]any{"episode_id": epID, "count": len(all), "results": all})
	result := writeTrackedList(
		path,
		out,
		"comment",
		"episode",
		epID,
		modifiedListPath(s.cfg.Root, "comments", "episode", epID),
	)
	if result == "200" {
		s.touchCommentStamp(epID)
	}
	return result
}

func (s *Scraper) fetchCommentReplies(parentID int64) string {
	path := filepath.Join(s.dir("comments/v1/replies"), fmt.Sprintf("%d.json", parentID))
	all := s.fetchPaginated(fmt.Sprintf(
		"%s/comments/v1/list/?parent_comment_id=%d&sorting=oldest&limit=500", baseAPI, parentID))
	out, _ := json.Marshal(map[string]any{"parent_comment_id": parentID, "count": len(all), "results": all})
	return writeTrackedList(
		path,
		out,
		"comment",
		"parent_comment",
		parentID,
		modifiedListPath(s.cfg.Root, "comments", "parent_comment", parentID),
	)
}

func (s *Scraper) fetchSimple(url, path string) string {
	if s.shouldSkip(path) {
		return "skip"
	}

	body, st, err := s.fetchJSON(url)
	if err != nil {
		return errCode(st, err)
	}
	if st != "200" {
		return st
	}

	return writeOrErr(path, body)
}

func (s *Scraper) fetchPaginated(firstURL string) []json.RawMessage {
	var all []json.RawMessage
	next := firstURL

	for next != "" {
		body, st, err := s.fetchJSON(next)
		if err != nil || st == "404" {
			break
		}
		if st != "200" {
			break
		}

		var page struct {
			Results []json.RawMessage `json:"results"`
			Next    *string           `json:"next"`
		}
		if err := json.Unmarshal(body, &page); err != nil {
			break
		}

		all = append(all, page.Results...)
		if page.Next == nil || *page.Next == next {
			break
		}
		next = *page.Next
	}

	return all
}

func writeOrErr(path string, data []byte) string {
	if err := lafutil.WriteFile(path, data); err != nil {
		return errCode("write", err)
	}
	return "200"
}
