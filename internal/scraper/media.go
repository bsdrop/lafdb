package scraper

import (
	"fmt"
	"net/url"
	"path"
	"path/filepath"
	regexp "regexp"
	"strconv"
	"strings"

	"github.com/bsdrop/lafdb/internal/lafutil"
)

var baseThumb = "https://thumbnail.laftel.net"
var thumbnailSequencePattern = regexp.MustCompile(`^Thumbnail\.(\d+)\.jpg$`)

func thumbURL(u string) string {
	if strings.HasPrefix(u, "/thumbnail/") {
		return baseThumb + "/" + strings.TrimPrefix(u, "/thumbnail/")
	}
	return u
}

func (s *Scraper) downloadImage(rawURL string) string {
	if s.flags.SkipThumbnails || rawURL == "" {
		return "skip"
	}
	realURL := thumbURL(rawURL)
	result := s.downloadImageFile(realURL)
	if st, ok := s.downloadThumbnailSequence(realURL); ok {
		return mergeDownloadStatus(result, st)
	}
	return result
}

func (s *Scraper) downloadImageFile(realURL string) string {
	u, err := url.Parse(realURL)
	if err != nil {
		return "err"
	}
	localPath := filepath.Join(s.dir("thumbnail"), filepath.FromSlash(u.Path))
	if lafutil.FileExists(localPath) {
		return "skip"
	}
	body, status, err := s.get(realURL)
	if err != nil {
		return "err"
	}
	if status == 403 || status == 404 {
		return strconv.Itoa(status)
	}
	if status != 200 {
		return "err"
	}
	if err := lafutil.WriteFile(localPath, body); err != nil {
		return "err"
	}
	return "200"
}

func (s *Scraper) downloadThumbnailSequence(realURL string) (string, bool) {
	u, err := url.Parse(realURL)
	if err != nil {
		return "err", true
	}
	baseName := path.Base(u.Path)
	matches := thumbnailSequencePattern.FindStringSubmatch(baseName)
	if matches == nil {
		return "", false
	}

	width := len(matches[1])
	sequenceStatus := "skip"
	for frame := 0; ; frame++ {
		frameName := fmt.Sprintf("Thumbnail.%0*d.jpg", width, frame)
		frameURL := *u
		frameURL.Path = path.Join(path.Dir(u.Path), frameName)
		result := s.downloadImageFile(frameURL.String())
		switch result {
		case "200":
			sequenceStatus = "200"
		case "skip":
			// Keep probing until the first missing frame so reruns can resume correctly.
		case "404", "403":
			if frame == 0 {
				continue
			}
			if frame == 1 {
				break
			}
			return sequenceStatus, true
		default:
			return result, true
		}
		if frame == 0 {
			continue
		}
	}
	return sequenceStatus, true
}

func mergeDownloadStatus(current, next string) string {
	if current == "200" || next == "200" {
		return "200"
	}
	if current == "err" || next == "err" {
		return "err"
	}
	if current == "skip" {
		return next
	}
	if next == "skip" {
		return current
	}
	return next
}
