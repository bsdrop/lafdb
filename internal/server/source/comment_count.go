package source

import (
	"bytes"
	"encoding/json"
	"strconv"
)

func deriveCommentCountJSON(raw []byte) ([]byte, bool) {
	if count, ok := fastTopLevelInt64(raw, `"comment_count":`); ok {
		return marshalCommentCount(count)
	}
	if count, ok := fastTopLevelInt64(raw, `"count":`); ok {
		return marshalCommentCount(count)
	}

	var page struct {
		Results []json.RawMessage `json:"results"`
	}
	if err := json.Unmarshal(raw, &page); err != nil {
		return nil, false
	}
	return marshalCommentCount(int64(len(page.Results)))
}

func marshalCommentCount(count int64) ([]byte, bool) {
	b, err := json.Marshal(struct {
		CommentCount int64 `json:"comment_count"`
	}{CommentCount: count})
	if err != nil {
		return nil, false
	}
	return b, true
}

func fastTopLevelInt64(raw []byte, key string) (int64, bool) {
	idx := bytes.Index(raw, []byte(key))
	if idx < 0 {
		return 0, false
	}
	start := idx + len(key)
	for start < len(raw) && (raw[start] == ' ' || raw[start] == '\n' || raw[start] == '\r' || raw[start] == '\t') {
		start++
	}
	end := start
	if end < len(raw) && raw[end] == '-' {
		end++
	}
	for end < len(raw) && raw[end] >= '0' && raw[end] <= '9' {
		end++
	}
	if end == start || (end == start+1 && raw[start] == '-') {
		return 0, false
	}
	n, err := strconv.ParseInt(string(raw[start:end]), 10, 64)
	if err != nil {
		return 0, false
	}
	return n, true
}
