package scraper

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"
	"time"

	"github.com/bsdrop/lafdb/internal/lafutil"
)

type trackedPage struct {
	Results []json.RawMessage `json:"results"`
}

type modifiedEvent struct {
	Timestamp string          `json:"ts"`
	Kind      string          `json:"kind"`
	ScopeKind string          `json:"scope_kind"`
	ScopeID   int64           `json:"scope_id"`
	ID        int64           `json:"id"`
	Op        string          `json:"op"`
	Before    json.RawMessage `json:"before,omitempty"`
	After     json.RawMessage `json:"after,omitempty"`
}

func writeTrackedList(path string, data []byte, kind, scopeKind string, scopeID int64, modifiedPath string) string {
	events, err := buildModifiedEvents(path, data, kind, scopeKind, scopeID)
	if err != nil {
		return "err"
	}
	if len(events) > 0 {
		if err := appendModifiedEvents(modifiedPath, events); err != nil {
			return "err"
		}
	}
	return writeOrErr(path, data)
}

func buildModifiedEvents(path string, newData []byte, kind, scopeKind string, scopeID int64) ([]modifiedEvent, error) {
	newPage := trackedPage{}
	if err := json.Unmarshal(newData, &newPage); err != nil {
		return nil, err
	}
	newMap := mapRawByID(newPage.Results)

	oldPage := trackedPage{}
	if raw, err := os.ReadFile(filepath.Clean(path)); err == nil {
		if err := json.Unmarshal(raw, &oldPage); err != nil {
			return nil, err
		}
	}
	oldMap := mapRawByID(oldPage.Results)

	const maxTrackedItems = 1_000_000

	oldLen := len(oldMap)
	newLen := len(newMap)
	if oldLen > maxTrackedItems || newLen > maxTrackedItems {
		return nil, fmt.Errorf("too many tracked items to build modified events")
	}
	if oldLen > math.MaxInt-newLen {
		return nil, fmt.Errorf("too many tracked items to build modified events")
	}
	combinedLen := oldLen + newLen
	if combinedLen > maxTrackedItems {
		return nil, fmt.Errorf("too many tracked items to build modified events")
	}

	ids := make([]int64, 0, combinedLen)
	seen := make(map[int64]struct{}, combinedLen)
	for id := range oldMap {
		seen[id] = struct{}{}
		ids = append(ids, id)
	}
	for id := range newMap {
		if _, ok := seen[id]; ok {
			continue
		}
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })

	now := time.Now().UTC().Format(time.RFC3339)
	events := make([]modifiedEvent, 0)
	for _, id := range ids {
		before, hadBefore := oldMap[id]
		after, hadAfter := newMap[id]
		switch {
		case !hadBefore && hadAfter:
			continue
		case hadBefore && !hadAfter:
			events = append(events, modifiedEvent{
				Timestamp: now,
				Kind:      kind,
				ScopeKind: scopeKind,
				ScopeID:   scopeID,
				ID:        id,
				Op:        "deleted",
				Before:    before,
			})
		case hadBefore && hadAfter:
			fb, err := trackedFingerprint(before)
			if err != nil {
				return nil, err
			}
			fa, err := trackedFingerprint(after)
			if err != nil {
				return nil, err
			}
			if !bytes.Equal(fb, fa) {
				events = append(events, modifiedEvent{
					Timestamp: now,
					Kind:      kind,
					ScopeKind: scopeKind,
					ScopeID:   scopeID,
					ID:        id,
					Op:        "updated",
					Before:    before,
					After:     after,
				})
			}
		}
	}
	return events, nil
}

func appendModifiedEvents(path string, events []modifiedEvent) error {
	if len(events) == 0 {
		return nil
	}
	cleanPath := filepath.Clean(path)
	if err := os.MkdirAll(filepath.Dir(cleanPath), 0750); err != nil {
		return err
	}
	f, err := os.OpenFile(cleanPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if err != nil {
		return err
	}
	defer f.Close()
	for _, ev := range events {
		line, err := json.Marshal(ev)
		if err != nil {
			return err
		}
		if _, err := f.Write(append(line, '\n')); err != nil {
			return err
		}
	}
	return f.Sync()
}

func mapRawByID(results []json.RawMessage) map[int64]json.RawMessage {
	out := make(map[int64]json.RawMessage, len(results))
	for _, raw := range results {
		id, ok := extractID(raw)
		if !ok {
			continue
		}
		out[id] = raw
	}
	return out
}

func extractID(raw json.RawMessage) (int64, bool) {
	var obj map[string]any
	if err := json.Unmarshal(raw, &obj); err != nil {
		return 0, false
	}
	return anyToInt64(obj["id"])
}

func trackedFingerprint(raw json.RawMessage) ([]byte, error) {
	var obj map[string]any
	if err := json.Unmarshal(raw, &obj); err != nil {
		return nil, err
	}
	fingerprint := map[string]any{
		"id":         obj["id"],
		"content":    obj["content"],
		"score":      obj["score"],
		"created":    obj["created"],
		"updated":    firstNonNil(obj["modified"], obj["updated"], obj["updated_at"], obj["edited"]),
		"is_spoiler": firstNonNil(obj["is_spoiler"], obj["spoiler"]),
		"profile": map[string]any{
			"name": nestedMapValue(obj, "profile", "name"),
		},
	}
	return lafutil.PrettyJSON(mustJSON(fingerprint)), nil
}

func mustJSON(v any) []byte {
	b, _ := json.Marshal(v)
	return b
}

func firstNonNil(values ...any) any {
	for _, v := range values {
		if v != nil {
			return v
		}
	}
	return nil
}

func nestedMapValue(m map[string]any, keys ...string) any {
	var cur any = m
	for _, key := range keys {
		next, ok := cur.(map[string]any)
		if !ok {
			return nil
		}
		cur = next[key]
	}
	return cur
}

func anyToInt64(v any) (int64, bool) {
	switch x := v.(type) {
	case float64:
		return int64(x), true
	case int64:
		return x, true
	case int:
		return int64(x), true
	case json.Number:
		n, err := x.Int64()
		return n, err == nil
	default:
		return 0, false
	}
}

func modifiedListPath(root, kind, scope string, id int64) string {
	return filepath.Join(root, "modified", kind, scope, fmt.Sprintf("%d.jsonl", id))
}
