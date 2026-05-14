// Package lafutil provides shared HTTP / file utilities for lafdb tools.
package lafutil

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const UserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; Not Googlebot)"

// ── HTTP ──────────────────────────────────────────────────────────────────────

func NewDirectClient() *http.Client {
	return &http.Client{
		Timeout: 30 * time.Second,
		Transport: &http.Transport{
			MaxIdleConnsPerHost: 16,
			IdleConnTimeout:     90 * time.Second,
			DisableCompression:  true,
		},
	}
}

func NewProxyClient(proxyURL string) (*http.Client, error) {
	u, err := url.Parse(proxyURL)
	if err != nil {
		return nil, err
	}
	return &http.Client{
		Timeout:   30 * time.Second,
		Transport: &http.Transport{Proxy: http.ProxyURL(u)},
	}, nil
}

func Get(client *http.Client, rawURL string, headers map[string]string) ([]byte, int, error) {
	req, err := http.NewRequest("GET", rawURL, nil)
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("User-Agent", UserAgent)
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	return body, resp.StatusCode, err
}

// ── Proxy file ────────────────────────────────────────────────────────────────

type ProxyEntry struct {
	Raw    string
	Client *http.Client
}

func LoadProxies(path string) ([]ProxyEntry, error) {
	f, err := os.Open(filepath.Clean(path))
	if err != nil {
		return nil, err
	}
	defer f.Close()

	var out []ProxyEntry
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		parts := strings.SplitN(line, ":", 4)
		if len(parts) != 4 {
			continue
		}
		rawURL := fmt.Sprintf("http://%s:%s@%s:%s", parts[2], parts[3], parts[0], parts[1])
		c, err := NewProxyClient(rawURL)
		if err != nil {
			continue
		}
		out = append(out, ProxyEntry{Raw: rawURL, Client: c})
	}
	return out, sc.Err()
}

// ── File I/O ──────────────────────────────────────────────────────────────────

func WriteFile(path string, data []byte) error {
	cleanPath := filepath.Clean(path)
	dir := filepath.Dir(cleanPath)

	resolvedDir := dir
	for probe := dir; ; probe = filepath.Dir(probe) {
		if probe == "." || probe == "/" || probe == "" {
			break
		}
		if st, err := os.Stat(probe); err == nil && st.IsDir() {
			if realBase, err := filepath.EvalSymlinks(probe); err == nil {
				rel, err := filepath.Rel(probe, dir)
				if err == nil {
					resolvedDir = filepath.Join(realBase, rel)
				} else {
					resolvedDir = realBase
				}
			}
			break
		}
		parent := filepath.Dir(probe)
		if parent == probe {
			break
		}
	}

	if err := os.MkdirAll(resolvedDir, 0750); err != nil {
		return err
	}

	finalPath := filepath.Join(resolvedDir, filepath.Base(cleanPath))

	tmpFile, err := os.CreateTemp(resolvedDir, "."+filepath.Base(cleanPath)+".*.tmp")
	if err != nil {
		return err
	}
	tmpPath := tmpFile.Name()

	if _, err := tmpFile.Write(data); err != nil {
		_ = tmpFile.Close()
		_ = os.Remove(tmpPath)
		return err
	}
	if err := tmpFile.Chmod(0644); err != nil {
		_ = tmpFile.Close()
		_ = os.Remove(tmpPath)
		return err
	}
	if err := tmpFile.Sync(); err != nil {
		_ = tmpFile.Close()
		_ = os.Remove(tmpPath)
		return err
	}
	if err := tmpFile.Close(); err != nil {
		_ = os.Remove(tmpPath)
		return err
	}
	if err := os.Rename(tmpPath, finalPath); err != nil {
		_ = os.Remove(tmpPath)
		return err
	}
	if dirHandle, err := os.Open(resolvedDir); err == nil {
		_ = dirHandle.Sync()
		_ = dirHandle.Close()
	}
	return nil
}

func FileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func FileFresh(path string, maxAge time.Duration) bool {
	st, err := os.Stat(path)
	if err != nil {
		return false
	}
	if st.IsDir() {
		return false
	}
	return time.Since(st.ModTime()) <= maxAge
}

func PrettyJSON(b []byte) []byte {
	var v any
	if json.Unmarshal(b, &v) != nil {
		return b
	}
	out, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return b
	}
	return out
}
