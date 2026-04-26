// Package scraper fetches Laftel API data and saves it locally.
package scraper

import (
	"fmt"
	"log"
	"math/rand/v2"
	"os"
	"sync"
	"sync/atomic"
	"time"

	"github.com/bsdrop/lafdb/internal/lafutil"
)

type Config struct {
	Root          string
	MaxConcurrent int  // fallback when no proxy pool; default 8
	DaemonMode    bool // add 33–66ms delay before returning proxy to pool
	Debug         bool // log every request; suppress \r progress display
}

type Flags struct {
	NoSkip         bool
	SkipItems      bool
	SkipEpisodes   bool
	SkipReviews    bool
	SkipStatistics bool
	SkipComments   bool
	SkipThumbnails bool
}

type Scraper struct {
	cfg      Config
	flags    Flags
	pool     chan *lafutil.ProxyEntry // nil = direct only
	direct   *lafutil.ProxyEntry
	stopping atomic.Bool
}

func New(cfg Config, flags Flags, proxyFile string) *Scraper {
	s := &Scraper{
		cfg:    cfg,
		flags:  flags,
		direct: &lafutil.ProxyEntry{Client: lafutil.NewDirectClient()},
	}
	if proxyFile != "" {
		entries, err := lafutil.LoadProxies(proxyFile)
		if err != nil {
			log.Printf("proxies: %v (running direct)", err)
		} else {
			s.pool = make(chan *lafutil.ProxyEntry, len(entries))
			for i := range entries {
				s.pool <- &entries[i]
			}
			log.Printf("proxies: loaded %d", len(entries))
		}
	}
	return s
}

func (s *Scraper) Stop() { s.stopping.Store(true) }

func (s *Scraper) debugf(format string, args ...any) {
	if s.cfg.Debug {
		log.Printf(format, args...)
	}
}

// acquireProxy blocks until a proxy slot is available.
func (s *Scraper) acquireProxy() *lafutil.ProxyEntry {
	if s.pool == nil {
		return s.direct
	}
	return <-s.pool
}

// releaseProxy returns the proxy to the pool, with a delay in daemon mode.
func (s *Scraper) releaseProxy(e *lafutil.ProxyEntry) {
	if s.pool == nil {
		return
	}
	if s.cfg.DaemonMode {
		// #nosec G404
		delay := time.Duration(33+rand.IntN(34)) * time.Millisecond
		go func() { time.Sleep(delay); s.pool <- e }()
	} else {
		s.pool <- e
	}
}

func (s *Scraper) get(url string) ([]byte, int, error) {
	proxy := s.acquireProxy()
	defer s.releaseProxy(proxy)
	return lafutil.Get(proxy.Client, url, map[string]string{
		"Accept": "application/json,*/*",
	})
}

func (s *Scraper) runPool(ids []int64, worker func(int64) string, label string) {
	total := len(ids)
	if total == 0 {
		log.Printf("[%s] nothing to do", label)
		return
	}

	var done, success, skip, notFound, fail atomic.Int64

	// concurrency: use all proxies when pool is set; otherwise MaxConcurrent
	concurrency := s.cfg.MaxConcurrent
	if s.pool != nil {
		concurrency = cap(s.pool)
	}
	if concurrency <= 0 {
		concurrency = 8
	}

	// \r progress renderer (skipped in debug mode)
	var stopRender chan struct{}
	renderDone := make(chan struct{})
	if !s.cfg.Debug {
		stopRender = make(chan struct{})
		render := func() {
			d := done.Load()
			pct := float64(d) / float64(total) * 100
			if (label == "comments" || label == "comment-replies") && skip.Load() == 0 {
				line := fmt.Sprintf("[%s] %d/%d  ok=%d 404=%d fail=%d  %.2f%%",
					label, d, total,
					success.Load(), notFound.Load(), fail.Load(), pct)
				fmt.Fprintf(os.Stderr, "\r%-90s", line)
				return
			}
			line := fmt.Sprintf("[%s] %d/%d  ok=%d skip=%d 404=%d fail=%d  %.2f%%",
				label, d, total,
				success.Load(), skip.Load(), notFound.Load(), fail.Load(), pct)
			fmt.Fprintf(os.Stderr, "\r%-90s", line)
		}
		go func() {
			defer close(renderDone)
			ticker := time.NewTicker(100 * time.Millisecond)
			defer ticker.Stop()
			for {
				select {
				case <-ticker.C:
					render()
				case <-stopRender:
					render()
					fmt.Fprintln(os.Stderr)
					return
				}
			}
		}()
	} else {
		close(renderDone)
	}

	queue := make(chan int64, len(ids))
	for _, id := range ids {
		queue <- id
	}
	close(queue)

	sem := make(chan struct{}, concurrency)
	var wg sync.WaitGroup
	for id := range queue {
		if s.stopping.Load() {
			break
		}
		sem <- struct{}{}
		wg.Add(1)
		go func(id int64) {
			defer func() { <-sem; wg.Done() }()
			result := worker(id)
			switch result {
			case "200":
				success.Add(1)
				s.debugf("[%s] %d ok", label, id)
			case "skip":
				skip.Add(1)
				s.debugf("[%s] %d skip", label, id)
			case "404":
				notFound.Add(1)
				s.debugf("[%s] %d 404", label, id)
			default:
				fail.Add(1)
				// always log failures; in non-debug mode prepend \n so it doesn't
				// corrupt the \r progress line permanently
				if s.cfg.Debug {
					log.Printf("[%s] %d fail: %s", label, id, result)
				} else {
					fmt.Fprintf(os.Stderr, "\n[%s] %d fail: %s\n", label, id, result)
				}
			}
			done.Add(1)
		}(id)
	}
	wg.Wait()

	if !s.cfg.Debug {
		close(stopRender)
		<-renderDone
	}
}

func (s *Scraper) Run() error {
	// descending: newest IDs first (119999 → 10000)
	allIDs := make([]int64, 110000)
	for i := range allIDs {
		allIDs[i] = int64(119999 - i)
	}
	for _, d := range []string{
		"items/v4", "episodes/v3", "episodes/v3/list",
		"thumbnail", "reviews/v2/list",
		"items/v1", "comments/v1/list", "comments/v1/replies", "comments/v1/.stamps",
	} {
		_ = os.MkdirAll(s.dir(d), 0750)
	}

	if !s.flags.SkipItems {
		s.runPool(allIDs, s.fetchItem, "items")
	}
	if !s.flags.SkipEpisodes {
		s.runPool(allIDs, s.fetchEpisodeList, "ep-list")
		epIDs, _ := collectEpisodeIDsFromLists(s.dir("episodes/v3/list"))
		s.runPool(epIDs, s.fetchEpisodeDetail, "ep-detail")
	}
	if !s.flags.SkipReviews {
		itemIDs, _ := existingIDs(s.dir("items/v4"))
		s.runPool(itemIDs, s.fetchReviews, "reviews")
	}
	if !s.flags.SkipStatistics {
		itemIDs, _ := existingIDs(s.dir("items/v4"))
		s.runPool(itemIDs, s.fetchStatistics, "statistics")
	}
	if !s.flags.SkipComments {
		epIDs, _ := collectEpisodeIDsFromLists(s.dir("episodes/v3/list"))
		commentEpIDs := s.filterCommentEpIDs(epIDs)
		s.runPool(commentEpIDs, s.fetchComments, "comments")
		replyIDs := s.collectCommentIDsWithReplies()
		log.Printf("[comment-replies] %d parent comments with replies", len(replyIDs))
		s.runPool(replyIDs, s.fetchCommentReplies, "comment-replies")
	}
	return nil
}
