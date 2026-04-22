package bootstrap

import (
	"flag"
	"log"
	"net/netip"
	"os"
	"os/signal"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"

	cachepkg "github.com/bsdrop/lafdb/internal/server/cache"
	httppkg "github.com/bsdrop/lafdb/internal/server/http"
	loggingpkg "github.com/bsdrop/lafdb/internal/server/logging"
	mediapkg "github.com/bsdrop/lafdb/internal/server/media"
	searchpkg "github.com/bsdrop/lafdb/internal/server/search"
	sourcepkg "github.com/bsdrop/lafdb/internal/server/source"
	"github.com/gofiber/fiber/v3"
	"github.com/gofiber/fiber/v3/middleware/limiter"
	"github.com/gofiber/fiber/v3/middleware/static"
)

const cacheFile = "./laftel/data.bin"
const dataDir = "./laftel"

func duckDBCacheStale(path string) bool {
	duckInfo, err := os.Stat(path)
	if err != nil {
		return true
	}
	cacheInfo, err := os.Stat(cacheFile)
	if err != nil {
		return false
	}
	return cacheInfo.ModTime().After(duckInfo.ModTime())
}

func Run() {
	startupStart := time.Now()
	rebuildCache := flag.Bool("rebuild-cache", false, "force rescan and rewrite ./laftel/data.bin")
	noCache := flag.Bool("no-cache", false, "read JSON files on demand; skip data.bin entirely (low RAM mode)")
	duckDBPath := flag.String("duckdb-cache", "", "use a DuckDB cache file instead of data.bin; builds asynchronously from JSON if missing")
	rebuildDuckDB := flag.Bool("rebuild-duckdb", false, "rebuild --duckdb-cache asynchronously after starting with disk source")
	duckDBBuildOnReloadOnly := flag.Bool("duckdb-build-on-reload-only", false, "with --duckdb-cache, only build DuckDB after SIGHUP/internal reload instead of at startup")
	cfCSP := flag.Bool("cf-csp", false, "add Content-Security-Policy header with Cloudflare-compatible origins (Rocket Loader, Web Analytics, Bot products, Turnstile)")
	mediaRAMCacheFlag := flag.Bool("media-ram-cache", false, "buffer fetched media responses in RAM before writing/sending")
	enableLoggingFlag := flag.Bool("enable-logging", false, "force enable request logging (default: off if behind proxy or not a terminal)")
	flag.Parse()
	mediapkg.SetRAMCache(*mediaRAMCacheFlag)
	loggingpkg.SetEnabled(*enableLoggingFlag)

	if *rebuildCache && *noCache {
		log.Fatalf("--rebuild-cache and --no-cache are mutually exclusive")
	}
	if *duckDBPath != "" && *rebuildCache {
		log.Fatalf("--duckdb-cache and --rebuild-cache are mutually exclusive")
	}
	if *rebuildDuckDB && *duckDBPath == "" {
		log.Fatalf("--rebuild-duckdb requires --duckdb-cache")
	}

	var (
		ds              sourcepkg.DataSource
		idx             *searchpkg.Index
		reloadFn        func() (sourcepkg.DataSource, *searchpkg.Index, error)
		triggerReload   func(app *httppkg.App) error
		asyncAfterStart func(app *httppkg.App)
		err             error
	)

	if *duckDBPath != "" {
		var duckDBBuildMu sync.Mutex
		duckDBBuildRunning := false
		duckDBBuildPending := false
		loadDuckDB := func() (sourcepkg.DataSource, *searchpkg.Index, error) {
			// Build the search index first so its connection is closed before
			// NewDuckDBSource opens the file.  DuckDB allows only one read-write
			// connection at a time; opening both simultaneously can deadlock.
			ni, err := sourcepkg.BuildIndexFromDuckDB(*duckDBPath)
			if err != nil {
				return nil, nil, err
			}
			nd, err := sourcepkg.NewDuckDBSource(*duckDBPath)
			if err != nil {
				return nil, nil, err
			}
			return nd, ni, nil
		}
		startDuckDBBuild := func(app *httppkg.App, reason string) {
			go func() {
				duckDBBuildMu.Lock()
				if duckDBBuildRunning {
					duckDBBuildPending = true
					duckDBBuildMu.Unlock()
					log.Printf("duckdb async build already running; queued rebuild (%s)", reason)
					return
				}
				duckDBBuildRunning = true
				duckDBBuildMu.Unlock()

				for {
					log.Printf("duckdb async build started: %s (%s)", *duckDBPath, reason)
					if err := sourcepkg.BuildDuckDBFromDisk(dataDir, *duckDBPath); err != nil {
						log.Printf("duckdb async build failed: %v", err)
					} else if err := app.Reload(); err != nil {
						log.Printf("duckdb async reload failed: %v", err)
					} else {
						log.Printf("duckdb async build loaded")
					}

					duckDBBuildMu.Lock()
					if !duckDBBuildPending {
						duckDBBuildRunning = false
						duckDBBuildMu.Unlock()
						return
					}
					duckDBBuildPending = false
					reason = "queued rebuild"
					duckDBBuildMu.Unlock()
				}
			}()
		}
		if !*rebuildDuckDB {
			if _, statErr := os.Stat(*duckDBPath); statErr == nil {
				log.Printf("duckdb cache found: loading %s", *duckDBPath)
				ds, idx, err = loadDuckDB()
				if err != nil {
					log.Printf("duckdb load failed, starting disk mode and rebuilding asynchronously: %v", err)
				} else if duckDBCacheStale(*duckDBPath) && !*duckDBBuildOnReloadOnly {
					log.Printf("duckdb cache is older than data.bin; scheduling async rebuild")
					asyncAfterStart = func(app *httppkg.App) {
						startDuckDBBuild(app, "stale cache")
					}
				} else if duckDBCacheStale(*duckDBPath) {
					log.Printf("duckdb cache is older than data.bin; waiting for reload trigger")
				}
			}
		}
		if ds == nil {
			if *duckDBBuildOnReloadOnly && !*rebuildDuckDB {
				log.Printf("starting in disk mode; duckdb cache will build on reload trigger: %s", *duckDBPath)
			} else {
				log.Printf("starting in disk mode while duckdb cache builds asynchronously: %s", *duckDBPath)
			}
			diskDS, dsErr := sourcepkg.NewDiskSourceWithOptions(dataDir, sourcepkg.DiskSourceOptions{
				BuildShareIndexes: !*duckDBBuildOnReloadOnly || *rebuildDuckDB,
			})
			if dsErr != nil {
				log.Fatalf("disk source init failed: %v", dsErr)
			}
			idx, err = sourcepkg.BuildIndexFromDisk(dataDir)
			if err != nil {
				log.Fatalf("search index build failed: %v", err)
			}
			diskDS.SetEndingItemIDs(idx.EndingItemIDs())
			ds = diskDS
			if !*duckDBBuildOnReloadOnly || *rebuildDuckDB {
				asyncAfterStart = func(app *httppkg.App) {
					startDuckDBBuild(app, "missing, invalid, or forced rebuild")
				}
			}
		}
		reloadFn = loadDuckDB
		triggerReload = func(app *httppkg.App) error {
			startDuckDBBuild(app, "reload trigger")
			return nil
		}
	} else if *noCache {
		// Disk mode: lightweight indexes in RAM, JSON reads on demand per request.
		log.Printf("starting in disk mode (--no-cache): data.bin not used")
		diskDS, dsErr := sourcepkg.NewDiskSource(dataDir)
		if dsErr != nil {
			log.Fatalf("disk source init failed: %v", dsErr)
		}
		idx, err = sourcepkg.BuildIndexFromDisk(dataDir)
		if err != nil {
			log.Fatalf("search index build failed: %v", err)
		}
		diskDS.SetEndingItemIDs(idx.EndingItemIDs())
		ds = diskDS
		reloadFn = func() (sourcepkg.DataSource, *searchpkg.Index, error) {
			nd, err := sourcepkg.NewDiskSource(dataDir)
			if err != nil {
				return nil, nil, err
			}
			ni, err := sourcepkg.BuildIndexFromDisk(dataDir)
			if err != nil {
				return nil, nil, err
			}
			nd.SetEndingItemIDs(ni.EndingItemIDs())
			return nd, ni, nil
		}
		log.Printf("[disk] ready: playable=%d ending=%d",
			len(diskDS.GetPlayableItemIDs()), len(diskDS.GetEndingItemIDs()))
		triggerReload = func(app *httppkg.App) error {
			return app.Reload()
		}
	} else {
		// Memory mode: everything loaded into RAM from data.bin or scanned from disk.
		var store *cachepkg.Store
		switch {
		case *rebuildCache:
			log.Printf("rebuild-cache: scanning source files")
			func() {
				tmp, err := cachepkg.NewStore()
				if err != nil {
					log.Fatalf("bootstrap failed: %v", err)
				}
				if err := tmp.SaveToFile(cacheFile); err != nil {
					log.Fatalf("failed to save cache: %v", err)
				}
				log.Printf("cache saved to %s", cacheFile)
			}()
			runtime.GC()
			store, err = cachepkg.LoadFromFile(cacheFile)
			if err != nil {
				log.Fatalf("failed to reload cache: %v", err)
			}
			generateAndSaveOpenAPI(store)
			GenerateAccessibleBitset("./laftel", "./src/accessible.ts")

		default:
			if _, statErr := os.Stat(cacheFile); statErr == nil {
				log.Printf("cache found: loading %s", cacheFile)
				store, err = cachepkg.LoadFromFile(cacheFile)
				if err != nil {
					log.Printf("cache load failed, fallback to scanning: %v", err)
					store, err = cachepkg.NewStore()
					if err != nil {
						log.Fatalf("bootstrap failed: %v", err)
					}
					if err := store.SaveToFile(cacheFile); err != nil {
						log.Printf("warning: failed to save cache: %v", err)
					}
				}
			} else {
				log.Printf("cache not found: scanning source files")
				store, err = cachepkg.NewStore()
				if err != nil {
					log.Fatalf("bootstrap failed: %v", err)
				}
				if err := store.SaveToFile(cacheFile); err != nil {
					log.Printf("warning: failed to save cache: %v", err)
				} else {
					log.Printf("cache saved to %s", cacheFile)
				}
			}
		}

		indexBuildStart := time.Now()
		idx, err = searchpkg.Build(store.ItemByItemID, store.ReviewCountByItemID, store.StatisticsByItemID)
		if err != nil {
			log.Fatalf("search Build failed: %v", err)
		}
		log.Printf("startup: search index build took %s", time.Since(indexBuildStart))
		ds = sourcepkg.NewMemSource(dataDir, sourcepkg.MemData{
			EpisodesListByItemID:     store.EpisodesListByItemID,
			EpisodeByEpisodeID:       store.EpisodeByEpisodeID,
			ItemByItemID:             store.ItemByItemID,
			SeriesBySeriesID:         store.SeriesBySeriesID,
			EpisodeToItemID:          store.EpisodeToItemID,
			EndingItemIDs:            store.EndingItemIDs,
			PlayableItemIDs:          store.PlayableItemIDs,
			ReviewCountByItemID:      store.ReviewCountByItemID,
			ReviewListByItemID:       store.ReviewListByItemID,
			ReviewShareByReviewID:    store.ReviewShareByReviewID,
			StatisticsByItemID:       store.StatisticsByItemID,
			CommentListByEpisodeID:   store.CommentListByEpisodeID,
			CommentRepliesByParentID: store.CommentRepliesByParentID,
			CommentShareByCommentID:  store.CommentShareByCommentID,
			DRMKeyByEpisodeID:        store.DRMKeyByEpisodeID,
		})
		reloadFn = func() (sourcepkg.DataSource, *searchpkg.Index, error) {
			s, loadErr := cachepkg.LoadFromFile(cacheFile)
			if loadErr != nil {
				return nil, nil, loadErr
			}
			ni, buildErr := searchpkg.Build(s.ItemByItemID, s.ReviewCountByItemID, s.StatisticsByItemID)
			if buildErr != nil {
				return nil, nil, buildErr
			}
			return sourcepkg.NewMemSource(dataDir, sourcepkg.MemData{
				EpisodesListByItemID:     s.EpisodesListByItemID,
				EpisodeByEpisodeID:       s.EpisodeByEpisodeID,
				ItemByItemID:             s.ItemByItemID,
				SeriesBySeriesID:         s.SeriesBySeriesID,
				EpisodeToItemID:          s.EpisodeToItemID,
				EndingItemIDs:            s.EndingItemIDs,
				PlayableItemIDs:          s.PlayableItemIDs,
				ReviewCountByItemID:      s.ReviewCountByItemID,
				ReviewListByItemID:       s.ReviewListByItemID,
				ReviewShareByReviewID:    s.ReviewShareByReviewID,
				StatisticsByItemID:       s.StatisticsByItemID,
				CommentListByEpisodeID:   s.CommentListByEpisodeID,
				CommentRepliesByParentID: s.CommentRepliesByParentID,
				CommentShareByCommentID:  s.CommentShareByCommentID,
				DRMKeyByEpisodeID:        s.DRMKeyByEpisodeID,
			}), ni, nil
		}
		log.Printf("[mem] loaded items=%d series=%d episodes=%d episodeLists=%d reverseIndex=%d drmKeys=%d",
			len(store.ItemByItemID),
			len(store.SeriesBySeriesID),
			len(store.EpisodeByEpisodeID),
			len(store.EpisodesListByItemID),
			len(store.EpisodeToItemID),
			len(store.DRMKeyByEpisodeID),
		)
		triggerReload = func(app *httppkg.App) error {
			return app.Reload()
		}
	}

	log.Printf("startup: initialization completed in %s", time.Since(startupStart))

	app := httppkg.NewApp(ds, idx, reloadFn)
	if asyncAfterStart != nil {
		asyncAfterStart(app)
	}

	// SIGHUP reload handler
	sigHup := make(chan os.Signal, 1)
	signal.Notify(sigHup, syscall.SIGHUP)
	go func() {
		for range sigHup {
			log.Printf("SIGHUP received: reloading")
			if err := triggerReload(app); err != nil {
				log.Printf("reload error: %v", err)
			}
		}
	}()

	srv := fiber.New(fiber.Config{
		StrictRouting:     false,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
		ReadBufferSize:    8192,
		ReduceMemoryUsage: true,
	})

	srv.Use(loggingpkg.Middleware)
	srv.Use(rejectInvalidHostMiddleware)

	srv.Use(limiter.New(limiter.Config{
		Max:        4096,
		Expiration: time.Minute,
		KeyGenerator: func(c fiber.Ctx) string {
			return loggingpkg.ClientIP(c)
		},
		Next: func(c fiber.Ctx) bool {
			// Skip limiting for localhost / trusted local proxy hop
			return loggingpkg.IsLoopback(loggingpkg.ClientIP(c))
		},
	}))

	// CORS for all responses + Host-based media subdomain dispatch
	srv.Use(func(c fiber.Ctx) error {
		if *cfCSP {
			scheme := c.Get("X-Forwarded-Proto")
			if scheme != "http" && scheme != "https" {
				if c.Secure() {
					scheme = "https"
				} else {
					scheme = "http"
				}
			}
			c.Set("Content-Security-Policy", buildCFCSP(c.Get(fiber.HeaderHost), scheme, c.Path()))
		}
		c.Set("Access-Control-Allow-Origin", "*")
		c.Set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
		if c.Method() == fiber.MethodOptions {
			return c.SendStatus(fiber.StatusNoContent)
		}
		if handled, err := mediapkg.DispatchByHost(c); handled {
			return err
		}
		return c.Next()
	})

	api := srv.Group("/api")
	httppkg.RegisterAPIRoutes(api, app)

	// Internal reload endpoint (only accessible from localhost)
	api.Post("/internal/reload", func(c fiber.Ctx) error {
		if c.IP() != "127.0.0.1" && c.IP() != "::1" {
			return c.Status(fiber.StatusForbidden).SendString("Localhost only")
		}
		log.Printf("Internal reload requested via API")
		if err := triggerReload(app); err != nil {
			return c.Status(fiber.StatusInternalServerError).SendString(err.Error())
		}
		return c.SendString("OK")
	})

	// Fallback for /api/* if no route matched
	api.Use(func(c fiber.Ctx) error {
		if c.Method() == fiber.MethodGet || c.Method() == fiber.MethodHead {
			return httppkg.SendNotFound(c)
		}
		c.Status(fiber.StatusMethodNotAllowed)
		return httppkg.SendJSON(c, fiber.Map{"error": "Method Not Allowed"})
	})

	mediapkg.RegisterRoutes(srv)

	httppkg.RegisterDocsRoutes(srv, GeneratedOpenAPIPath)

	httppkg.RegisterShareRoutes(srv, app)

	srv.Use("/", static.New("./public", static.Config{
		IndexNames: []string{"index.html"},
	}))

	srv.Use(httppkg.SendNotFound)

	log.Fatal(srv.Listen(":4003"))
}

func rejectInvalidHostMiddleware(c fiber.Ctx) error {
	rawHost := strings.TrimSpace(c.Get(fiber.HeaderHost))
	if rawHost == "" {
		return c.Status(fiber.StatusBadRequest).SendString("Host header required")
	}

	host := stripPort(rawHost)
	if host == "" {
		return c.Status(fiber.StatusBadRequest).SendString("Invalid Host header")
	}

	if parsedIP, err := netip.ParseAddr(host); err == nil {
		if !parsedIP.IsLoopback() && !loggingpkg.IsLoopback(loggingpkg.ClientIP(c)) {
			return c.Status(fiber.StatusForbidden).SendString("Direct IP access is not allowed")
		}
	}

	return c.Next()
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
	if strings.HasPrefix(host, "[") && strings.HasSuffix(host, "]") {
		return strings.Trim(host, "[]")
	}
	return strings.Trim(host, "[]")
}

// buildCFCSP builds a Content-Security-Policy header that satisfies Cloudflare's
// feature requirements while deriving host-specific origins from the request.
//
// Covered features and their required additions:
//   - Rocket Loader      : script-src ajax.cloudflare.com
//   - Web Analytics      : script-src static.cloudflareinsights.com
//     connect-src cloudflareinsights.com
//   - Bot products / JSD : script-src 'self' (already present); allows /cdn-cgi/challenge-platform/
//   - Turnstile          : script-src https://challenges.cloudflare.com
//     frame-src  https://challenges.cloudflare.com
//     connect-src 'self' (already present)
//
// The apex domain of the incoming Host header is used for the CDN wildcard so
// no hostnames are hardcoded
func buildCFCSP(host, scheme, path string) string {
	origin := scheme + "://" + host

	bareHost := host
	if i := strings.LastIndex(bareHost, ":"); i > strings.LastIndex(bareHost, "]") {
		bareHost = bareHost[:i]
	}

	var cdnOrigins string
	if parts := strings.Split(bareHost, "."); len(parts) >= 2 {
		tld := parts[len(parts)-1]
		isNumeric := len(tld) > 0
		for _, ch := range tld {
			if ch < '0' || ch > '9' {
				isNumeric = false
				break
			}
		}
		// If it's a domain (not an IP), use the apex for wildcard
		if !isNumeric {
			apex := parts[len(parts)-2] + "." + tld
			// If it's something like .i2p or .onion, apex might just be the whole thing if it's single label,
			// but usually they have a long hash. We use *.[apex] to cover subdomains.
			cdnOrigins = " " + scheme + "://*." + apex
		}
	} else if len(parts) == 1 {
		// Single label host (like 'localhost' or an i2p base32 without subdomains)
		// We still allow subdomains of it just in case.
		cdnOrigins = " " + scheme + "://*." + bareHost
	}

	styleSrc := "style-src 'self' 'unsafe-inline'; "
	fontSrc := "font-src 'self' data:; "
	if path == "/docs" || path == "/docs/" {
		styleSrc = "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; "
		fontSrc = "font-src 'self' data: https://cdn.jsdelivr.net; "
	}

	return "default-src 'self'; " +
		"script-src 'self' " + origin + " 'unsafe-inline' 'unsafe-eval' blob:" +
		" https://cdn.jsdelivr.net" +
		" ajax.cloudflare.com" +
		" static.cloudflareinsights.com" +
		" https://challenges.cloudflare.com; " +
		"script-src-elem 'self' " + origin + " 'unsafe-inline' blob:" +
		" https://cdn.jsdelivr.net" +
		" ajax.cloudflare.com" +
		" static.cloudflareinsights.com" +
		" https://challenges.cloudflare.com; " +
		"worker-src 'self' blob:; " +
		"connect-src 'self' " + origin + cdnOrigins + " blob:" +
		" https://cdn.jsdelivr.net" +
		" cloudflareinsights.com https://static.cloudflareinsights.com" +
		" https://www.cloudflare.com; " +
		"frame-src https://challenges.cloudflare.com; " +
		"media-src 'self'" + cdnOrigins + " data: blob:; " +
		"img-src 'self'" + cdnOrigins + " data: blob:; " +
		styleSrc +
		fontSrc +
		"object-src 'none'; " +
		"frame-ancestors 'none';"
}
