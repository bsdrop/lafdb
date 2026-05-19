package media

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/gofiber/fiber/v3"
)

func TestDispatchByHost_MediacloudEng2ChInitMP4(t *testing.T) {
	tmp := t.TempDir()
	relPath := "2026/05/107398/v30/b7448c727f1d/video/dash/audio/mp4a/eng_2ch/init.mp4"
	localPath := filepath.Join(tmp, filepath.FromSlash(relPath))
	if err := os.MkdirAll(filepath.Dir(localPath), 0750); err != nil {
		t.Fatal(err)
	}
	wantBody := []byte("test-init")
	if err := os.WriteFile(localPath, wantBody, 0644); err != nil {
		t.Fatal(err)
	}

	app := fiber.New()
	app.Use(func(c fiber.Ctx) error {
		if handled, err := DispatchByHost(c); handled {
			return err
		}
		return c.SendStatus(fiber.StatusNotFound)
	})

	orig := mediaCfgs["mediacloud"]
	mediaCfgs["mediacloud"] = mediaCfg{
		localDir:   tmp,
		sourceHost: orig.sourceHost,
	}
	t.Cleanup(func() {
		mediaCfgs["mediacloud"] = orig
	})

	req := httptest.NewRequest(http.MethodGet, "https://mediacloud.latfel.net/"+relPath, nil)
	req.Host = "mediacloud.latfel.net"
	resp, err := app.Test(req, fiber.TestConfig{Timeout: 0})
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("status = %d, want %d; body=%q", resp.StatusCode, http.StatusOK, string(body))
	}
	if got := resp.Header.Get("Content-Type"); got != "video/mp4" {
		t.Fatalf("Content-Type = %q, want %q", got, "video/mp4")
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != string(wantBody) {
		t.Fatalf("body = %q, want %q", string(body), string(wantBody))
	}
}
