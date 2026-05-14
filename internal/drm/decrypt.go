package drm

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
)

const licenseURL = "https://license.pallycon.com/ri/licenseManager.do"

type keyEntry struct {
	KeyID string `json:"key_id"`
	Key   string `json:"key"`
}

func (c *Client) requestKeys(pssh, drmToken string) ([]keyEntry, error) {
	payload, _ := json.Marshal(map[string]any{
		"pssh":   pssh,
		"licurl": licenseURL,
		"headers": map[string]string{
			"pallycon-customdata-v2": drmToken,
			"User-Agent":             "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
			"Origin":                 "https://laftel.net",
			"Referer":                "https://laftel.net/",
		},
	})
	resp, err := c.http.Post(c.cfg.DecryptServer, "application/json", bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	var result struct {
		Status  string     `json:"status"`
		Message []keyEntry `json:"message"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, err
	}
	if result.Status != "success" {
		return nil, fmt.Errorf("decrypt server returned failure")
	}
	return result.Message, nil
}

func newJSONRequest(method, url string, body []byte, token string) (*http.Request, error) {
	req, err := http.NewRequest(method, url, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "Mozilla/5.0 (Not Googlebot)")
	if token != "" {
		req.Header.Set("Authorization", "Token "+token)
	}
	return req, nil
}
