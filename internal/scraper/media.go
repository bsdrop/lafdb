package scraper

import (
	"net/url"
	"path/filepath"
	"strings"

	"github.com/bsdrop/lafdb/internal/lafutil"
)

const baseThumb = "https://thumbnail.laftel.net"

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
	u, err := url.Parse(realURL)
	if err != nil {
		return "err"
	}
	localPath := filepath.Join(s.dir("thumbnail"), filepath.FromSlash(u.Path))
	if lafutil.FileExists(localPath) {
		return "skip"
	}
	body, status, err := s.get(realURL)
	if err != nil || status != 200 {
		return "err"
	}
	if err := lafutil.WriteFile(localPath, body); err != nil {
		return "err"
	}
	return "200"
}
