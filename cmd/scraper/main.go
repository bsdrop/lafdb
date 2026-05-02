package main

import (
	"flag"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/bsdrop/lafdb/internal/drm"
	"github.com/bsdrop/lafdb/internal/lafutil"
	"github.com/bsdrop/lafdb/internal/scraper"
	"github.com/bsdrop/lafdb/internal/server"
	cachepkg "github.com/bsdrop/lafdb/internal/server/cache"
)

func main() {
	root := flag.String("root", "./laftel", "data root directory")
	proxies := flag.String("proxies", "./proxies.txt", "proxy list file (ip:port:user:pass)")
	concurrent := flag.Int("concurrent", 8, "max concurrent requests (ignored when proxies loaded: uses proxy count)")
	debug := flag.Bool("debug", false, "log every request (suppresses \\r progress display)")
	noSkip := flag.Bool("no-skip", false, "re-fetch existing files")
	freshAge := flag.Duration("fresh-age", 48*time.Hour, "how long to treat saved item/list/detail/statistics files as fresh")
	failFreshAge := flag.Duration("fail-fresh-age", 48*time.Hour, "how long to skip IDs that recently returned 404")
	commentFreshAge := flag.Duration("comment-fresh-age", 48*time.Hour, "how long to treat comment and reply stamps as fresh")
	skipItems := flag.Bool("skip-items", false, "")
	skipEpisodes := flag.Bool("skip-episodes", false, "")
	skipReviews := flag.Bool("skip-reviews", false, "")
	skipStatistics := flag.Bool("skip-statistics", false, "")
	skipComments := flag.Bool("skip-comments", false, "")
	skipThumbnails := flag.Bool("skip-thumbnails", false, "")
	daemon := flag.Bool("daemon", false, "run continuously: scraper → DRM → bitset → wait → repeat")
	token := flag.String("token", "", "Laftel API token for DRM phase")
	decrypt := flag.String("decrypt", "http://127.0.0.1:3040/api/decrypt", "CDM server URL")
	drmSleep := flag.Int("drm-sleep", 16000, "DRM sleep between requests (ms)")
	waitHours := flag.Float64("wait", 24*6, "hours to wait between daemon cycles (default 6 days)")
	bitsetOut := flag.String("bitset-out", "./public/accessible.js", "path to write accessible.js after DRM")
	flag.Parse()

	proxyFile := *proxies
	if _, err := os.Stat(proxyFile); err != nil {
		proxyFile = ""
	}

	flags := scraper.Flags{
		NoSkip:         *noSkip,
		SkipItems:      *skipItems,
		SkipEpisodes:   *skipEpisodes,
		SkipReviews:    *skipReviews,
		SkipStatistics: *skipStatistics,
		SkipComments:   *skipComments,
		SkipThumbnails: *skipThumbnails,
	}

	stopCh := make(chan struct{})
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)

	if !*daemon {
		cfg := scraper.Config{
			Root:          *root,
			MaxConcurrent: *concurrent,
			Debug:         *debug,
			FreshAge:      *freshAge,
			FailFreshAge:  *failFreshAge,
			CommentAge:    *commentFreshAge,
		}
		s := scraper.New(cfg, flags, proxyFile)
		go func() {
			<-sig
			log.Println("shutting down...")
			s.Stop()
		}()
		if err := s.Run(); err != nil {
			log.Fatal(err)
		}
		return
	}

	// daemon mode
	go func() {
		<-sig
		log.Println("shutting down...")
		close(stopCh)
	}()

	drmCfg := drm.Config{
		Token:         *token,
		DecryptServer: *decrypt,
		EpisodeDir:    *root + "/episodes/v3",
		KeyDir:        *root + "/mediacloud/keys",
		MediacloudDir: *root + "/mediacloud",
		SleepMs:       *drmSleep,
	}

	for {
		// ── 1. scraper ──────────────────────────────────────────────
		log.Printf("daemon: starting scraper")
		cfg := scraper.Config{
			Root:          *root,
			MaxConcurrent: *concurrent,
			DaemonMode:    true,
			Debug:         *debug,
			FreshAge:      *freshAge,
			FailFreshAge:  *failFreshAge,
			CommentAge:    *commentFreshAge,
		}
		s := scraper.New(cfg, flags, proxyFile)
		if err := s.Run(); err != nil {
			log.Printf("daemon: scraper error: %v", err)
		}

		select {
		case <-stopCh:
			return
		default:
		}

		// ── 2. DRM ──────────────────────────────────────────────────
		if *token != "" {
			log.Printf("daemon: starting DRM")
			drmClient := drm.New(drmCfg)
			if err := drmClient.Run(0, false); err != nil {
				log.Printf("daemon: DRM error: %v", err)
			}
		} else {
			log.Printf("daemon: no --token, skipping DRM phase")
		}

		select {
		case <-stopCh:
			return
		default:
		}

		// ── 3. bitset ────────────────────────────────────────────────
		log.Printf("daemon: generating accessible bitset")
		server.GenerateAccessibleBitset(*root, *bitsetOut)

		// ── 3.5. server cache ────────────────────────────────────────
		log.Printf("daemon: rebuilding server cache (data.bin)")
		func() {
			store, err := cachepkg.NewStore()
			if err != nil {
				log.Printf("daemon: failed to rebuild store: %v", err)
				return
			}
			if err := store.SaveToFile(filepath.Join(*root, "data.bin")); err != nil {
				log.Printf("daemon: failed to save data.bin: %v", err)
				return
			}
			hc := lafutil.NewDirectClient()
			resp, err := hc.Post("http://127.0.0.1:4003/api/internal/reload", "application/json", nil)
			if err != nil {
				log.Printf("daemon: reload API request failed: %v", err)
				return
			}
			resp.Body.Close()
			if resp.StatusCode != http.StatusOK {
				log.Printf("daemon: reload API returned status %d", resp.StatusCode)
				return
			}
			log.Printf("daemon: server cache updated and signaled via API")
		}()

		// ── 4. wait ──────────────────────────────────────────────────
		if !sleep(stopCh, time.Duration(*waitHours*float64(time.Hour)), "daemon: waiting before next cycle") {
			return
		}
	}
}

func sleep(stopCh <-chan struct{}, d time.Duration, msg string) bool {
	log.Printf("%s (%.1fh)...", msg, d.Hours())
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-t.C:
		return true
	case <-stopCh:
		return false
	}
}
