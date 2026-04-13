package drm

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/bsdrop/lafdb/internal/lafutil"
)

type keyData struct {
	EpisodeID int64          `json:"episode_id"`
	DashURL   string         `json:"dash_url"`
	PSSH      string         `json:"pssh"`
	Keys      []keyEntry     `json:"keys"`
	Markers   map[string]any `json:"markers,omitempty"`
}

type Result struct {
	Status  string // "ok" | "skip" | "error" | "throttled"
	WaitSec int
	Err     error
}

func (c *Client) FetchKeys(episodeID int64) Result {
	savePath := filepath.Join(c.cfg.KeyDir, fmt.Sprintf("%d.json", episodeID))
	if _, err := os.Stat(savePath); err == nil {
		return Result{Status: "skip"}
	}

	info, err := c.getVideoStream(episodeID)
	if err != nil {
		if strings.Contains(err.Error(), "THROTTLED") {
			return Result{Status: "throttled", WaitSec: parseThrottleWait(err.Error()), Err: err}
		}
		if strings.HasPrefix(err.Error(), "NO_TOKEN:") {
			return Result{Status: "no-token", Err: err}
		}
		return Result{Status: "error", Err: err}
	}
	defer c.closePlayLog(info.PlayLogID)

	if info.DashURL == "" || info.DRMToken == "" {
		return Result{Status: "no-token", Err: fmt.Errorf("missing DASH URL or DRM token")}
	}
	mpdText, err := c.fetchMPD(info.DashURL)
	if err != nil {
		return Result{Status: "error", Err: fmt.Errorf("MPD: %w", err)}
	}
	pssh := extractPSSH(mpdText)
	if pssh == "" {
		return Result{Status: "error", Err: fmt.Errorf("PSSH not found")}
	}
	keys, err := c.requestKeys(pssh, info.DRMToken)
	if err != nil {
		return Result{Status: "error", Err: err}
	}

	b, _ := json.MarshalIndent(keyData{
		EpisodeID: episodeID,
		DashURL:   info.DashURL,
		PSSH:      pssh,
		Keys:      keys,
		Markers:   info.Markers,
	}, "", "  ")
	if err := lafutil.WriteFile(savePath, b); err != nil {
		return Result{Status: "error", Err: err}
	}
	return Result{Status: "ok"}
}

func (c *Client) Run(skipFirst int, skipFailed bool) error {
	valid, invalid, err := c.ValidEpisodeIDs()
	if err != nil {
		return fmt.Errorf("reading episodes: %w", err)
	}
	existingKeys, err := c.existingKeyIDs()
	if err != nil {
		return fmt.Errorf("reading existing keys: %w", err)
	}

	ids := append(valid, invalid...)
	sort.Slice(ids, func(i, j int) bool { return ids[i] > ids[j] })
	invalidSet := make(map[int64]bool, len(invalid))
	for _, id := range invalid {
		invalidSet[id] = true
	}

	filtered := ids[:0]
	var existingCount int
	var existingInvalidCount int
	for _, id := range ids {
		if !existingKeys[id] {
			filtered = append(filtered, id)
			continue
		}
		existingCount++
		if invalidSet[id] {
			existingInvalidCount++
		}
	}
	ids = filtered

	total := len(ids)
	failedPath := filepath.Join(c.cfg.MediacloudDir, "drm_failed.json")
	failedSet := loadFailed(failedPath)
	log.Printf("processing %d episodes (%d likely invalid, existing=%d, skip-first=%d, known-failed=%d)",
		total, len(invalid)-existingInvalidCount, existingCount, skipFirst, len(failedSet))

	statusPath := filepath.Join(c.cfg.MediacloudDir, "drm_status.json")
	var success, skipped, fail, invalidRem int
	invalidRem = len(invalid)

	for i := skipFirst; i < len(ids); i++ {
		if c.stopping.Load() {
			break
		}
		id := ids[i]

		if skipFailed && failedSet[id] {
			skipped++
			if invalidSet[id] {
				invalidRem--
			}
			continue
		}

		res := c.FetchKeys(id)

		switch res.Status {
		case "ok":
			success++
			log.Printf("✓ %d  (%d/%d)", id, i+1, total)
		case "skip":
			skipped++
		case "no-token":
			fail++
			log.Printf("✗ %d: no token (saved to drm_failed.json)", id)
			if !failedSet[id] {
				failedSet[id] = true
				saveFailed(failedPath, failedSet)
			}
		case "throttled":
			fail++
			log.Printf("⏳ throttled %d, waiting %ds", id, res.WaitSec)
			time.Sleep(time.Duration(res.WaitSec) * time.Second)
		case "error":
			fail++
			log.Printf("✗ %d: %v", id, res.Err)
		}
		if invalidSet[id] {
			invalidRem--
		}
		writeStatus(statusPath, map[string]any{
			"total": total, "current": i + 1,
			"remaining": total - (i + 1),
			"success":   success, "skipped": skipped, "fail": fail,
			"invalidCount": invalidRem, "syncing": true,
			"lastUpdate": time.Now().UnixMilli(),
		})
		if res.Status != "skip" && c.cfg.SleepMs > 0 {
			time.Sleep(time.Duration(c.cfg.SleepMs) * time.Millisecond)
		}
	}

	log.Printf("done: ok=%d skip=%d fail=%d", success, skipped, fail)
	writeStatus(statusPath, map[string]any{
		"success": success, "skipped": skipped, "fail": fail,
		"invalidCount": invalidRem, "syncing": false,
		"lastUpdate": time.Now().UnixMilli(),
	})
	return nil
}

func (c *Client) existingKeyIDs() (map[int64]bool, error) {
	entries, err := os.ReadDir(c.cfg.KeyDir)
	if err != nil {
		if os.IsNotExist(err) {
			return map[int64]bool{}, nil
		}
		return nil, err
	}
	ids := make(map[int64]bool, len(entries))
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		id, err := strconv.ParseInt(strings.TrimSuffix(e.Name(), ".json"), 10, 64)
		if err != nil {
			continue
		}
		ids[id] = true
	}
	return ids, nil
}

func loadFailed(path string) map[int64]bool {
	data, err := os.ReadFile(filepath.Clean(path))
	if err != nil {
		return map[int64]bool{}
	}
	var ids []int64
	if err := json.Unmarshal(data, &ids); err != nil {
		return map[int64]bool{}
	}
	set := make(map[int64]bool, len(ids))
	for _, id := range ids {
		set[id] = true
	}
	return set
}

func saveFailed(path string, set map[int64]bool) {
	ids := make([]int64, 0, len(set))
	for id := range set {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] > ids[j] })
	b, _ := json.Marshal(ids)
	_ = lafutil.WriteFile(path, b)
}

func parseThrottleWait(msg string) int {
	const marker = "Expected available in "
	idx := strings.Index(msg, marker)
	if idx == -1 {
		return 60
	}
	n, _ := strconv.Atoi(strings.Fields(msg[idx+len(marker):])[0])
	if n <= 0 {
		return 60
	}
	return n
}

func writeStatus(path string, v any) {
	b, _ := json.Marshal(v)
	_ = lafutil.WriteFile(path, b)
}
