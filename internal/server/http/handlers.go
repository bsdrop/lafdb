package http

import (
	"strconv"

	"github.com/gofiber/fiber/v3"
)

func (a *App) handleEpisodeList(c fiber.Ctx) error {
	ds := a.dataSource()
	itemID, err := parseInt64Query(c, "item_id")
	if err != nil {
		return err
	}
	b, ok := ds.GetEpisodesList(itemID)
	if !ok {
		return sendNotFound(c)
	}
	sorting := ""
	switch querySorting(c) {
	case "newest":
		sorting = "ep_newest"
	case "oldest":
		sorting = "ep_oldest"
	}
	return sendJSONSlice(c, b, c.Query("offset"), c.Query("limit"), sorting)
}

func (a *App) handleEpisodeDetail(c fiber.Ctx) error {
	ds := a.dataSource()
	episodeID, err := parseInt64Param(c, "episodeId")
	if err != nil {
		return err
	}
	b, ok := ds.GetEpisode(episodeID)
	if !ok {
		return sendNotFound(c)
	}
	if itemID, ok := ds.EpisodeItemID(episodeID); ok {
		b = injectJSONField(b, "item_id", itemID)
	}
	return sendJSONBytes(c, b)
}

func (a *App) handleEpisodeVideo(c fiber.Ctx) error {
	ds := a.dataSource()
	episodeID, err := parseInt64Param(c, "episodeId")
	if err != nil {
		return err
	}
	b, ok := ds.GetDRMKey(episodeID)
	if !ok {
		return sendNotFound(c)
	}
	return sendJSONBytes(c, b)
}

func (a *App) handleItem(c fiber.Ctx) error {
	ds := a.dataSource()
	itemID, err := parseInt64Param(c, "id")
	if err != nil {
		return err
	}
	b, ok := ds.GetItem(itemID)
	if !ok {
		return sendNotFound(c)
	}
	return sendJSONBytes(c, b)
}

func (a *App) handleSeries(c fiber.Ctx) error {
	ds := a.dataSource()
	seriesID, err := parseInt64Param(c, "id")
	if err != nil {
		return err
	}
	b, ok := ds.GetSeries(seriesID)
	if !ok {
		return sendNotFound(c)
	}
	return sendJSONBytes(c, b)
}

func (a *App) handleEpisodeToItem(c fiber.Ctx) error {
	ds := a.dataSource()
	episodeID, err := parseInt64Param(c, "episodeId")
	if err != nil {
		return err
	}
	itemID, ok := ds.EpisodeItemID(episodeID)
	if !ok {
		return sendNotFound(c)
	}
	b, ok := ds.GetItem(itemID)
	if !ok {
		return sendNotFound(c)
	}
	return sendJSONBytes(c, b)
}

func (a *App) handleEpisodeToEpisodes(c fiber.Ctx) error {
	ds := a.dataSource()
	episodeID, err := parseInt64Param(c, "episodeId")
	if err != nil {
		return err
	}
	itemID, ok := ds.EpisodeItemID(episodeID)
	if !ok {
		return sendNotFound(c)
	}
	b, ok := ds.GetEpisodesList(itemID)
	if !ok {
		return sendNotFound(c)
	}
	return sendJSONBytes(c, b)
}

func (a *App) handleReviewCount(c fiber.Ctx) error {
	ds := a.dataSource()
	itemID, err := parseInt64Query(c, "item_id")
	if err != nil {
		return err
	}
	b, ok := ds.GetReviewCount(itemID)
	if !ok {
		return sendNotFound(c)
	}
	return sendJSONBytes(c, b)
}

func (a *App) handleReviewList(c fiber.Ctx) error {
	ds := a.dataSource()
	itemID, err := parseInt64Query(c, "item_id")
	if err != nil {
		return err
	}
	b, ok := ds.GetReviewList(itemID)
	if !ok {
		return sendNotFound(c)
	}
	return sendJSONSlice(c, b, c.Query("offset"), c.Query("limit"), querySorting(c))
}

func (a *App) handleStatistics(c fiber.Ctx) error {
	ds := a.dataSource()
	itemID, err := parseInt64Param(c, "id")
	if err != nil {
		return err
	}
	b, ok := ds.GetStatistics(itemID)
	if !ok {
		return sendNotFound(c)
	}
	return sendJSONBytes(c, b)
}

func (a *App) handleCommentCount(c fiber.Ctx) error {
	ds := a.dataSource()
	epID, err := parseInt64Query(c, "episode_id")
	if err != nil {
		return err
	}
	b, ok := ds.GetCommentCount(epID)
	if !ok {
		return sendNotFound(c)
	}
	return sendJSONBytes(c, b)
}

func (a *App) handleCommentList(c fiber.Ctx) error {
	ds := a.dataSource()
	if pidStr := c.Query("parent_comment_id"); pidStr != "" {
		pid, err := strconv.ParseInt(pidStr, 10, 64)
		if err != nil {
			c.Status(fiber.StatusBadRequest)
			return sendJSON(c, fiber.Map{"error": "invalid parent_comment_id"})
		}
		b, ok := ds.GetCommentReplies(pid)
		if !ok {
			return sendJSONBytes(c, emptyPaginatedJSON)
		}
		return sendJSONSlice(c, b, c.Query("offset"), c.Query("limit"), querySorting(c))
	}
	epID, err := parseInt64Query(c, "episode_id")
	if err != nil {
		return err
	}
	b, ok := ds.GetCommentList(epID)
	if !ok {
		return sendNotFound(c)
	}
	return sendJSONSlice(c, b, c.Query("offset"), c.Query("limit"), querySorting(c))
}

func (a *App) handleReviewPosition(c fiber.Ctx) error {
	ds := a.dataSource()
	itemID, err := parseInt64Query(c, "item_id")
	if err != nil {
		return err
	}
	reviewID, err := parseInt64Query(c, "id")
	if err != nil {
		return err
	}
	b, ok := ds.GetReviewList(itemID)
	if !ok {
		return sendNotFound(c)
	}
	pos := findIDPosition(b, reviewID, querySorting(c))
	if pos < 0 {
		return sendNotFound(c)
	}
	return sendJSON(c, fiber.Map{"offset": pos})
}

func (a *App) handleCommentPosition(c fiber.Ctx) error {
	ds := a.dataSource()
	epID, err := parseInt64Query(c, "episode_id")
	if err != nil {
		return err
	}
	commentID, err := parseInt64Query(c, "id")
	if err != nil {
		return err
	}
	b, ok := ds.GetCommentList(epID)
	if !ok {
		return sendNotFound(c)
	}
	pos := findIDPosition(b, commentID, querySorting(c))
	if pos < 0 {
		return sendNotFound(c)
	}
	return sendJSON(c, fiber.Map{"offset": pos})
}

func (a *App) handleReplyPosition(c fiber.Ctx) error {
	ds := a.dataSource()
	pid, err := parseInt64Query(c, "parent_comment_id")
	if err != nil {
		return err
	}
	replyID, err := parseInt64Query(c, "id")
	if err != nil {
		return err
	}
	b, ok := ds.GetCommentReplies(pid)
	if !ok {
		return sendNotFound(c)
	}
	// replies are always sorted oldest
	pos := findIDPosition(b, replyID, "oldest")
	if pos < 0 {
		return sendNotFound(c)
	}
	return sendJSON(c, fiber.Map{"offset": pos})
}

func handleBannedWords(c fiber.Ctx) error {
	if bannedWordsCache == nil {
		return sendNotFound(c)
	}
	return sendJSONBytes(c, bannedWordsCache)
}
