package http

import (
	"io"
	"log"
	"net/http"
	"os"
	"time"
)

const bannedWordsFile = "./laftel/banned_words.json"
const bannedWordsURL = "https://api.laftel.net/api/users/v1/banned_words/"

var bannedWordsCache []byte

func initBannedWords() {
	now := time.Now()

	var fileExists bool
	fi, statErr := os.Stat(bannedWordsFile)
	if statErr == nil {
		fileExists = true
		mod := fi.ModTime()
		if mod.Year() == now.Year() && mod.Month() == now.Month() {
			data, err := os.ReadFile(bannedWordsFile)
			if err == nil {
				bannedWordsCache = data
				return
			}
		}
	}

	// Month mismatch or file missing — try to fetch fresh data
	if data := fetchBannedWords(); data != nil {
		bannedWordsCache = data
		if err := os.WriteFile(bannedWordsFile, data, 0644); err != nil {
			log.Printf("banned_words: save failed: %v", err)
		}
		return
	}

	// Fetch failed — fall back to stale file
	if fileExists {
		data, err := os.ReadFile(bannedWordsFile)
		if err == nil {
			log.Printf("banned_words: fetch failed, using stale cache")
			bannedWordsCache = data
			return
		}
	}

	log.Printf("banned_words: no data available")
}

func fetchBannedWords() []byte {
	resp, err := http.Get(bannedWordsURL)
	if err != nil {
		log.Printf("banned_words: fetch error: %v", err)
		return nil
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		log.Printf("banned_words: upstream %d", resp.StatusCode)
		return nil
	}

	data, err := io.ReadAll(resp.Body)
	if err != nil {
		log.Printf("banned_words: read error: %v", err)
		return nil
	}
	return data
}
