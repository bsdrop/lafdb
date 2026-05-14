package source

import (
	"encoding/json"
	"strconv"
	"strings"
)

type CommentShareEntry struct {
	CommentID       int64
	ParentCommentID int64
	IsReply         bool
	AuthorName      string
	Content         string
	CreatedAt       string
	ItemID          int64
	ItemName        string
	EpisodeID       int64
	EpisodeSubject  string
	EpisodeNum      string
}

func ParseCommentShareEntries(raw []byte, fallbackEpisodeID int64, episodeToItem map[int64]int64) []CommentShareEntry {
	var page struct {
		Results []json.RawMessage `json:"results"`
	}
	if err := json.Unmarshal(raw, &page); err != nil {
		return nil
	}

	out := make([]CommentShareEntry, 0, len(page.Results))
	for _, result := range page.Results {
		var obj map[string]any
		if err := json.Unmarshal(result, &obj); err != nil {
			continue
		}

		commentID, ok := commentShareAnyToInt64(obj["id"])
		if !ok || commentID == 0 {
			continue
		}

		entry := CommentShareEntry{
			CommentID:      commentID,
			AuthorName:     strings.TrimSpace(commentShareAnyToString(commentShareNestedValue(obj, "profile", "name"))),
			Content:        strings.TrimSpace(commentShareAnyToString(obj["content"])),
			CreatedAt:      commentShareAnyToString(commentShareFirstNonNil(obj["created"], obj["created_at"])),
			ItemName:       strings.TrimSpace(commentShareAnyToString(commentShareNestedValue(obj, "item", "name"))),
			EpisodeSubject: strings.TrimSpace(commentShareAnyToString(commentShareNestedValue(obj, "episode", "subject"))),
			EpisodeNum:     strings.TrimSpace(commentShareAnyToString(commentShareNestedValue(obj, "episode", "episode_num"))),
		}

		if parentID, ok := commentShareAnyToInt64(obj["parent_comment_id"]); ok && parentID > 0 {
			entry.IsReply = true
			entry.ParentCommentID = parentID
		}

		if episodeID, ok := commentShareAnyToInt64(commentShareNestedValue(obj, "episode", "id")); ok && episodeID > 0 {
			entry.EpisodeID = episodeID
		} else if fallbackEpisodeID > 0 {
			entry.EpisodeID = fallbackEpisodeID
		}

		if itemID, ok := commentShareAnyToInt64(commentShareNestedValue(obj, "item", "id")); ok && itemID > 0 {
			entry.ItemID = itemID
		} else if entry.EpisodeID > 0 && episodeToItem != nil {
			entry.ItemID = episodeToItem[entry.EpisodeID]
		}

		out = append(out, entry)
	}

	return out
}

func commentShareNestedValue(m map[string]any, keys ...string) any {
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

func commentShareFirstNonNil(values ...any) any {
	for _, v := range values {
		if v != nil {
			return v
		}
	}
	return nil
}

func commentShareAnyToInt64(v any) (int64, bool) {
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
	case string:
		n, err := strconv.ParseInt(strings.TrimSpace(x), 10, 64)
		return n, err == nil
	default:
		return 0, false
	}
}

func commentShareAnyToString(v any) string {
	switch x := v.(type) {
	case string:
		return x
	case json.Number:
		return x.String()
	case float64:
		return strconv.FormatInt(int64(x), 10)
	case int64:
		return strconv.FormatInt(x, 10)
	case int:
		return strconv.Itoa(x)
	default:
		return ""
	}
}
