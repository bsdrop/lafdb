package http

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	regexp "regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/gofiber/fiber/v3"
)

const dataDir = "./laftel"

type ogInfo struct {
	Title        string
	Description  string
	Image        string
	RedirectURL  string
	CanonicalURL string
}

type shareReviewResult struct {
	ReviewID     int64
	ItemID       int64
	ItemName     string
	AuthorName   string
	Content      string
	CreatedAt    string
	Score        float64
	HasScore     bool
	ProfileImage string
}

func (a *App) handlePlayerShare(c fiber.Ctx) error {
	episodeID, err := parseInt64Param(c, "episodeId")
	if err != nil {
		return err
	}

	a.mu.RLock()
	epBytes, epOk := a.ds.GetEpisode(episodeID)
	drmBytes, drmOk := a.ds.GetDRMKey(episodeID)
	itemID, itemOk := a.ds.EpisodeItemID(episodeID)
	a.mu.RUnlock()

	if !epOk {
		return sendNotFound(c)
	}

	var epData struct {
		Title         string `json:"title"`
		Subject       string `json:"subject"`
		Description   string `json:"description"`
		ThumbnailPath string `json:"thumbnail_path"`
		RunningTime   string `json:"running_time"`
	}
	if err := json.Unmarshal(epBytes, &epData); err != nil {
		return err
	}

	title := fmt.Sprintf("%s - %s", epData.Title, epData.Subject)
	description := epData.Description
	image := rewriteCDNString(c, epData.ThumbnailPath)
	shareTime, hasShareTime := normalizeShareTimeParam(c.Query("t"))
	if hasShareTime {
		if seconds, err := strconv.ParseFloat(shareTime, 64); err == nil {
			image = rewriteCDNString(c, selectEpisodeThumbnailAtTime(epData.ThumbnailPath, epData.RunningTime, seconds))
		}
	}

	// Build redirect URL
	redirectURL := fmt.Sprintf("/player.html#epId=%d", episodeID)
	if drmOk {
		var drmData struct {
			DashURL string `json:"dash_url"`
			Keys    []struct {
				KeyID string `json:"key_id"`
				Key   string `json:"key"`
			} `json:"keys"`
		}
		if err := json.Unmarshal(drmBytes, &drmData); err == nil {
			if len(drmData.Keys) > 0 {
				k := drmData.Keys[0]
				redirectURL += fmt.Sprintf("&mpd=%s&kid=%s&key=%s", url.QueryEscape(rewriteCDNString(c, drmData.DashURL)), k.KeyID, k.Key)
			}
		}
	}

	if hasShareTime {
		redirectURL += "&t=" + shareTime
	}

	canonicalURL := ""
	if itemOk {
		canonicalURL = fmt.Sprintf("%s/item/%d", c.BaseURL(), itemID)
	}

	return renderSharePage(c, ogInfo{
		Title:        title,
		Description:  description,
		Image:        image,
		RedirectURL:  redirectURL,
		CanonicalURL: canonicalURL,
	})
}

func (a *App) handleCommentShare(c fiber.Ctx) error {
	commentID, err := parseInt64Param(c, "commentId")
	if err != nil {
		return err
	}

	a.mu.RLock()
	ds := a.ds
	commentInfo, ok := ds.GetCommentShare(commentID)
	if !ok {
		a.mu.RUnlock()
		return sendNotFound(c)
	}
	drmBytes, drmOk := ds.GetDRMKey(commentInfo.EpisodeID)
	if commentInfo.ItemID == 0 && commentInfo.EpisodeID != 0 {
		if itemID, ok := ds.EpisodeItemID(commentInfo.EpisodeID); ok {
			commentInfo.ItemID = itemID
		}
	}
	if commentInfo.ItemName == "" && commentInfo.ItemID != 0 {
		if itemBytes, ok := ds.GetItem(commentInfo.ItemID); ok {
			var itemData struct {
				Name string `json:"name"`
			}
			if json.Unmarshal(itemBytes, &itemData) == nil && itemData.Name != "" {
				commentInfo.ItemName = itemData.Name
			}
		}
	}
	if (commentInfo.EpisodeSubject == "" || commentInfo.EpisodeNum == "") && commentInfo.EpisodeID != 0 {
		if epBytes, ok := ds.GetEpisode(commentInfo.EpisodeID); ok {
			var epData struct {
				Subject    string `json:"subject"`
				EpisodeNum string `json:"episode_num"`
			}
			if json.Unmarshal(epBytes, &epData) == nil {
				if commentInfo.EpisodeSubject == "" {
					commentInfo.EpisodeSubject = epData.Subject
				}
				if commentInfo.EpisodeNum == "" {
					commentInfo.EpisodeNum = epData.EpisodeNum
				}
			}
		}
	}
	a.mu.RUnlock()

	commentSorting := normalizeCommentSorting(c.Query("sorting"))
	redirectURL := fmt.Sprintf(
		"/player.html#epId=%d&itemId=%d&comment=%d&sorting=%s",
		commentInfo.EpisodeID,
		commentInfo.ItemID,
		commentInfo.ParentCommentID,
		url.QueryEscape(commentSorting),
	)
	if !commentInfo.IsReply {
		redirectURL = fmt.Sprintf(
			"/player.html#epId=%d&itemId=%d&comment=%d&sorting=%s",
			commentInfo.EpisodeID,
			commentInfo.ItemID,
			commentInfo.CommentID,
			url.QueryEscape(commentSorting),
		)
	}
	if commentInfo.IsReply {
		redirectURL += fmt.Sprintf("&reply=%d", commentID)
	}
	if t, ok := normalizeShareTimeParam(c.Query("t")); ok {
		redirectURL += "&t=" + t
	}
	if drmOk {
		var drmData struct {
			DashURL string `json:"dash_url"`
			Keys    []struct {
				KeyID string `json:"key_id"`
				Key   string `json:"key"`
			} `json:"keys"`
		}
		if err := json.Unmarshal(drmBytes, &drmData); err == nil && len(drmData.Keys) > 0 {
			k := drmData.Keys[0]
			redirectURL += fmt.Sprintf("&mpd=%s&kid=%s&key=%s", url.QueryEscape(rewriteCDNString(c, drmData.DashURL)), k.KeyID, k.Key)
		}
	}
	title := ""
	if commentInfo.EpisodeNum != "" {
		title += commentInfo.EpisodeNum + "화"
	}
	if commentInfo.EpisodeSubject != "" {
		if title != "" {
			title += " "
		}
		title += commentInfo.EpisodeSubject
	}
	if title == "" {
		title = "댓글"
	}
	if commentInfo.ItemName != "" {
		title += " | " + commentInfo.ItemName
	}

	descriptionParts := make([]string, 0, 2)
	metaLineParts := make([]string, 0, 2)
	if commentInfo.AuthorName != "" {
		metaLineParts = append(metaLineParts, commentInfo.AuthorName)
	}
	if commentInfo.CreatedAt != "" {
		metaLineParts = append(metaLineParts, formatCommentShareTime(commentInfo.CreatedAt))
	}
	if len(metaLineParts) > 0 {
		descriptionParts = append(descriptionParts, strings.Join(metaLineParts, " | "))
	}
	contentLine := strings.TrimSpace(commentInfo.Content)
	if contentLine != "" {
		descriptionParts = append(descriptionParts, contentLine)
	}
	description := strings.Join(descriptionParts, "\n\n")
	if description == "" {
		description = title
	}

	return renderSharePage(c, ogInfo{
		Title:        title,
		Description:  description,
		RedirectURL:  redirectURL,
		CanonicalURL: fmt.Sprintf("%s/item/%d", c.BaseURL(), commentInfo.ItemID),
	})
}

func (a *App) handleReviewShare(c fiber.Ctx) error {
	reviewID, err := parseInt64Param(c, "reviewId")
	if err != nil {
		return err
	}

	a.mu.RLock()
	ds := a.ds
	reviewEntry, ok := ds.GetReviewShare(reviewID)
	if !ok {
		a.mu.RUnlock()
		return sendNotFound(c)
	}
	reviewInfo := shareReviewResult{
		ReviewID:     reviewEntry.ReviewID,
		ItemID:       reviewEntry.ItemID,
		AuthorName:   reviewEntry.AuthorName,
		Content:      reviewEntry.Content,
		CreatedAt:    reviewEntry.CreatedAt,
		Score:        reviewEntry.Score,
		HasScore:     reviewEntry.HasScore,
		ProfileImage: reviewEntry.ProfileImage,
	}
	itemBytes, itemOk := ds.GetItem(reviewInfo.ItemID)
	a.mu.RUnlock()
	if !itemOk {
		return sendNotFound(c)
	}

	var itemData struct {
		Name   string `json:"name"`
		Images []struct {
			ImgURL string `json:"img_url"`
		} `json:"images"`
	}
	if err := json.Unmarshal(itemBytes, &itemData); err != nil {
		return err
	}
	if itemData.Name != "" {
		reviewInfo.ItemName = itemData.Name
	}

	sorting := normalizeReviewSorting(c.Query("sorting"))
	redirectURL := fmt.Sprintf(
		"/item.html#id=%d&review=%d&sorting=%s",
		reviewInfo.ItemID,
		reviewInfo.ReviewID,
		url.QueryEscape(sorting),
	)

	title := "리뷰"
	if reviewInfo.ItemName != "" {
		title = fmt.Sprintf("%s 리뷰", reviewInfo.ItemName)
	}
	descriptionParts := make([]string, 0, 2)
	metaLineParts := make([]string, 0, 2)
	if reviewInfo.AuthorName != "" {
		metaLineParts = append(metaLineParts, reviewInfo.AuthorName)
	}
	if reviewInfo.CreatedAt != "" {
		metaLineParts = append(metaLineParts, formatCommentShareTime(reviewInfo.CreatedAt))
	}
	if reviewInfo.HasScore {
		metaLineParts = append(metaLineParts, fmt.Sprintf("★ %.1f", reviewInfo.Score))
	}
	if len(metaLineParts) > 0 {
		descriptionParts = append(descriptionParts, strings.Join(metaLineParts, " | "))
	}
	contentLine := strings.TrimSpace(reviewInfo.Content)
	if contentLine != "" {
		descriptionParts = append(descriptionParts, contentLine)
	}
	description := strings.Join(descriptionParts, "\n\n")
	if description == "" {
		description = title
	}

	image := ""
	if len(itemData.Images) > 0 {
		image = rewriteCDNString(c, itemData.Images[0].ImgURL)
	}

	return renderSharePage(c, ogInfo{
		Title:        title,
		Description:  description,
		Image:        image,
		RedirectURL:  redirectURL,
		CanonicalURL: fmt.Sprintf("%s/item/%d", c.BaseURL(), reviewInfo.ItemID),
	})
}

func (a *App) handleItemShare(c fiber.Ctx) error {
	itemID, err := parseInt64Param(c, "id")
	if err != nil {
		return err
	}

	a.mu.RLock()
	itemBytes, itemOk := a.ds.GetItem(itemID)
	a.mu.RUnlock()

	if !itemOk {
		return sendNotFound(c)
	}

	var itemData struct {
		Name    string `json:"name"`
		Content string `json:"content"`
		Images  []struct {
			ImgURL string `json:"img_url"`
		} `json:"images"`
	}
	if err := json.Unmarshal(itemBytes, &itemData); err != nil {
		return err
	}

	title := itemData.Name
	description := itemData.Content
	image := ""
	if len(itemData.Images) > 0 {
		image = rewriteCDNString(c, itemData.Images[0].ImgURL)
	}

	redirectURL := fmt.Sprintf("/item.html#id=%d", itemID)

	return renderSharePage(c, ogInfo{
		Title:        title,
		Description:  description,
		Image:        image,
		RedirectURL:  redirectURL,
		CanonicalURL: fmt.Sprintf("%s/item/%d", c.BaseURL(), itemID),
	})
}

func (a *App) handleSitemap(c fiber.Ctx) error {
	a.mu.RLock()
	defer a.mu.RUnlock()

	proto := c.Get("X-Forwarded-Proto")
	if proto != "https" && proto != "http" {
		proto = "http"
	}
	host := c.Get("Host")
	if host == "" {
		host = c.Hostname()
	}
	baseURL := proto + "://" + host

	var sb strings.Builder
	sb.WriteString(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`)

	fmt.Fprintf(&sb, "\t<url><loc>%s/</loc><changefreq>daily</changefreq></url>\n", baseURL)
	fmt.Fprintf(&sb, "\t<url><loc>%s/docs</loc><changefreq>monthly</changefreq></url>\n", baseURL)
	fmt.Fprintf(&sb, "\t<url><loc>%s/docs/openapi.json</loc><changefreq>monthly</changefreq></url>\n", baseURL)

	playable := a.ds.GetPlayableItemIDs()
	ending := a.ds.GetEndingItemIDs()
	for itemID := range playable {
		changefreq := "monthly"
		if _, ok := ending[itemID]; ok {
			changefreq = "yearly"
		}
		fmt.Fprintf(&sb, "\t<url><loc>%s/item/%d</loc><changefreq>%s</changefreq></url>\n", baseURL, itemID, changefreq)
	}

	sb.WriteString(`</urlset>`)

	c.Set("Content-Type", "application/xml; charset=utf-8")
	return c.SendString(sb.String())
}

func (a *App) handleRobots(c fiber.Ctx) error {
	proto := c.Get("X-Forwarded-Proto")
	if proto != "https" && proto != "http" {
		proto = "http"
	}
	host := c.Get("Host")
	if host == "" {
		host = c.Hostname()
	}
	body := "User-agent: *\nAllow: /item/\nAllow: /player/\nAllow: /comment/\nAllow: /review/\nSitemap: " + proto + "://" + host + "/sitemap.xml\n"
	c.Set("Content-Type", "text/plain; charset=utf-8")
	return c.SendString(body)
}

func renderSharePage(c fiber.Ctx, info ogInfo) error {
	c.Set("Content-Type", "text/html; charset=utf-8")

	canonicalTag := ""
	if info.CanonicalURL != "" {
		canonicalTag = fmt.Sprintf(`<link rel="canonical" href="%s">`, escapeHTML(info.CanonicalURL))
	}
	imageTag := ""
	if info.Image != "" {
		imageTag = fmt.Sprintf(`<meta property="og:image" content="%s">`, escapeHTML(info.Image))
	}

	html := fmt.Sprintf(`<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <title>%s</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="theme-color" content="#6e58ff">
  %s
  <meta property="og:title" content="%s">
  <meta property="og:description" content="%s">
  %s
  <meta property="og:type" content="video.other">
  <meta name="twitter:card" content="summary_large_image">
  <meta http-equiv="refresh" content="1;url=%s">
  <style>
    body { display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #111; color: #eee; }
    a { color: #007aff; text-decoration: none; }
  </style>
</head>
<body>
  <div style="text-align: center;">
    <p>잠시 후 이동합니다...</p>
    <p><a href="%s">이동하지 않으면 여기를 클릭하세요.</a></p>
  </div>
  <script>window.location.replace(%q);</script>
</body>
</html>`,
		escapeHTML(info.Title),
		canonicalTag,
		escapeHTML(info.Title),
		escapeHTML(info.Description),
		imageTag,
		escapeHTML(info.RedirectURL),
		escapeHTML(info.RedirectURL),
		info.RedirectURL)
	return c.SendString(html)
}

func escapeHTML(s string) string {
	s = strings.ReplaceAll(s, "&", "&amp;")
	s = strings.ReplaceAll(s, "<", "&lt;")
	s = strings.ReplaceAll(s, ">", "&gt;")
	s = strings.ReplaceAll(s, `"`, "&quot;")
	s = strings.ReplaceAll(s, "'", "&#39;")
	return s
}

func normalizeCommentSorting(s string) string {
	switch s {
	case "top", "newest", "oldest":
		return s
	default:
		return "top"
	}
}

func normalizeReviewSorting(s string) string {
	switch s {
	case "like", "newest", "created":
		return s
	default:
		return "like"
	}
}

func normalizeShareTimeParam(s string) (string, bool) {
	if s == "" {
		return "", false
	}

	dotCount := 0
	hasDigit := false
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= '0' && c <= '9':
			hasDigit = true
		case c == '.':
			dotCount++
			if dotCount > 1 {
				return "", false
			}
		default:
			return "", false
		}
	}
	if !hasDigit {
		return "", false
	}

	if s[len(s)-1] == '.' {
		s = s[:len(s)-1]
	}
	if s == "" {
		return "", false
	}
	if s[0] == '.' {
		return "0" + s, true
	}
	return s, true
}

func rewriteCDNString(c fiber.Ctx, s string) string {
	return rewriteCDNStringForMirror(s, getMirrorRoot(c))
}

func formatCommentShareTime(s string) string {
	if s == "" {
		return s
	}
	end := len(s)
	for i := 0; i < len(s); i++ {
		if s[i] == '.' {
			end = i
			break
		}
	}
	if end == 0 {
		return ""
	}
	buf := []byte(s[:end])
	for i := 0; i < len(buf); i++ {
		if buf[i] == 'T' {
			buf[i] = ' '
			break
		}
	}
	return string(buf)
}

func selectEpisodeThumbnailAtTime(thumbnailPath, runningTime string, seconds float64) string {
	if thumbnailPath == "" || runningTime == "" || seconds < 0 {
		return thumbnailPath
	}
	dot := strings.LastIndex(thumbnailPath, ".")
	if dot < 0 {
		return thumbnailPath
	}
	start := dot - 1
	for start >= 0 && thumbnailPath[start] >= '0' && thumbnailPath[start] <= '9' {
		start--
	}
	start++
	if start >= dot {
		return thumbnailPath
	}
	frameDigits := thumbnailPath[start:dot]
	frameCount, err := maxThumbnailFrameCount(thumbnailPath)
	if err != nil || frameCount <= 0 {
		frameCount, err = strconv.Atoi(frameDigits)
		if err != nil || frameCount <= 0 {
			return thumbnailPath
		}
	}
	totalSeconds, ok := parseEpisodeRunningTimeSeconds(runningTime)
	if !ok || totalSeconds <= 0 {
		return thumbnailPath
	}
	if seconds > totalSeconds {
		seconds = totalSeconds
	}
	frameIndex := int(seconds*float64(frameCount)/totalSeconds) + 1
	if frameIndex < 1 {
		frameIndex = 1
	}
	if frameIndex > frameCount {
		frameIndex = frameCount
	}
	replacement := strconv.Itoa(frameIndex)
	if len(replacement) < len(frameDigits) {
		replacement = strings.Repeat("0", len(frameDigits)-len(replacement)) + replacement
	}
	return thumbnailPath[:start] + replacement + thumbnailPath[dot:]
}

func parseEpisodeRunningTimeSeconds(s string) (float64, bool) {
	parts := strings.Split(s, ":")
	if len(parts) != 3 {
		return 0, false
	}
	hours, err := strconv.Atoi(parts[0])
	if err != nil {
		return 0, false
	}
	minutes, err := strconv.Atoi(parts[1])
	if err != nil {
		return 0, false
	}
	seconds, err := strconv.ParseFloat(parts[2], 64)
	if err != nil {
		return 0, false
	}
	return float64(hours*3600+minutes*60) + seconds, true
}

var thumbnailFilePattern = regexp.MustCompile(`^Thumbnail\.(\d+)\.jpg$`)

func maxThumbnailFrameCount(thumbnailPath string) (int, error) {
	u, err := url.Parse(thumbnailPath)
	if err != nil {
		return 0, err
	}
	localPath := filepath.Join(dataDir, "thumbnail", filepath.FromSlash(strings.TrimPrefix(u.Path, "/")))
	dir := filepath.Dir(localPath)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return 0, err
	}
	frames := make([]int, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		matches := thumbnailFilePattern.FindStringSubmatch(entry.Name())
		if matches == nil {
			continue
		}
		frame, convErr := strconv.Atoi(matches[1])
		if convErr == nil && frame > 0 {
			frames = append(frames, frame)
		}
	}
	if len(frames) == 0 {
		return 0, fmt.Errorf("thumbnail frames not found")
	}
	sort.Ints(frames)
	return lastContinuousThumbnailFrame(frames), nil
}

func lastContinuousThumbnailFrame(frames []int) int {
	if len(frames) == 0 {
		return 0
	}
	bestStart, bestEnd := frames[0], frames[0]
	runStart, runEnd := frames[0], frames[0]
	for i := 1; i < len(frames); i++ {
		frame := frames[i]
		switch {
		case frame == runEnd:
			continue
		case frame == runEnd+1:
			runEnd = frame
		default:
			if shouldPreferThumbnailRun(runStart, runEnd, bestStart, bestEnd) {
				bestStart, bestEnd = runStart, runEnd
			}
			runStart, runEnd = frame, frame
		}
	}
	if shouldPreferThumbnailRun(runStart, runEnd, bestStart, bestEnd) {
		bestStart, bestEnd = runStart, runEnd
	}
	return bestEnd
}

func shouldPreferThumbnailRun(start, end, bestStart, bestEnd int) bool {
	if bestEnd < bestStart {
		return true
	}
	runStartsAtOne := start == 1
	bestStartsAtOne := bestStart == 1
	if runStartsAtOne != bestStartsAtOne {
		return runStartsAtOne
	}
	runLen := end - start
	bestLen := bestEnd - bestStart
	if runLen != bestLen {
		return runLen > bestLen
	}
	return end > bestEnd
}
