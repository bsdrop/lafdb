// Package drm fetches Widevine keys for Laftel episodes via a local CDM server.
package drm

import (
	"net/http"
	"sync/atomic"
	"time"

	"github.com/bsdrop/lafdb/internal/lafutil"
)

type Config struct {
	Token         string
	DecryptServer string // http://127.0.0.1:3040/api/decrypt
	EpisodeDir    string // ./laftel/episodes/v3
	KeyDir        string // ./laftel/mediacloud/keys
	MediacloudDir string // ./laftel/mediacloud
	SleepMs       int
}

type Client struct {
	cfg      Config
	http     *http.Client
	stopping atomic.Bool
}

func New(cfg Config) *Client {
	return &Client{
		cfg: cfg,
		http: &http.Client{
			Timeout: 30 * time.Second,
			Transport: &http.Transport{
				MaxIdleConnsPerHost: 4,
				IdleConnTimeout:     60 * time.Second,
			},
		},
	}
}

func (c *Client) Stop() { c.stopping.Store(true) }

func (c *Client) get(url string, auth bool) ([]byte, int, error) {
	headers := map[string]string{}
	if auth && c.cfg.Token != "" {
		headers["Authorization"] = "Token " + c.cfg.Token
	}
	return lafutil.Get(c.http, url, headers)
}
