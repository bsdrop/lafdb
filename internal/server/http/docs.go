package http

import (
	"os"

	"github.com/gofiber/fiber/v3"
)

func loadOpenAPISpec(path string) string {
	if b, err := os.ReadFile(path); err == nil {
		return string(b)
	}
	return openAPISpecFallback
}

const openAPISpecFallback = `{"openapi": "3.0.3","info":{"title":"Error occured.","version":"1.0.0","description":""}}`

const docsHTML = `<!doctype html>
<html><head><title>lafdb API</title><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /></head><body><script id="api-reference" data-url="/docs/openapi.json"></script><script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script></body></html>`

func RegisterDocsRoutes(srv *fiber.App, openAPIPath string) {
	srv.Get("/docs", func(c fiber.Ctx) error {
		c.Set(fiber.HeaderContentType, "text/html; charset=utf-8")
		return c.SendString(docsHTML)
	})
	srv.Get("/docs/openapi.json", func(c fiber.Ctx) error {
		c.Set(fiber.HeaderContentType, fiber.MIMEApplicationJSONCharsetUTF8)
		return c.SendString(loadOpenAPISpec(openAPIPath))
	})
}
