package http

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"net/url"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"

	mediapkg "github.com/bsdrop/lafdb/internal/server/media"
	searchpkg "github.com/bsdrop/lafdb/internal/server/search"
	sourcepkg "github.com/bsdrop/lafdb/internal/server/source"
	"github.com/gofiber/fiber/v3"
)

func stripPort(host string) string {
	host = strings.TrimSpace(host)
	if host == "" {
		return ""
	}
	if strings.HasPrefix(host, "[") && strings.HasSuffix(host, "]") {
		return strings.Trim(host, "[]")
	}
	if i := strings.LastIndex(host, ":"); i > strings.LastIndex(host, "]") {
		return host[:i]
	}
	return strings.Trim(host, "[]")
}

var (
	notFoundJSON       = []byte(`{"detail":"Not found.","code":"NOT_FOUND"}`)
	emptyPaginatedJSON = []byte(`{"count":0,"next":null,"results":[]}`)
)

const (
	mimeMsgpack  = "application/msgpack"
	mimeXMsgpack = "application/x-msgpack"
)

func acceptedMsgpack(c fiber.Ctx) string {
	best := c.Accepts("application/json", mimeMsgpack, mimeXMsgpack)
	if best == mimeMsgpack || best == mimeXMsgpack {
		return best
	}
	return ""
}

func sendJSONBytes(c fiber.Ctx, b []byte) error {
	c.Set("Vary", fiber.HeaderAccept)
	mirror := getMirrorRoot(c)
	if mirror != "" && mirror != "latfel.net" {
		b = rewriteCdnJSONForMirror(b, mirror)
	}

	if accept := acceptedMsgpack(c); accept != "" {
		mp, err := jsonToMsgpack(b)
		if err == nil {
			c.Set(fiber.HeaderContentType, accept)
			return c.Send(mp)
		}
		// conversion failed — fall through to JSON
	}
	c.Set(fiber.HeaderContentType, fiber.MIMEApplicationJSONCharsetUTF8)
	return c.Send(b)
}

func isAnonymousNetworkHost(host string) bool {
	host = strings.ToLower(strings.TrimSpace(stripPort(host)))
	host = strings.TrimRight(host, ".")
	return strings.HasSuffix(host, ".onion") || strings.HasSuffix(host, ".i2p")
}

func isI2PHost(host string) bool {
	host = strings.ToLower(strings.TrimSpace(stripPort(host)))
	host = strings.TrimRight(host, ".")
	return strings.HasSuffix(host, ".i2p")
}

var cdnSubdomains = []string{"mediacloud", "streaming-bp", "thumbnail"}

func rewriteCdnJSONForMirror(b []byte, mirror string) []byte {
	if isI2PHost(mirror) {
		for _, subdomain := range cdnSubdomains {
			for _, sourceDomain := range []string{"latfel.net", "laftel.net"} {
				fromHTTPS := []byte("https://" + subdomain + "." + sourceDomain + "/")
				fromHTTP := []byte("http://" + subdomain + "." + sourceDomain + "/")
				to := []byte("http://" + mirror + "/" + subdomain + "/")
				b = bytes.ReplaceAll(b, fromHTTPS, to)
				b = bytes.ReplaceAll(b, fromHTTP, to)
			}
		}
		return b
	}

	b = bytes.ReplaceAll(b, []byte(".latfel.net"), []byte("."+mirror))
	b = bytes.ReplaceAll(b, []byte(".laftel.net"), []byte("."+mirror))
	if !isAnonymousNetworkHost(mirror) {
		return b
	}
	for _, subdomain := range cdnSubdomains {
		from := []byte("https://" + subdomain + "." + mirror)
		to := []byte("http://" + subdomain + "." + mirror)
		b = bytes.ReplaceAll(b, from, to)
	}
	return b
}

func rewriteCDNStringForMirror(s string, mirror string) string {
	if mirror != "" && mirror != "laftel.net" && mirror != "latfel.net" {
		if isI2PHost(mirror) {
			for _, subdomain := range cdnSubdomains {
				for _, sourceDomain := range []string{"latfel.net", "laftel.net"} {
					to := "http://" + mirror + "/" + subdomain + "/"
					s = strings.ReplaceAll(s, "https://"+subdomain+"."+sourceDomain+"/", to)
					s = strings.ReplaceAll(s, "http://"+subdomain+"."+sourceDomain+"/", to)
				}
			}
			return s
		}

		s = strings.ReplaceAll(s, ".laftel.net", "."+mirror)
		s = strings.ReplaceAll(s, ".latfel.net", "."+mirror)
		if isAnonymousNetworkHost(mirror) {
			for _, subdomain := range cdnSubdomains {
				s = strings.ReplaceAll(s, "https://"+subdomain+"."+mirror, "http://"+subdomain+"."+mirror)
			}
		}
		return s
	}
	return strings.ReplaceAll(s, ".laftel.net", ".latfel.net")
}

func sendJSON(c fiber.Ctx, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return sendJSONBytes(c, b)
}

func SendJSON(c fiber.Ctx, v any) error {
	return sendJSON(c, v)
}

func getMirrorRoot(c fiber.Ctx) string {
	host := requestHost(c)
	host = stripPort(host)
	// If we are on a known subdomain of our mirror, strip it to get the root.
	// This matches the logic in the frontend src/shared/cdn.ts
	if i := strings.Index(host, "."); i != -1 {
		prefix := host[:i]
		switch prefix {
		case "www", "app", "mediacloud", "streaming-bp", "thumbnail":
			return host[i+1:]
		}
	}
	return host
}

type App struct {
	mu       sync.RWMutex
	ds       sourcepkg.DataSource
	search   *searchpkg.Index
	reloadFn func() (sourcepkg.DataSource, *searchpkg.Index, error)
}

func NewApp(ds sourcepkg.DataSource, idx *searchpkg.Index, reloadFn func() (sourcepkg.DataSource, *searchpkg.Index, error)) *App {
	return &App{ds: ds, search: idx, reloadFn: reloadFn}
}

func (a *App) Reload() error {
	if a.reloadFn == nil {
		return fmt.Errorf("reload not configured")
	}
	newDS, newIdx, err := a.reloadFn()
	if err != nil {
		log.Printf("reload error: %v", err)
		return err
	}
	a.mu.Lock()
	a.ds = newDS
	a.search = newIdx
	a.mu.Unlock()
	mediapkg.SnapFailedURLs()
	runtime.GC()
	log.Printf("reload complete")
	return nil
}

func (a *App) dataSource() sourcepkg.DataSource {
	a.mu.RLock()
	ds := a.ds
	a.mu.RUnlock()
	return ds
}

func (a *App) searchIndex() *searchpkg.Index {
	a.mu.RLock()
	search := a.search
	a.mu.RUnlock()
	return search
}

func requestScheme(c fiber.Ctx) string {
	proto := c.Get("X-Forwarded-Proto")
	if proto == "https" {
		return proto
	}
	if proto == "http" {
		return proto
	}
	if c.Secure() {
		return "https"
	}
	return "http"
}

func requestHost(c fiber.Ctx) string {
	host := c.Get(fiber.HeaderHost)
	if host != "" {
		return host
	}
	return c.Hostname()
}

func sendNotFound(c fiber.Ctx) error {
	c.Status(fiber.StatusNotFound)
	c.Set(fiber.HeaderContentType, fiber.MIMEApplicationJSONCharsetUTF8)
	return c.Send(notFoundJSON)
}

func SendNotFound(c fiber.Ctx) error {
	return sendNotFound(c)
}

// sortByField sorts a []json.RawMessage by a field.
func sortByField(results []json.RawMessage, sorting string) {
	if len(results) <= 1 {
		return
	}
	var field string
	numeric, asc := false, false
	switch sorting {
	case "like", "top":
		field, numeric = "count_like", true
	case "newest":
		field = "created"
	case "created", "oldest":
		field, asc = "created", true
	case "ep_newest":
		field, numeric = "episode_order", true
	case "ep_oldest":
		field, numeric, asc = "episode_order", true, true
	default:
		return
	}

	type kv struct {
		idx    int
		numVal float64
		strVal string
	}
	keys := make([]kv, 0, len(results))
	for i, r := range results {
		var m map[string]json.RawMessage
		if err := json.Unmarshal(r, &m); err != nil {
			continue
		}
		v, ok := m[field]
		if !ok {
			continue
		}
		item := kv{idx: i}
		if numeric {
			if err := json.Unmarshal(v, &item.numVal); err != nil {
				continue
			}
		} else {
			if err := json.Unmarshal(v, &item.strVal); err != nil {
				continue
			}
		}
		keys = append(keys, item)
	}
	sort.SliceStable(keys, func(i, j int) bool {
		if numeric {
			if asc {
				return keys[i].numVal < keys[j].numVal
			}
			return keys[i].numVal > keys[j].numVal
		}
		if asc {
			return keys[i].strVal < keys[j].strVal
		}
		return keys[i].strVal > keys[j].strVal
	})

	tmp := make([]json.RawMessage, len(results))
	copy(tmp, results)
	// Fill sorted results first
	for i, k := range keys {
		results[i] = tmp[k.idx]
	}
	// If some items were skipped during sort key extraction, they remain at the end in original relative order
}

// sendJSONSlice applies optional sorting + offset/limit pagination to a raw JSON blob
func sendJSONSlice(c fiber.Ctx, raw []byte, offsetStr, limitStr, sorting string) error {
	if offsetStr == "" && limitStr == "" && sorting == "" {
		return sendJSONBytes(c, raw)
	}
	offset, _ := strconv.Atoi(offsetStr)
	limit, _ := strconv.Atoi(limitStr)
	if offset < 0 {
		offset = 0
	}
	if limit <= 0 {
		limit = 50
	}
	if limit > 1000 {
		limit = 1000
	}

	var doc struct {
		Count   *int64            `json:"count"`
		Next    interface{}       `json:"next"`
		Results []json.RawMessage `json:"results"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return sendJSONBytes(c, raw) // not a paginated blob, return as-is
	}

	sortByField(doc.Results, sorting)

	total := len(doc.Results)
	if offset > total {
		offset = total
	}
	end := offset + limit
	if end > total || end < 0 { // end < 0 check for overflow if limit was huge
		end = total
	}
	slice := doc.Results[offset:end]
	if slice == nil {
		slice = []json.RawMessage{}
	}

	count := int64(total)
	if doc.Count != nil {
		count = *doc.Count
	}

	var next *string
	if end < total {
		vals := url.Values{}
		for k, v := range c.Queries() {
			vals.Set(k, v)
		}
		vals.Set("offset", strconv.Itoa(end))
		vals.Set("limit", strconv.Itoa(limit))

		u := requestScheme(c) + "://" + requestHost(c) + c.Path() + "?" + vals.Encode()
		next = &u
	}

	type out struct {
		Count   int64             `json:"count"`
		Next    *string           `json:"next"`
		Results []json.RawMessage `json:"results"`
	}
	b, err := json.Marshal(out{Count: count, Next: next, Results: slice})
	if err != nil {
		return sendJSONBytes(c, raw)
	}
	return sendJSONBytes(c, b)
}

// findIDPosition returns the 0-based position of the item with the given id
// in the sorted Results array of a paginated JSON blob, or -1 if not found.
func findIDPosition(raw []byte, targetID int64, sorting string) int {
	var doc struct {
		Results []json.RawMessage `json:"results"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return -1
	}
	sortByField(doc.Results, sorting)
	for i, r := range doc.Results {
		var obj struct {
			ID int64 `json:"id"`
		}
		if err := json.Unmarshal(r, &obj); err != nil {
			continue
		}
		if obj.ID == targetID {
			return i
		}
	}
	return -1
}

// querySorting returns the first non-empty value of "sorting" or "sort" query params.
func querySorting(c fiber.Ctx) string {
	if s := c.Query("sorting"); s != "" {
		return s
	}
	return c.Query("sort")
}

// parseInt64Param parses a path parameter as int64, sending 400 on failure.
func parseInt64Param(c fiber.Ctx, key string) (int64, error) {
	n, err := strconv.ParseInt(c.Params(key), 10, 64)
	if err != nil {
		c.Status(fiber.StatusBadRequest)
		return 0, sendJSON(c, fiber.Map{"error": "invalid " + key})
	}
	return n, nil
}

// parseInt64Query parses a required query parameter as int64, sending 400 on failure.
func parseInt64Query(c fiber.Ctx, key string) (int64, error) {
	s := c.Query(key)
	if s == "" {
		c.Status(fiber.StatusBadRequest)
		return 0, sendJSON(c, fiber.Map{"error": key + " is required"})
	}
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		c.Status(fiber.StatusBadRequest)
		return 0, sendJSON(c, fiber.Map{"error": "invalid " + key})
	}
	return n, nil
}

// injectJSONField inserts a numeric field into a JSON object's closing brace.
func injectJSONField(b []byte, key string, val int64) []byte {
	i := len(b) - 1
	for i >= 0 && b[i] != '}' {
		i--
	}
	if i < 0 {
		return b
	}
	field, _ := json.Marshal(key)
	prefix := b[:i]
	// trim trailing whitespace before }
	j := len(prefix) - 1
	for j >= 0 && (prefix[j] == ' ' || prefix[j] == '\n' || prefix[j] == '\r' || prefix[j] == '\t') {
		j--
	}
	sep := ","
	if j >= 0 && prefix[j] == '{' {
		sep = ""
	}
	suffix := b[i:]
	out := make([]byte, 0, len(b)+len(field)+24)
	out = append(out, prefix[:j+1]...)
	out = append(out, sep...)
	out = append(out, field...)
	out = append(out, ':')
	out = strconv.AppendInt(out, val, 10)
	out = append(out, suffix...)
	return out
}
