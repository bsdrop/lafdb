package drm

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/bsdrop/lafdb/internal/lafutil"
)

const (
	baseAPI          = "https://api.laftel.net/api"
	baseMC           = "https://mediacloud.laftel.net/"
	widevineSystemID = "edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"
)

type streamInfo struct {
	DashURL   string
	DRMToken  string
	PlayLogID int64
	Markers   map[string]any
}

func (c *Client) getVideoStream(episodeID int64) (*streamInfo, error) {
	body, status, err := c.get(
		fmt.Sprintf("%s/episodes/v3/%d/video/?device=Web", baseAPI, episodeID), true)
	if err != nil {
		return nil, err
	}
	if status != 200 {
		return nil, fmt.Errorf("HTTP %d", status)
	}

	var raw struct {
		Protected *struct {
			DashURL string `json:"dash_url"`
			Token   string `json:"widevine_token"`
		} `json:"protected_streaming_info"`
		Playback *struct {
			OpStart *float64 `json:"op_start"`
			OpEnd   *float64 `json:"op_end"`
			EdStart *float64 `json:"ed_start"`
			EdEnd   *float64 `json:"ed_end"`
		} `json:"playback_info"`
		PlayLogID *int64 `json:"play_log_id"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil, err
	}
	if raw.Protected == nil {
		return nil, fmt.Errorf("NO_TOKEN: no protected_streaming_info")
	}

	info := &streamInfo{DashURL: raw.Protected.DashURL, DRMToken: raw.Protected.Token}
	if raw.PlayLogID != nil {
		info.PlayLogID = *raw.PlayLogID
	}
	if pb := raw.Playback; pb != nil {
		m := map[string]any{}
		if pb.OpStart != nil && pb.OpEnd != nil {
			m["opening"] = map[string]any{"start": *pb.OpStart, "end": *pb.OpEnd}
		}
		if pb.EdStart != nil && pb.EdEnd != nil {
			m["ending"] = map[string]any{"start": *pb.EdStart, "end": *pb.EdEnd}
		}
		if len(m) > 0 {
			info.Markers = m
		}
	}
	return info, nil
}

func (c *Client) closePlayLog(id int64) {
	if id == 0 {
		return
	}
	// best-effort PATCH; ignore errors
	payload, _ := json.Marshal(map[string]any{
		"total_play_time":  "00:00:00",
		"play_end_offset":  "00:00:00",
		"is_player_exit":   true,
		"is_player_paused": true,
	})
	req, _ := newJSONRequest("PATCH",
		fmt.Sprintf("%s/play_logs/%d/", baseAPI, id), payload, c.cfg.Token)
	resp, err := c.http.Do(req)
	if err == nil {
		_, _ = io.Copy(io.Discard, resp.Body)
		_ = resp.Body.Close()
	}
}

func (c *Client) fetchMPD(dashURL string) (string, error) {
	rel := strings.TrimPrefix(dashURL, baseMC)
	local := filepath.Clean(filepath.Join(c.cfg.MediacloudDir, filepath.FromSlash(rel)))
	if data, err := os.ReadFile(local); err == nil {
		return string(data), nil
	}
	body, status, err := lafutil.Get(c.http, dashURL, nil)
	if err != nil {
		return "", err
	}
	if status != 200 {
		return "", fmt.Errorf("HTTP %d", status)
	}
	_ = lafutil.WriteFile(local, body)
	return string(body), nil
}

func extractPSSH(mpd string) string {
	idx := strings.Index(strings.ToLower(mpd), widevineSystemID)
	if idx == -1 {
		return ""
	}
	start := strings.Index(mpd[idx:], "<cenc:pssh>")
	if start == -1 {
		return ""
	}
	start += idx + len("<cenc:pssh>")
	end := strings.Index(mpd[start:], "</cenc:pssh>")
	if end == -1 {
		return ""
	}
	return strings.TrimSpace(mpd[start : start+end])
}
