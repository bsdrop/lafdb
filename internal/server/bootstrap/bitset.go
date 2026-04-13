package bootstrap

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	cachepkg "github.com/bsdrop/lafdb/internal/server/cache"
)

type bitsetData struct {
	min, max int64
	buf      []uint32
}

func makeBitset(ids map[int64]struct{}) *bitsetData {
	if len(ids) == 0 {
		return nil
	}
	var minID, maxID int64 = 1 << 62, -1 << 62
	for id := range ids {
		if id < minID {
			minID = id
		}
		if id > maxID {
			maxID = id
		}
	}
	size := (maxID-minID)/32 + 1
	buf := make([]uint32, size)
	for id := range ids {
		off := id - minID
		buf[off>>5] |= 1 << (off & 31)
	}
	return &bitsetData{min: minID, max: maxID, buf: buf}
}

func fmtUint32Array(buf []uint32) string {
	if len(buf) == 0 {
		return ""
	}
	const perLine = 16
	lines := make([]string, 0, (len(buf)+perLine-1)/perLine)
	for i := 0; i < len(buf); i += perLine {
		end := i + perLine
		if end > len(buf) {
			end = len(buf)
		}
		parts := make([]string, 0, end-i)
		for _, n := range buf[i:end] {
			dec := strconv.FormatUint(uint64(n), 10)
			hex := "0x" + strconv.FormatUint(uint64(n), 16)
			if len(hex) < len(dec) {
				parts = append(parts, hex)
			} else {
				parts = append(parts, dec)
			}
		}
		lines = append(lines, "  "+strings.Join(parts, ", "))
	}
	return "\n" + strings.Join(lines, ",\n") + "\n"
}

func bitsetTS(name string, b *bitsetData) string {
	varBuf := "bitsetBuf" + name
	varMin := "MIN_" + strings.ToUpper(name) + "_ID"
	varMax := "MAX_" + strings.ToUpper(name) + "_ID"
	fnHas := "has" + name
	fnExport := "isAccessible" + name

	return fmt.Sprintf(`const %s: number = %d;
const %s: number = %d;
const %s: Uint32Array = new Uint32Array([%s]);
function %s(id: number): boolean {
  if (id < %s || id > %s) return false;
  const o = id - %s;
  return (%s[o >>> 5] & (1 << (o & 31))) !== 0;
}
window.%s = %s;
`,
		varMin, b.min,
		varMax, b.max,
		varBuf, fmtUint32Array(b.buf),
		fnHas, varMin, varMax, varMin, varBuf,
		fnExport, fnHas,
	)
}

// GenerateAccessibleBitset scans mediacloud/keys/ and episodes/v3/list/
// to build bitsets of items and episodes with DRM keys, then writes
// src/accessible.ts so the frontend can check access without a round-trip.
func GenerateAccessibleBitset(root, outPath string) {
	keysDir := filepath.Clean(filepath.Join(root, "mediacloud/keys"))
	listDir := filepath.Clean(filepath.Join(root, "episodes/v3/list"))

	// 1. valid episode IDs = those with a key file
	validEps := make(map[int64]struct{}, 65536)
	if err := cachepkg.WalkFilesProgress("bitset/keys", keysDir, func(path string, d fs.DirEntry) bool {
		return filepath.Ext(path) == ".json"
	}, func(path string) error {
		id, err := strconv.ParseInt(strings.TrimSuffix(filepath.Base(path), ".json"), 10, 64)
		if err == nil {
			validEps[id] = struct{}{}
		}
		return nil
	}); err != nil {
		log.Printf("bitset: keys dir: %v", err)
		return
	}
	log.Printf("bitset: %d key files", len(validEps))

	// 2. valid item IDs = items where ≥1 episode has a key
	validItems := make(map[int64]struct{}, 8192)
	if err := cachepkg.WalkFilesProgress("bitset/lists", listDir, func(path string, d fs.DirEntry) bool {
		return filepath.Ext(path) == ".json"
	}, func(path string) error {
		itemID, err := strconv.ParseInt(strings.TrimSuffix(filepath.Base(path), ".json"), 10, 64)
		if err != nil {
			return nil
		}
		data, err := os.ReadFile(filepath.Clean(path))
		if err != nil {
			return nil
		}
		var page struct {
			Results []struct {
				ID int64 `json:"id"`
			} `json:"results"`
		}
		if json.Unmarshal(data, &page) != nil {
			return nil
		}
		for _, ep := range page.Results {
			if _, ok := validEps[ep.ID]; ok {
				validItems[itemID] = struct{}{}
				break
			}
		}
		return nil
	}); err != nil {
		log.Printf("bitset: episode list dir: %v", err)
		return
	}
	log.Printf("bitset: %d accessible items, %d accessible episodes", len(validItems), len(validEps))

	// 3. build bitsets
	itemBS := makeBitset(validItems)
	epBS := makeBitset(validEps)
	if itemBS == nil || epBS == nil {
		log.Printf("bitset: no data, skipping")
		return
	}

	// 4. write TS
	fmt.Printf("\rbitset/write: 0/1 (0.0%%)    ")
	out := `export {};

declare global {
  interface Window {
    isAccessibleItem: (id: number) => boolean;
    isAccessibleEpisode: (id: number) => boolean;
  }
}

` + bitsetTS("Item", itemBS) + "\n" + bitsetTS("Episode", epBS)
	if err := os.WriteFile(filepath.Clean(outPath), []byte(out), 0644); err != nil {
		fmt.Println()
		log.Printf("bitset: write %s: %v", outPath, err)
		return
	}
	fmt.Printf("\rbitset/write: 1/1 (100.0%%)    \n")
	log.Printf("bitset: wrote %s (items %d–%d, episodes %d–%d)",
		outPath, itemBS.min, itemBS.max, epBS.min, epBS.max)
}
