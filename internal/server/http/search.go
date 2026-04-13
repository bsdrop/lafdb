package http

import (
	"encoding/json"
	"strconv"
	"strings"

	searchpkg "github.com/bsdrop/lafdb/internal/server/search"
	sourcepkg "github.com/bsdrop/lafdb/internal/server/source"
	"github.com/gofiber/fiber/v3"
)

type paginatedResponse struct {
	Count   int               `json:"count"`
	Results []json.RawMessage `json:"results"`
	Next    *string           `json:"next"`
}

func resolveItems(ds sourcepkg.DataSource, ids []int64) []json.RawMessage {
	out := make([]json.RawMessage, 0, len(ids))
	for _, id := range ids {
		if b, ok := ds.GetItem(id); ok {
			out = append(out, json.RawMessage(b))
		}
	}
	return out
}

func nextURL(c fiber.Ctx, nextOffset, size, total int, extra string) *string {
	if nextOffset >= total {
		return nil
	}
	var b strings.Builder
	b.Grow(len(extra) + len(c.Path()) + len(requestHost(c)) + 32)
	b.WriteString(requestScheme(c))
	b.WriteString("://")
	b.WriteString(requestHost(c))
	b.WriteString(c.Path())
	b.WriteByte('?')
	b.WriteString(extra)
	b.WriteString("offset=")
	b.WriteString(strconv.Itoa(nextOffset))
	b.WriteString("&size=")
	b.WriteString(strconv.Itoa(size))
	s := b.String()
	return &s
}

func parseOptBool(s string) *bool {
	switch strings.ToLower(s) {
	case "true", "1":
		t := true
		return &t
	case "false", "0":
		f := false
		return &f
	}
	return nil
}

func splitParam(s string) []string {
	if s == "" {
		return nil
	}
	return strings.Split(s, ",")
}

// GET /api/search/v3/keyword/
// ?keyword=귀멸&offset=0&size=24&viewing_only=true
func handleKeyword(appState *App) fiber.Handler {
	return func(c fiber.Ctx) error {
		search := appState.searchIndex()
		ds := appState.dataSource()

		keyword := strings.TrimSpace(c.Query("keyword"))
		if keyword == "" {
			c.Status(fiber.StatusBadRequest)
			return sendJSON(c, fiber.Map{"error": "keyword is required"})
		}
		offset, _ := strconv.Atoi(c.Query("offset"))
		size, _ := strconv.Atoi(c.Query("size"))
		if size <= 0 {
			size = 24
		}
		if size > 1000 {
			size = 1000
		}
		if offset < 0 {
			offset = 0
		}

		result := search.Search(searchpkg.Query{
			Q:        keyword,
			Original: parseOptBool(c.Query("original")),
			Ending:   parseOptBool(c.Query("ending")),
			Offset:   offset,
			Size:     size,
		})

		extra := "keyword=" + keyword + "&"
		if v := c.Query("viewing_only"); v != "" {
			extra += "viewing_only=" + v + "&"
		}
		if v := c.Query("original"); v != "" {
			extra += "original=" + v + "&"
		}
		if v := c.Query("ending"); v != "" {
			extra += "ending=" + v + "&"
		}

		return sendJSON(c, paginatedResponse{
			Count:   result.Found,
			Results: resolveItems(ds, result.IDs),
			Next:    nextURL(c, offset+size, size, result.Found, extra),
		})
	}
}

// GET /api/search/v1/discover/
func handleDiscover(appState *App) fiber.Handler {
	return func(c fiber.Ctx) error {
		search := appState.searchIndex()
		ds := appState.dataSource()

		offset, _ := strconv.Atoi(c.Query("offset"))
		size, _ := strconv.Atoi(c.Query("size"))
		if size <= 0 {
			size = 24
		}
		if size > 1000 {
			size = 1000
		}
		if offset < 0 {
			offset = 0
		}

		result := search.Search(searchpkg.Query{
			Genres:        splitParam(c.Query("genres")),
			ExcludeGenres: splitParam(c.Query("exclude_genres")),
			Tags:          splitParam(c.Query("tags")),
			ExcludeTags:   splitParam(c.Query("exclude_tags")),
			Medium:        c.Query("medium"),
			Year:          c.Query("years"),
			Original:      parseOptBool(c.Query("original")),
			Ending:        parseOptBool(c.Query("ending")),
			Sort:          c.Query("sort"),
			Offset:        offset,
			Size:          size,
		})

		var extra strings.Builder
		for _, p := range []string{"sort", "genres", "tags", "exclude_genres", "exclude_tags", "original", "ending", "medium", "years", "svod"} {
			if v := c.Query(p); v != "" {
				extra.WriteString(p + "=" + v + "&")
			}
		}

		return sendJSON(c, paginatedResponse{
			Count:   result.Found,
			Results: resolveItems(ds, result.IDs),
			Next:    nextURL(c, offset+size, size, result.Found, extra.String()),
		})
	}
}

func handleAutocomplete(appState *App) fiber.Handler {
	return func(c fiber.Ctx) error {
		search := appState.searchIndex()

		q := strings.TrimSpace(c.Query("keyword"))
		if q == "" {
			q = strings.TrimSpace(c.Query("q"))
		}
		if q == "" {
			c.Status(fiber.StatusBadRequest)
			return sendJSON(c, fiber.Map{"error": "keyword is required"})
		}
		return sendJSON(c, search.Autocomplete(q, 10))
	}
}
