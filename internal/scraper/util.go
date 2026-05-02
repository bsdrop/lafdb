package scraper

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/bsdrop/lafdb/internal/lafutil"
)

func existingIDs(dir string) ([]int64, error) {
	entries, err := os.ReadDir(filepath.Clean(dir))
	if err != nil {
		return nil, err
	}
	var ids []int64
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		n, err := strconv.ParseInt(strings.TrimSuffix(e.Name(), ".json"), 10, 64)
		if err == nil {
			ids = append(ids, n)
		}
	}
	return ids, nil
}

func (s *Scraper) dir(sub string) string {
	return filepath.Join(s.cfg.Root, sub)
}

func collectEpisodeIDsFromLists(dir string) ([]int64, error) {
	entries, err := os.ReadDir(filepath.Clean(dir))
	if err != nil {
		return nil, err
	}

	seen := make(map[int64]struct{}, len(entries)*8)
	ids := make([]int64, 0, len(entries)*8)

	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		data, err := os.ReadFile(filepath.Clean(filepath.Join(dir, e.Name())))
		if err != nil {
			continue
		}
		var page struct {
			Results []struct {
				ID int64 `json:"id"`
			} `json:"results"`
		}
		if json.Unmarshal(data, &page) != nil {
			continue
		}
		for _, ep := range page.Results {
			if ep.ID == 0 {
				continue
			}
			if _, ok := seen[ep.ID]; ok {
				continue
			}
			seen[ep.ID] = struct{}{}
			ids = append(ids, ep.ID)
		}
	}

	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	return ids, nil
}

// reads all saved episode comment files and returns the IDs of top-level comments that have replies.
// 현재 행동: 중복이 아니어야 하고 s.shouldSkip(path) 에 걸리지 않아야 합니다.
func (s *Scraper) collectCommentIDsWithReplies() []int64 {
	listDir := filepath.Clean(s.dir("comments/v1/list"))
	repliesDir := filepath.Clean(s.dir("comments/v1/replies"))
	entries, err := os.ReadDir(listDir)
	if err != nil {
		return nil
	}

	seen := make(map[int64]struct{})
	var ids []int64

	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		if _, parseErr := strconv.ParseInt(strings.TrimSuffix(e.Name(), ".json"), 10, 64); parseErr != nil {
			continue
		}
		data, err := os.ReadFile(filepath.Clean(filepath.Join(listDir, e.Name())))
		if err != nil {
			continue
		}
		var page struct {
			Results []struct {
				ID         int64 `json:"id"`
				CountReply int   `json:"count_reply_comment"`
			} `json:"results"`
		}
		if json.Unmarshal(data, &page) != nil {
			continue
		}
		epSkipAge := s.commentSkipAge()
		for _, r := range page.Results {
			if r.CountReply == 0 {
				continue
			}
			if _, dup := seen[r.ID]; dup {
				continue
			}
			seen[r.ID] = struct{}{}
			replyPath := filepath.Join(repliesDir, fmt.Sprintf("%d.json", r.ID))
			if epSkipAge > 0 && lafutil.FileFresh(replyPath, epSkipAge) {
				continue
			}
			ids = append(ids, r.ID)
		}
	}
	return ids
}
