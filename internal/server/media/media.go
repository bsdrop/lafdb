package media

import (
	"fmt"
	"io"
	"log"
	"math/rand/v2"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gofiber/fiber/v3"
)

var mediaExtensions = map[string]bool{
	".ts":   true,
	".m4s":  true,
	".mp4":  true,
	".png":  true,
	".jpg":  true,
	".webp": true,
	".mpd":  true,
	".m3u8": true,
}

var mediaHTTPClient = &http.Client{
	Timeout: 15 * time.Second,
	Transport: &http.Transport{
		MaxIdleConns:        64,
		MaxIdleConnsPerHost: 16,
		IdleConnTimeout:     90 * time.Second,
		DisableCompression:  true,
	},
}

var mediaRAMCache bool

func SetRAMCache(v bool) {
	mediaRAMCache = v
}

var failedURLs sync.Map // cleanPathname → struct{}
var failedURLCount atomic.Int64
var inflightMedia sync.Map // cleanPathname → *inflightEntry

const maxFailedURLs = 100_000

func storeFailedURL(key string) {
	if failedURLCount.Load() >= maxFailedURLs {
		return
	}
	if _, loaded := failedURLs.LoadOrStore(key, struct{}{}); !loaded {
		failedURLCount.Add(1)
	}
}

// SnapFailedURLs randomly evicts ~50% of cached failure entries.
// Called on data reload (after DRM phase) so transiently-failed URLs get a retry.
func SnapFailedURLs() {
	var victims []string
	failedURLs.Range(func(key, _ any) bool {
		if rand.IntN(2) == 0 {
			victims = append(victims, key.(string))
		}
		return true
	})
	for _, k := range victims {
		failedURLs.Delete(k)
	}
	failedURLCount.Add(-int64(len(victims)))
	log.Printf("media: failedURLs snap: evicted %d entries", len(victims))
}

type inflightEntry struct {
	done chan struct{}
	err  error
}

func validateContentLength(expected, actual int64) error {
	if expected > 0 && actual != expected {
		return fmt.Errorf("integrity check failed: expected %d bytes, got %d", expected, actual)
	}
	return nil
}

type mediaCfg struct {
	localDir   string
	sourceHost string
}

var mediaCfgs = map[string]mediaCfg{
	"mediacloud":   {localDir: "./laftel/mediacloud", sourceHost: "mediacloud.laftel.net"},
	"streaming-bp": {localDir: "./laftel/mediacloud", sourceHost: "streaming-bp.laftel.net"},
	"thumbnail":    {localDir: "./laftel/thumbnail", sourceHost: "thumbnail.laftel.net"},
}

const maxMediaPathnameRunes = 300

// cfgFromHost returns the media config based on Host header value.
// e.g. "thumbnail.latfel.net:443" → ("thumbnail", cfg, true)
func cfgFromHost(host string) (prefix string, cfg mediaCfg, ok bool) {
	host = stripPort(host)
	label, _, _ := strings.Cut(host, ".")
	switch label {
	case "mediacloud":
		return "mediacloud", mediaCfgs["mediacloud"], true
	case "streaming-bp":
		return "streaming-bp", mediaCfgs["streaming-bp"], true
	case "thumbnail":
		return "thumbnail", mediaCfgs["thumbnail"], true
	}
	return "", mediaCfg{}, false
}

func mediaHandler(prefix string, cfg mediaCfg) fiber.Handler {
	return func(c fiber.Ctx) error {
		return serveMedia(c, prefix, c.Params("*"), cfg)
	}
}

func DispatchByHost(c fiber.Ctx) (bool, error) {
	if prefix, cfg, ok := cfgFromHost(c.Hostname()); ok {
		return true, serveMedia(c, prefix, strings.TrimPrefix(c.Path(), "/"), cfg)
	}
	return false, nil
}

func RegisterRoutes(srv *fiber.App) {
	for prefix, cfg := range mediaCfgs {
		handler := mediaHandler(prefix, cfg)
		base := "/" + prefix
		// Path-style media routes for networks that do not reliably support
		// wildcard subdomains, e.g. /mediacloud/..., /thumbnail/....
		srv.Get(base, handler)
		srv.Head(base, handler)
		srv.Get(base+"/", handler)
		srv.Head(base+"/", handler)
		srv.Get(base+"/*", handler)
		srv.Head(base+"/*", handler)
	}
}

func stripURLParams(rawPath string) string {
	if i := strings.IndexByte(rawPath, '?'); i >= 0 {
		rawPath = rawPath[:i]
	}
	/*if i := strings.IndexByte(rawPath, '#'); i >= 0 {
		rawPath = rawPath[:i]
	}*/
	return rawPath
}

func isAllowedMediaPathByte(b byte) bool {
	switch {
	case b >= 'a' && b <= 'z':
		return true
	case b >= 'A' && b <= 'Z':
		return true
	case b >= '0' && b <= '9':
		return true
	case b == '/', b == '-', b == '.', b == '_':
		return true
	default:
		return false
	}
}

func normalizeMediaPath(rawPath string, cfg mediaCfg) (string, int) {
	rawPath = stripURLParams(rawPath)
	if len(rawPath) > maxMediaPathnameRunes {
		return "", http.StatusRequestURITooLong
	}
	if strings.HasSuffix(rawPath, "/") {
		return "", fiber.StatusBadRequest
	}
	if rawPath == "" || strings.HasPrefix(rawPath, "/") {
		return "", fiber.StatusBadRequest
	}

	// Strip host if it's the first component (e.g. "thumbnail.laftel.net/items/...")
	// Repeatedly strip in case it's nested (though it shouldn't be normally)
	for {
		if strings.HasPrefix(rawPath, cfg.sourceHost+"/") {
			rawPath = strings.TrimPrefix(rawPath, cfg.sourceHost+"/")
		} else {
			break
		}
	}

	for i := 0; i < len(rawPath); i++ {
		if !isAllowedMediaPathByte(rawPath[i]) {
			return "", fiber.StatusBadRequest
		}
	}

	normalized := path.Clean(rawPath)
	if normalized != rawPath || normalized == "." || strings.HasPrefix(normalized, "..") || strings.HasPrefix(normalized, "/") {
		return "", fiber.StatusBadRequest
	}

	if len(normalized) <= 10 {
		return "", fiber.StatusBadRequest
	}

	hasDigit := false
	for i := 0; i < len(normalized); i++ {
		if normalized[i] >= '0' && normalized[i] <= '9' {
			hasDigit = true
			break
		}
	}
	if !hasDigit {
		return "", fiber.StatusBadRequest
	}

	return normalized, 0
}

func serveMedia(c fiber.Ctx, prefix, rawPath string, cfg mediaCfg) error {
	normalized, status := normalizeMediaPath(rawPath, cfg)
	if status != 0 {
		switch status {
		case http.StatusRequestURITooLong:
			return c.Status(status).SendString("Pathname Too Long")
		case fiber.StatusBadRequest:
			return c.Status(status).SendString("Bad Request")
		default:
			return c.Status(status).SendString("Forbidden")
		}
	}

	cleanPathname := "/" + prefix + "/" + normalized
	ext := strings.ToLower(filepath.Ext(normalized))

	if _, failed := failedURLs.Load(cleanPathname); failed {
		return c.Status(fiber.StatusNotFound).SendString("Not Found")
	}

	localPath := filepath.Clean(filepath.Join(cfg.localDir, filepath.FromSlash(normalized)))

	// Serve from local cache
	if f, err := os.Open(localPath); err == nil {
		fi, err2 := f.Stat()
		if err2 == nil && !fi.IsDir() {
			c.Set(fiber.HeaderContentType, mediaContentType(ext))
			c.Set(fiber.HeaderContentLength, fmt.Sprintf("%d", fi.Size()))
			if isStaticMedia(ext) {
				c.Set(fiber.HeaderCacheControl, "public, max-age=31536000, immutable")
			}
			return c.SendStream(f, int(fi.Size())) // fasthttp closes f after send
		}
		_ = f.Close()
	}

	if !mediaExtensions[ext] {
		return c.Status(fiber.StatusNotFound).SendString("Not Found")
	}

	// Inflight deduplication
	newEntry := &inflightEntry{done: make(chan struct{})}
	actual, loaded := inflightMedia.LoadOrStore(cleanPathname, newEntry)
	if loaded {
		existing := actual.(*inflightEntry)
		<-existing.done
		if existing.err != nil {
			return c.Status(fiber.StatusNotFound).SendString("Not Found")
		}
		if f, err := os.Open(localPath); err == nil {
			c.Set(fiber.HeaderContentType, mediaContentType(ext))
			if isStaticMedia(ext) {
				c.Set(fiber.HeaderCacheControl, "public, max-age=31536000, immutable")
			}
			return c.SendStream(f) // fasthttp closes f after send
		}
		return c.Status(fiber.StatusNotFound).SendString("Not Found")
	}

	finish := func(err error) {
		newEntry.err = err
		inflightMedia.Delete(cleanPathname)
		close(newEntry.done)
	}

	// Fetch from upstream
	sourceURL := fmt.Sprintf("https://%s/%s", cfg.sourceHost, normalized)
	resp, err := mediaHTTPClient.Get(sourceURL)
	if err != nil {
		log.Printf("media fetch %s: %v", sourceURL, err)
		storeFailedURL(cleanPathname)
		finish(err)
		return c.Status(fiber.StatusNotFound).SendString("Not Found")
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		log.Printf("media upstream %d: %s", resp.StatusCode, sourceURL)
		storeFailedURL(cleanPathname)
		finish(fmt.Errorf("upstream %d", resp.StatusCode))
		return c.Status(fiber.StatusNotFound).SendString("Not Found")
	}

	// Read first bytes to detect HTML/JSON error pages
	first := make([]byte, 2)
	n, _ := io.ReadFull(resp.Body, first)
	first = first[:n]
	if n > 0 && ((first[0] == '<' && (n < 2 || first[1] != '?')) || first[0] == '{') {
		storeFailedURL(cleanPathname)
		finish(fmt.Errorf("upstream returned HTML/JSON"))
		return c.Status(fiber.StatusServiceUnavailable).SendString("Internal Server Error")
	}

	if !mediaRAMCache {
		if err := saveMediaStream(localPath, first, resp.Body, resp.ContentLength); err == nil {
			// resp.Body is fully consumed; open the saved file to serve it.
			finish(nil)
			f, openErr := os.Open(localPath)
			if openErr != nil {
				return c.Status(fiber.StatusInternalServerError).SendString("Internal Server Error")
			}
			fi, statErr := f.Stat()
			if statErr != nil || fi.IsDir() {
				_ = f.Close()
				return c.Status(fiber.StatusInternalServerError).SendString("Internal Server Error")
			}
			c.Set(fiber.HeaderContentType, mediaContentType(ext))
			c.Set(fiber.HeaderContentLength, fmt.Sprintf("%d", fi.Size()))
			if isStaticMedia(ext) {
				c.Set(fiber.HeaderCacheControl, "public, max-age=31536000, immutable")
			}
			return c.SendStream(f, int(fi.Size()))
		}
		log.Printf("media stream-save fallback to RAM %s: %v", localPath, err)
	}

	// Read rest of body into RAM
	rest, err := io.ReadAll(resp.Body)
	if err != nil {
		storeFailedURL(cleanPathname)
		finish(err)
		return c.Status(fiber.StatusNotFound).SendString("Not Found")
	}
	body := append(first, rest...)
	if err := validateContentLength(resp.ContentLength, int64(len(body))); err != nil {
		log.Printf("media integrity %s: %v", sourceURL, err)
		storeFailedURL(cleanPathname)
		finish(err)
		return c.Status(fiber.StatusServiceUnavailable).SendString("Internal Server Error")
	}

	// Save to disk before signaling finish (so waiting requests can open the file)
	if err := os.MkdirAll(filepath.Dir(localPath), 0750); err == nil {
		tmpPath := localPath + ".tmp"
		if err := os.WriteFile(tmpPath, body, 0644); err == nil {
			if err := os.Rename(tmpPath, localPath); err != nil {
				log.Printf("media rename %s: %v", tmpPath, err)
				_ = os.Remove(tmpPath)
			}
		} else {
			log.Printf("media write %s: %v", tmpPath, err)
		}
	}
	finish(nil)

	c.Set(fiber.HeaderContentType, mediaContentType(ext))
	if isStaticMedia(ext) {
		c.Set(fiber.HeaderCacheControl, "public, max-age=31536000, immutable")
	}
	return c.Send(body)
}

func saveMediaStream(localPath string, first []byte, body io.Reader, expectedSize int64) error {
	if err := os.MkdirAll(filepath.Dir(localPath), 0750); err != nil {
		return err
	}

	tmpPath := localPath + ".tmp"
	f, err := os.OpenFile(tmpPath, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0644)
	if err != nil {
		return err
	}

	ok := false
	defer func() {
		_ = f.Close()
		if !ok {
			_ = os.Remove(tmpPath)
		}
	}()

	if len(first) > 0 {
		if _, err := f.Write(first); err != nil {
			return err
		}
	}
	written, err := io.Copy(f, body)
	if err != nil {
		return err
	}
	if err := validateContentLength(expectedSize, int64(len(first))+written); err != nil {
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpPath, localPath); err != nil {
		return err
	}

	ok = true
	return nil
}

func isStaticMedia(ext string) bool {
	switch ext {
	case ".jpg", ".png", ".webp":
		return true
	}
	return false
}

func mediaContentType(ext string) string {
	switch ext {
	case ".m4s", ".ts":
		return "video/iso.segment"
	case ".mp4":
		return "video/mp4"
	case ".m3u8":
		return "application/vnd.apple.mpegurl"
	case ".mpd":
		return "application/dash+xml"
	case ".jpg":
		return "image/jpeg"
	case ".png":
		return "image/png"
	case ".webp":
		return "image/webp"
	default:
		return "application/octet-stream"
	}
}

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
	return host
}
