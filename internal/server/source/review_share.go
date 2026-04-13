package source

import (
	"encoding/json"
	"strconv"
	"strings"
)

type ReviewShareEntry struct {
	ReviewID     int64
	ItemID       int64
	AuthorName   string
	Content      string
	CreatedAt    string
	Score        float64
	HasScore     bool
	ProfileImage string
}

func ParseReviewShareEntries(raw []byte, itemID int64) []ReviewShareEntry {
	var page struct {
		Results []json.RawMessage `json:"results"`
	}
	if err := json.Unmarshal(raw, &page); err != nil {
		return nil
	}

	out := make([]ReviewShareEntry, 0, len(page.Results))
	for _, result := range page.Results {
		var obj map[string]any
		if err := json.Unmarshal(result, &obj); err != nil {
			continue
		}
		reviewID, ok := reviewShareAnyToInt64(obj["id"])
		if !ok || reviewID == 0 {
			continue
		}

		entry := ReviewShareEntry{
			ReviewID:     reviewID,
			ItemID:       itemID,
			AuthorName:   strings.TrimSpace(reviewShareAnyToString(reviewShareNestedValue(obj, "profile", "name"))),
			Content:      strings.TrimSpace(reviewShareAnyToString(obj["content"])),
			CreatedAt:    reviewShareAnyToString(reviewShareFirstNonNil(obj["created"], obj["created_at"])),
			ProfileImage: reviewShareAnyToString(reviewShareNestedValue(obj, "profile", "image")),
		}
		if score, ok := reviewShareAnyToFloat64(obj["score"]); ok && score > 0 {
			entry.Score = score
			entry.HasScore = true
		}

		out = append(out, entry)
	}

	return out
}

func reviewShareNestedValue(m map[string]any, keys ...string) any {
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

func reviewShareFirstNonNil(values ...any) any {
	for _, v := range values {
		if v != nil {
			return v
		}
	}
	return nil
}

func reviewShareAnyToInt64(v any) (int64, bool) {
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

func reviewShareAnyToFloat64(v any) (float64, bool) {
	switch x := v.(type) {
	case float64:
		return x, true
	case int:
		return float64(x), true
	case int64:
		return float64(x), true
	case json.Number:
		n, err := x.Float64()
		return n, err == nil
	case string:
		n, err := strconv.ParseFloat(strings.TrimSpace(x), 64)
		return n, err == nil
	default:
		return 0, false
	}
}

func reviewShareAnyToString(v any) string {
	switch x := v.(type) {
	case string:
		return x
	case json.Number:
		return x.String()
	case float64:
		return strconv.FormatFloat(x, 'f', -1, 64)
	case int64:
		return strconv.FormatInt(x, 10)
	case int:
		return strconv.Itoa(x)
	default:
		return ""
	}
}
