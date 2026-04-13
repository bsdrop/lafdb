package cache

import (
	"fmt"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"time"
)

type progressPrinter struct {
	label     string
	total     int
	processed int
	start     time.Time
	lastPrint time.Time
}

func newProgressPrinter(label string, total int) *progressPrinter {
	return &progressPrinter{label: label, total: total, start: time.Now()}
}

func (p *progressPrinter) tick() {
	p.processed++
	now := time.Now()
	if p.processed != p.total && now.Sub(p.lastPrint) < 250*time.Millisecond {
		return
	}
	p.lastPrint = now
	elapsed := now.Sub(p.start)
	eta := ""
	if p.processed > 0 && p.total > p.processed {
		remaining := time.Duration(float64(elapsed) / float64(p.processed) * float64(p.total-p.processed)).Round(time.Second)
		eta = fmt.Sprintf(" ETA:%s", remaining)
	}
	fmt.Printf("\r%s: %d/%d (%.1f%%%s)    ", p.label, p.processed, p.total, float64(p.processed)/float64(p.total)*100, eta)
}

func (p *progressPrinter) done(note string) {
	if p.total == 0 {
		fmt.Printf("\r%s: 0/0 (%s)    \n", p.label, note)
		return
	}
	if p.processed < p.total {
		p.processed = p.total
		fmt.Printf("\r%s: %d/%d (100.0%%)    ", p.label, p.processed, p.total)
	}
	fmt.Println()
}

func resolveWalkRoot(root string) (string, error) {
	cleanRoot := filepath.Clean(root)
	resolved, err := filepath.EvalSymlinks(cleanRoot)
	if err != nil {
		if os.IsNotExist(err) {
			return cleanRoot, err
		}
		log.Printf("walk: resolve symlink %s failed, using original path: %v", cleanRoot, err)
		return cleanRoot, nil
	}
	if resolved != cleanRoot {
		log.Printf("walk: resolved %s -> %s", cleanRoot, resolved)
	}
	return resolved, nil
}

func WalkFilesProgress(label, root string, match func(path string, d fs.DirEntry) bool, fn func(path string) error) error {
	resolvedRoot, err := resolveWalkRoot(root)
	if err != nil {
		newProgressPrinter(label, 0).done("missing")
		return err
	}
	if _, err := os.Stat(resolvedRoot); err != nil {
		newProgressPrinter(label, 0).done("missing")
		return err
	}

	total := 0
	if err := filepath.WalkDir(resolvedRoot, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !d.IsDir() && match(path, d) {
			total++
		}
		return nil
	}); err != nil {
		newProgressPrinter(label, 0).done("error")
		return err
	}

	progress := newProgressPrinter(label, total)
	if total == 0 {
		progress.done("empty")
		return nil
	}

	fileErrors := 0
	err = filepath.WalkDir(resolvedRoot, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() || !match(path, d) {
			return nil
		}
		if err := fn(path); err != nil {
			fileErrors++
			log.Printf("%s: skipping %s: %v", label, path, err)
			progress.tick()
			return nil
		}
		progress.tick()
		return nil
	})
	progress.done("done")
	if fileErrors > 0 {
		log.Printf("%s: completed with %d skipped file errors", label, fileErrors)
	}
	return err
}
