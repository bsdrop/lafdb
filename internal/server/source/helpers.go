package source

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

func normalizeString(s string) string {
	s = strings.ReplaceAll(s, "\r\n", "\n")
	s = strings.ReplaceAll(s, ".laftel.net", ".latfel.net")
	return s
}

func normalizeJSONValue(v any, parentKey string) any {
	switch x := v.(type) {
	case map[string]any:
		for k, vv := range x {
			if k == "hls_url" && parentKey != "highlight_video" {
				delete(x, k)
				continue
			}
			x[k] = normalizeJSONValue(vv, k)
		}
		return x
	case []any:
		for i, vv := range x {
			x[i] = normalizeJSONValue(vv, parentKey)
		}
		return x
	case string:
		return normalizeString(x)
	default:
		return x
	}
}

func normalizeJSONBytes(raw []byte) []byte {
	if bytes.Contains(raw, []byte("\r\n")) {
		raw = bytes.ReplaceAll(raw, []byte("\r\n"), []byte("\n"))
	}
	if bytes.Contains(raw, []byte(".laftel.net")) {
		raw = bytes.ReplaceAll(raw, []byte(".laftel.net"), []byte(".latfel.net"))
	}
	return raw
}

func loadAndNormalizeJSON(path string) ([]byte, any, error) {
	raw, err := os.ReadFile(filepath.Clean(path))
	if err != nil {
		return nil, nil, err
	}
	raw = normalizeJSONBytes(raw)
	if !bytes.Contains(raw, []byte(`"hls_url"`)) {
		var compact bytes.Buffer
		compact.Grow(len(raw))
		if err := json.Compact(&compact, raw); err != nil {
			return nil, nil, fmt.Errorf("compact %s: %w", path, err)
		}
		return compact.Bytes(), nil, nil
	}
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		return nil, nil, fmt.Errorf("unmarshal %s: %w", path, err)
	}
	v = normalizeJSONValue(v, "")
	b, err := json.Marshal(v)
	if err != nil {
		return nil, nil, fmt.Errorf("marshal %s: %w", path, err)
	}
	return b, v, nil
}

func FileIDFromPath(path string) (int64, error) {
	base := filepath.Base(path)
	name := strings.TrimSuffix(base, filepath.Ext(base))
	return strconv.ParseInt(name, 10, 64)
}

func resolveWalkRoot(root string) (string, error) {
	cleanRoot := filepath.Clean(root)
	resolved, err := filepath.EvalSymlinks(cleanRoot)
	if err != nil {
		if os.IsNotExist(err) {
			return cleanRoot, err
		}
		log.Printf("walk: resolve symlink %s failed, using original path: %v", cleanRoot, err)
		return cleanRoot, nil
	}
	if resolved != cleanRoot {
		log.Printf("walk: resolved %s -> %s", cleanRoot, resolved)
	}
	return resolved, nil
}
