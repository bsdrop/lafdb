package drm

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

func (c *Client) ValidEpisodeIDs() (valid, invalid []int64, err error) {
	entries, err := os.ReadDir(c.cfg.EpisodeDir)
	if err != nil {
		return nil, nil, err
	}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		id, err := strconv.ParseInt(strings.TrimSuffix(e.Name(), ".json"), 10, 64)
		if err != nil {
			continue
		}
		data, err := os.ReadFile(filepath.Join(c.cfg.EpisodeDir, e.Name()))
		if err != nil {
			continue
		}
		var ep struct {
			IsViewing bool   `json:"is_viewing"`
			Title     string `json:"title"`
		}
		if json.Unmarshal(data, &ep) != nil {
			continue
		}
		if ep.IsViewing &&
			!strings.Contains(ep.Title, "판권 만료작") &&
			!strings.Contains(ep.Title, "판권 만료 작") {
			valid = append(valid, id)
		} else {
			invalid = append(invalid, id)
		}
	}
	sort.Slice(valid, func(i, j int) bool { return valid[i] > valid[j] })
	sort.Slice(invalid, func(i, j int) bool { return invalid[i] > invalid[j] })
	return
}
