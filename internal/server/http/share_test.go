package http

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSelectEpisodeThumbnailAtTimeUsesContinuousFramesStartingAtZero(t *testing.T) {
	tmp := t.TempDir()
	oldDataDir := dataDir
	dataDir = tmp
	t.Cleanup(func() { dataDir = oldDataDir })

	thumbDir := filepath.Join(tmp, "thumbnail", "assets", "2026", "03", "105206", "v30", "476fa43bd332")
	if err := os.MkdirAll(thumbDir, 0750); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{
		"Thumbnail.0000000.jpg",
		"Thumbnail.0000001.jpg",
		"Thumbnail.0000002.jpg",
		"Thumbnail.0000003.jpg",
		"Thumbnail.9999999.jpg",
	} {
		if err := os.WriteFile(filepath.Join(thumbDir, name), []byte(name), 0644); err != nil {
			t.Fatal(err)
		}
	}

	got := selectEpisodeThumbnailAtTime(
		"https://thumbnail.laftel.net/assets/2026/03/105206/v30/476fa43bd332/Thumbnail.9999999.jpg",
		"00:01:00",
		15,
	)
	want := "https://thumbnail.laftel.net/assets/2026/03/105206/v30/476fa43bd332/Thumbnail.0000001.jpg"
	if got != want {
		t.Fatalf("selectEpisodeThumbnailAtTime() = %q, want %q", got, want)
	}
}

func TestSelectEpisodeThumbnailAtTimeIgnoresCustomOnlyFrame(t *testing.T) {
	tmp := t.TempDir()
	oldDataDir := dataDir
	dataDir = tmp
	t.Cleanup(func() { dataDir = oldDataDir })

	thumbDir := filepath.Join(tmp, "thumbnail", "assets", "2026", "03", "105206", "v30", "476fa43bd332")
	if err := os.MkdirAll(thumbDir, 0750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(thumbDir, "Thumbnail.9999999.jpg"), []byte("custom"), 0644); err != nil {
		t.Fatal(err)
	}

	original := "https://thumbnail.laftel.net/assets/2026/03/105206/v30/476fa43bd332/Thumbnail.9999999.jpg"
	got := selectEpisodeThumbnailAtTime(original, "00:01:00", 15)
	if got != original {
		t.Fatalf("selectEpisodeThumbnailAtTime() = %q, want original %q", got, original)
	}
}
