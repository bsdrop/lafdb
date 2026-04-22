package main

import (
	"context"
	"flag"
	"log"
	"math"
	"net/http"
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
	token := flag.String("token", "", "Laftel API token")
	decrypt := flag.String("decrypt", "http://127.0.0.1:3040/api/decrypt", "CDM server URL")
	sleep := flag.Int("sleep", 16000, "sleep between requests (ms)")
	skip := flag.Int("skip-first", 0, "skip first N episodes")
	skipFailed := flag.Bool("skip-failed", false, "skip episodes previously failed due to missing DRM token")
	daemon := flag.Bool("daemon", false, "run continuously: scraper → DRM → cache rebuild → signal server")
	proxies := flag.String("proxies", "./proxies.txt", "proxy list file for scraper phase")
	flag.Parse()

	if *token == "" {
		log.Fatal("-token is required")
	}

	drmCfg := drm.Config{
		Token:         *token,
		DecryptServer: *decrypt,
		EpisodeDir:    *root + "/episodes/v3",
		KeyDir:        *root + "/mediacloud/keys",
		MediacloudDir: *root + "/mediacloud",
		SleepMs:       *sleep,
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	if !*daemon {
		client := drm.New(drmCfg)
		if err := client.Run(*skip, *skipFailed); err != nil {
			log.Fatal(err)
		}
		return
	}

	// daemon mode: Full Workflow
	for {
		start := time.Now()

		// ── 1. Scraper Phase ────────────────────────────────────────
		log.Printf("daemon: starting scraper phase")
		s := scraper.New(scraper.Config{
			Root:          *root,
			MaxConcurrent: 8,
			DaemonMode:    true,
		}, scraper.Flags{}, *proxies)

		// ensure we stop the scraper if context is canceled
		go func() {
			<-ctx.Done()
			s.Stop()
		}()

		if err := s.Run(); err != nil {
			log.Printf("daemon: scraper error: %v", err)
		}

		if ctx.Err() != nil {
			return
		}

		// ── 2. DRM Phase ────────────────────────────────────────────
		log.Printf("daemon: starting DRM phase")
		drmClient := drm.New(drmCfg)

		// ensure we stop the DRM phase if context is canceled
		go func() {
			<-ctx.Done()
			drmClient.Stop()
		}()

		if err := drmClient.Run(*skip, *skipFailed); err != nil {
			log.Printf("daemon: DRM error: %v", err)
		}

		if ctx.Err() != nil {
			return
		}

		// ── 3. Cache & Server Update Phase ──────────────────────────
		log.Printf("daemon: rebuilding cache and signaling server")
		func() {
			server.GenerateAccessibleBitset(*root, filepath.Join(*root, "../public/accessible.js"))

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
			if resp.StatusCode == http.StatusOK {
				log.Printf("daemon: server cache updated and reloaded via API")
			} else {
				log.Printf("daemon: reload API returned status %d", resp.StatusCode)
			}
		}()

		interval := daemonInterval(time.Since(start))
		log.Printf("daemon: next run in %.2f days", interval.Hours()/24)

		timer := time.NewTimer(interval)
		select {
		case <-timer.C:
		case <-ctx.Done():
			timer.Stop()
			return
		}
	}
}

func daemonInterval(elapsed time.Duration) time.Duration {
	days := elapsed.Hours() / 24.0
	next := math.Max(1, math.Min(days*3+5, 14))
	return time.Duration(next * 24 * float64(time.Hour))
}
