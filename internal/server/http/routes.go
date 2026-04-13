package http

import "github.com/gofiber/fiber/v3"

func RegisterAPIRoutes(api fiber.Router, app *App) {
	api.Get("/episodes/v3/list", app.handleEpisodeList)
	api.Get("/episodes/v3/:episodeId/video", app.handleEpisodeVideo)
	api.Get("/episodes/v3/:episodeId/video/", app.handleEpisodeVideo)
	api.Get("/episodes/v3/:episodeId", app.handleEpisodeDetail)

	api.Get("/items/v4/:id", app.handleItem)
	api.Get("/items/v2/series/:id", app.handleSeries)
	api.Get("/items/v1/:id/statistics", app.handleStatistics)
	api.Get("/items/v1/:id/statistics/", app.handleStatistics)

	api.Get("/episode/:episodeId/item", app.handleEpisodeToItem)
	api.Get("/episode/:episodeId/episodes", app.handleEpisodeToEpisodes)

	api.Get("/reviews/v1/count", app.handleReviewCount)
	api.Get("/reviews/v2/list", app.handleReviewList)
	api.Get("/reviews/v2/position", app.handleReviewPosition)

	api.Get("/comments/v1/count", app.handleCommentCount)
	api.Get("/comments/v1/list", app.handleCommentList)
	api.Get("/comments/v1/position", app.handleCommentPosition)
	api.Get("/comments/v1/reply-position", app.handleReplyPosition)

	api.Get("/users/v1/banned_words", handleBannedWords)
	api.Get("/users/v1/banned_words/", handleBannedWords)

	api.Get("/autocomplete", handleAutocomplete(app))
	api.Get("/search/v1/auto_complete", handleAutocomplete(app))
	api.Get("/search/v1/auto_complete/", handleAutocomplete(app))
	api.Get("/search/v3/keyword", handleKeyword(app))
	api.Get("/search/v3/keyword/", handleKeyword(app))
	api.Get("/search/v1/discover", handleDiscover(app))
	api.Get("/search/v1/discover/", handleDiscover(app))
}

func RegisterShareRoutes(srv *fiber.App, app *App) {
	srv.Get("/player/:episodeId", app.handlePlayerShare)
	srv.Get("/item/:id", app.handleItemShare)
	srv.Get("/comment/:commentId", app.handleCommentShare)
	srv.Get("/review/:reviewId", app.handleReviewShare)
	srv.Get("/sitemap.xml", app.handleSitemap)
	srv.Get("/robots.txt", app.handleRobots)
}
