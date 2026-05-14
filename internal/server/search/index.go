package search

import (
	"encoding/json"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// --------------------
// 한글 처리
// --------------------
var cho = [...]string{
	"ㄱ", "ㄲ", "ㄴ", "ㄷ", "ㄸ", "ㄹ", "ㅁ", "ㅂ", "ㅃ",
	"ㅅ", "ㅆ", "ㅇ", "ㅈ", "ㅉ", "ㅊ", "ㅋ", "ㅌ", "ㅍ", "ㅎ",
}

var jung = [...]string{
	"ㅏ", "ㅐ", "ㅑ", "ㅒ", "ㅓ", "ㅔ", "ㅕ", "ㅖ", "ㅗ", "ㅗㅏ", "ㅗㅐ", "ㅗㅣ",
	"ㅛ", "ㅜ", "ㅜㅓ", "ㅜㅔ", "ㅜㅣ", "ㅠ", "ㅡ", "ㅡㅣ", "ㅣ",
}

var jong = [...]string{
	"", "ㄱ", "ㄲ", "ㄱㅅ", "ㄴ", "ㄴㅈ", "ㄴㅎ", "ㄷ", "ㄹ", "ㄹㄱ", "ㄹㅁ", "ㄹㅂ",
	"ㄹㅅ", "ㄹㅌ", "ㄹㅍ", "ㄹㅎ", "ㅁ", "ㅂ", "ㅂㅅ", "ㅅ", "ㅆ", "ㅇ", "ㅈ", "ㅊ",
	"ㅋ", "ㅌ", "ㅍ", "ㅎ",
}

var compatConsonant = map[rune]string{
	'ㄱ': "ㄱ", 'ㄲ': "ㄲ", 'ㄳ': "ㄱㅅ", 'ㄴ': "ㄴ", 'ㄵ': "ㄴㅈ", 'ㄶ': "ㄴㅎ",
	'ㄷ': "ㄷ", 'ㄸ': "ㄸ", 'ㄹ': "ㄹ", 'ㄺ': "ㄹㄱ", 'ㄻ': "ㄹㅁ", 'ㄼ': "ㄹㅂ",
	'ㄽ': "ㄹㅅ", 'ㄾ': "ㄹㅌ", 'ㄿ': "ㄹㅍ", 'ㅀ': "ㄹㅎ", 'ㅁ': "ㅁ", 'ㅂ': "ㅂ",
	'ㅃ': "ㅃ", 'ㅄ': "ㅂㅅ", 'ㅅ': "ㅅ", 'ㅆ': "ㅆ", 'ㅇ': "ㅇ", 'ㅈ': "ㅈ",
	'ㅉ': "ㅉ", 'ㅊ': "ㅊ", 'ㅋ': "ㅋ", 'ㅌ': "ㅌ", 'ㅍ': "ㅍ", 'ㅎ': "ㅎ",
}

var compatVowel = map[rune]string{
	'ㅏ': "ㅏ", 'ㅐ': "ㅐ", 'ㅑ': "ㅑ", 'ㅒ': "ㅒ", 'ㅓ': "ㅓ", 'ㅔ': "ㅔ",
	'ㅕ': "ㅕ", 'ㅖ': "ㅖ", 'ㅗ': "ㅗ", 'ㅘ': "ㅗㅏ", 'ㅙ': "ㅗㅐ", 'ㅚ': "ㅗㅣ",
	'ㅛ': "ㅛ", 'ㅜ': "ㅜ", 'ㅝ': "ㅜㅓ", 'ㅞ': "ㅜㅔ", 'ㅟ': "ㅜㅣ", 'ㅠ': "ㅠ",
	'ㅡ': "ㅡ", 'ㅢ': "ㅡㅣ", 'ㅣ': "ㅣ",
}

func toChosung(s string) string {
	var b strings.Builder

	for _, r := range s {
		if r >= 0xAC00 && r <= 0xD7A3 {
			b.WriteString(cho[(r-0xAC00)/(21*28)])
			continue
		}

		if r >= 'ㄱ' && r <= 'ㅎ' {
			if v, ok := compatConsonant[r]; ok {
				b.WriteString(v)
			} else {
				b.WriteRune(r)
			}
			continue
		}

		if _, ok := compatVowel[r]; ok {
			continue
		}
	}

	return b.String()
}

func toDecomposed(s string) string {
	var b strings.Builder

	for _, r := range s {
		if r >= 0xAC00 && r <= 0xD7A3 {
			offset := r - 0xAC00
			jongIndex := offset % 28
			jungIndex := (offset / 28) % 21
			choIndex := offset / (21 * 28)

			b.WriteString(cho[choIndex])
			b.WriteString(jung[jungIndex])
			b.WriteString(jong[jongIndex])
			continue
		}

		if v, ok := compatConsonant[r]; ok {
			b.WriteString(v)
			continue
		}

		if v, ok := compatVowel[r]; ok {
			b.WriteString(v)
			continue
		}

		b.WriteRune(r)
	}

	return b.String()
}

func isChosungOnly(s string) bool {
	hasChosung := false

	for _, r := range toDecomposed(s) {
		if r == ' ' {
			continue
		}
		if r < 'ㄱ' || r > 'ㅎ' {
			return false
		}
		hasChosung = true
	}

	return hasChosung
}

// --------------------
// 트라이그램
// --------------------

func trigramsOf(s string) map[string]struct{} {
	runes := []rune(s)
	t := make(map[string]struct{}, len(runes))
	for i := 0; i+2 < len(runes); i++ {
		t[string(runes[i:i+3])] = struct{}{}
	}
	return t
}

// Jaccard similarity (pg_trgm 방식)
func similarity(a, b map[string]struct{}) float32 {
	if len(a) == 0 || len(b) == 0 {
		return 0
	}
	intersection := 0
	for k := range a {
		if _, ok := b[k]; ok {
			intersection++
		}
	}
	union := len(a) + len(b) - intersection
	if union == 0 {
		return 0
	}
	return float32(intersection) / float32(union)
}

// --------------------
// 인덱스 엔트리
// --------------------

type entry struct {
	id        int64
	name      string
	nameLower string
	chosung   string // flat, no spaces
	decomp    string
	trigrams  map[string]struct{}
	nTrigrams int

	// filter / sort
	genre        []string
	tags         []string
	medium       string
	directors    []string
	companies    []string
	weekdays     []string
	avgRating    float64
	latestTS     int64
	releaseYear  int32
	reviewCount  int32 // text review count
	evalCount    int32 // count_score from statistics (scores + reviews)
	isAdult      bool
	isOriginal   bool
	isEnding     bool
	isNewRelease bool
}

// --------------------
// Index
// --------------------

type Index struct {
	all      []*entry
	inverted map[string][]*entry // trigram → entries
}

var yearRe = regexp.MustCompile(`(\d{4})년`)

type rawItem struct {
	ID                           int64    `json:"id"`
	Name                         string   `json:"name"`
	Genre                        []string `json:"genre"`
	Tags                         []string `json:"tags"`
	Medium                       string   `json:"medium"`
	AvgRating                    float64  `json:"avg_rating"`
	LatestEpisodeReleaseDatetime *string  `json:"latest_episode_release_datetime"`
	AirYearQuarter               *string  `json:"air_year_quarter"`
	ReleaseWeekdays              []string `json:"release_weekdays"`
	IsAdult                      bool     `json:"is_adult"`
	IsLaftelOriginal             bool     `json:"is_laftel_original"`
	IsEnding                     bool     `json:"is_ending"`
	IsNewRelease                 bool     `json:"is_new_release"`
	Directors                    []struct {
		Name string `json:"name"`
	} `json:"directors"`
	ProductionCompanies []struct {
		Name string `json:"name"`
	} `json:"production_companies"`
	Production *string `json:"production"`
}

var kst = time.FixedZone("KST", 9*60*60)

func parseTS(s string) int64 {
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2000-01-02T03:04:05.999999", "2000-01-02T03:04:05"} {
		if t, err := time.Parse(layout, s); err == nil {
			return t.Unix()
		}
		if t, err := time.ParseInLocation(layout, s, kst); err == nil {
			return t.Unix()
		}
	}
	return 0
}

func Build(items map[int64][]byte, reviewCounts map[int64][]byte, statistics map[int64][]byte) (*Index, error) {
	idx := &Index{
		all:      make([]*entry, 0, len(items)),
		inverted: make(map[string][]*entry),
	}

	for _, raw := range items {
		var item rawItem
		if err := json.Unmarshal(raw, &item); err != nil {
			continue
		}

		decomp := toDecomposed(item.Name)
		var evalCount int32
		if statRaw, ok := statistics[item.ID]; ok {
			var s struct {
				CountScore int32 `json:"count_score"`
			}
			if json.Unmarshal(statRaw, &s) == nil {
				evalCount = s.CountScore
			}
		}

		var reviewCount int32
		if rcRaw, ok := reviewCounts[item.ID]; ok {
			var rc struct {
				Count int32 `json:"count"`
			}
			if json.Unmarshal(rcRaw, &rc) == nil {
				reviewCount = rc.Count
			}
		}

		tg := trigramsOf(decomp)
		e := &entry{
			id:           item.ID,
			name:         item.Name,
			nameLower:    strings.ToLower(item.Name),
			chosung:      strings.ReplaceAll(toChosung(item.Name), " ", ""),
			decomp:       decomp,
			trigrams:     tg,
			nTrigrams:    len(tg),
			genre:        item.Genre,
			tags:         item.Tags,
			medium:       item.Medium,
			weekdays:     item.ReleaseWeekdays,
			avgRating:    item.AvgRating,
			reviewCount:  reviewCount,
			evalCount:    evalCount,
			isAdult:      item.IsAdult,
			isOriginal:   item.IsLaftelOriginal,
			isEnding:     item.IsEnding,
			isNewRelease: item.IsNewRelease,
		}

		if item.LatestEpisodeReleaseDatetime != nil {
			e.latestTS = parseTS(*item.LatestEpisodeReleaseDatetime)
		}
		if item.AirYearQuarter != nil {
			if m := yearRe.FindStringSubmatch(*item.AirYearQuarter); m != nil {
				if y, err := strconv.ParseInt(m[1], 10, 32); err == nil {
					e.releaseYear = int32(y)
				}
			}
		}
		for _, d := range item.Directors {
			if d.Name != "" {
				e.directors = append(e.directors, d.Name)
			}
		}
		for _, c := range item.ProductionCompanies {
			if c.Name != "" {
				e.companies = append(e.companies, c.Name)
			}
		}
		if item.Production != nil && *item.Production != "" {
			e.companies = append(e.companies, *item.Production)
		}

		idx.all = append(idx.all, e)
		for tg := range e.trigrams {
			idx.inverted[tg] = append(idx.inverted[tg], e)
		}
	}

	return idx, nil
}

// --------------------
// 검색
// --------------------

const trigramThreshold = float32(0.3)

// editSim returns a normalized similarity score based on Levenshtein distance
// between two jamo-decomposed strings: 1 - dist/max(len_a, len_b)
func editSim(a, b string) float32 {
	ra, rb := []rune(a), []rune(b)
	la, lb := len(ra), len(rb)
	if la == 0 && lb == 0 {
		return 1
	}
	maxLen := la
	if lb > maxLen {
		maxLen = lb
	}

	prev := make([]int, lb+1)
	curr := make([]int, lb+1)
	for j := range prev {
		prev[j] = j
	}
	for i := 1; i <= la; i++ {
		curr[0] = i
		for j := 1; j <= lb; j++ {
			if ra[i-1] == rb[j-1] {
				curr[j] = prev[j-1]
			} else {
				curr[j] = 1 + min3(prev[j], curr[j-1], prev[j-1])
			}
		}
		prev, curr = curr, prev
	}
	return 1 - float32(prev[lb])/float32(maxLen)
}

func min3(a, b, c int) int {
	if a < b {
		if a < c {
			return a
		}
		return c
	}
	if b < c {
		return b
	}
	return c
}

// scoreEntry mirrors the SQL ORDER BY:
//
//	ORDER BY (name = q) DESC, (name ILIKE q%) DESC, similarity(decomposed, qDecomp) DESC, id DESC
//
// tier 30 = exact, 20 = prefix, 10 = contains/chosung, 0..1 = fuzzy (trigram or edit distance)
// similarity는 모든 매치에 더해져 같은 tier 안에서 차별화됨
// 0 = 매치 없음
type hit struct {
	e     *entry
	score float32
}

// --------------------
// Query / Result
// --------------------

type Query struct {
	Q             string
	Genres        []string
	ExcludeGenres []string
	Tags          []string
	ExcludeTags   []string
	Medium        string
	Year          string // "2024", "2000..2024", "2010년대", "2000년대 이전"
	Weekday       string
	Adult         *bool
	Original      *bool
	Ending        *bool
	Sort          string // recent, rank, update, cnt_eval, avg_rating
	Offset        int
	Size          int
}

type Result struct {
	Found int
	IDs   []int64
}

func (idx *Index) Search(q Query) Result {
	if q.Size < 1 {
		q.Size = 24
	}

	qTrimmed := strings.TrimSpace(q.Q)

	var hits []hit

	if qTrimmed == "" {
		// 쿼리 없음: 필터만 적용
		hits = make([]hit, 0, len(idx.all))
		for _, e := range idx.all {
			if matchesFilter(e, q) {
				hits = append(hits, hit{e: e})
			}
		}
	} else if isChosungOnly(qTrimmed) {
		qFlat := strings.ReplaceAll(toDecomposed(qTrimmed), " ", "")
		hits = make([]hit, 0, 64)
		for _, e := range idx.all {
			if strings.Contains(e.chosung, qFlat) && matchesFilter(e, q) {
				hits = append(hits, hit{e: e, score: 1})
			}
		}
	} else {
		qLower := strings.ToLower(qTrimmed)
		qTokens := strings.Fields(qLower)
		qPure := strings.ReplaceAll(qTrimmed, " ", "")
		qChosung := toChosung(qPure)
		qDecomp := toDecomposed(qPure)
		qTrigrams := trigramsOf(qDecomp)
		nQT := len(qTrigrams)

		matched := make(map[*entry]struct{}, 256)
		hits = make([]hit, 0, 256)

		// 1차: 문자열 직접 매칭 (SIMD strings.Contains)
		for _, e := range idx.all {
			nameContains := strings.Contains(e.nameLower, qLower)
			chosungMatch := qChosung != "" && strings.Contains(e.chosung, qChosung)
			tokenMatch := false
			if !nameContains && len(qTokens) > 1 {
				tokenMatch = true
				for _, t := range qTokens {
					if !strings.Contains(e.nameLower, t) {
						tokenMatch = false
						break
					}
				}
			}
			if !nameContains && !chosungMatch && !tokenMatch {
				continue
			}
			matched[e] = struct{}{}
			if !matchesFilter(e, q) {
				continue
			}
			sim := similarity(qTrigrams, e.trigrams)
			var score float32
			switch {
			case e.nameLower == qLower:
				score = 30 + sim
			case strings.HasPrefix(e.nameLower, qLower):
				score = 20 + sim
			case tokenMatch:
				score = 15 + sim
			default:
				score = 10 + sim
			}
			hits = append(hits, hit{e: e, score: score})
		}

		// 2차: 역색인으로 퍼지 매칭 — 전체 스캔 없음
		if nQT > 0 {
			trigramIntersect := make(map[*entry]int, 128)
			for tg := range qTrigrams {
				for _, e := range idx.inverted[tg] {
					trigramIntersect[e]++
				}
			}
			for e, intersect := range trigramIntersect {
				if _, ok := matched[e]; ok {
					continue
				}
				union := nQT + e.nTrigrams - intersect
				var sim float32
				if union > 0 {
					sim = float32(intersect) / float32(union)
				}
				if sim < trigramThreshold {
					// 트라이그램 겹침이 있지만 임계값 미달: 편집 거리로 보완
					sim = editSim(qDecomp, e.decomp)
					if sim < 0.5 {
						matched[e] = struct{}{}
						continue
					}
				}
				matched[e] = struct{}{}
				if !matchesFilter(e, q) {
					continue
				}
				hits = append(hits, hit{e: e, score: sim})
			}
		}
	}

	sortHits(hits, q.Sort, qTrimmed != "")

	total := len(hits)
	start := q.Offset
	if start < 0 {
		start = 0
	}
	if start > total {
		start = total
	}
	size := q.Size
	if size < 0 {
		size = 0
	}
	end := start + size
	if end > total || end < 0 {
		end = total
	}

	ids := make([]int64, end-start)
	for i, h := range hits[start:end] {
		ids[i] = h.e.id
	}

	return Result{Found: total, IDs: ids}
}

func matchesFilter(e *entry, q Query) bool {
	if len(q.Genres) > 0 && !anyContains(e.genre, q.Genres) {
		return false
	}
	if len(q.ExcludeGenres) > 0 && anyContains(e.genre, q.ExcludeGenres) {
		return false
	}
	if len(q.Tags) > 0 && !anyContains(e.tags, q.Tags) {
		return false
	}
	if len(q.ExcludeTags) > 0 && anyContains(e.tags, q.ExcludeTags) {
		return false
	}
	if q.Medium != "" && e.medium != q.Medium {
		return false
	}
	if q.Year != "" && !matchYear(e.releaseYear, q.Year) {
		return false
	}
	if q.Weekday != "" && !containsStr(e.weekdays, q.Weekday) {
		return false
	}
	if q.Adult != nil && e.isAdult != *q.Adult {
		return false
	}
	if q.Original != nil && e.isOriginal != *q.Original {
		return false
	}
	if q.Ending != nil && e.isEnding != *q.Ending {
		return false
	}
	return true
}

func anyContains(slice, targets []string) bool {
	for _, t := range targets {
		for _, s := range slice {
			if s == t {
				return true
			}
		}
	}
	return false
}

func containsStr(slice []string, s string) bool {
	for _, v := range slice {
		if v == s {
			return true
		}
	}
	return false
}

// matchYear supports: "2024", "2000..2024", "2010년대", "2000년대 이전", "2020년대 이후"
func matchYear(y int32, filter string) bool {
	if strings.HasSuffix(filter, "년대 이전") {
		decade, err := strconv.Atoi(strings.TrimSuffix(filter, "년대 이전"))
		if err != nil {
			return false
		}
		return int(y) < decade
	}
	if strings.HasSuffix(filter, "년대 이후") {
		decade, err := strconv.Atoi(strings.TrimSuffix(filter, "년대 이후"))
		if err != nil {
			return false
		}
		return int(y) >= decade
	}
	if strings.HasSuffix(filter, "년대") {
		decade, err := strconv.Atoi(strings.TrimSuffix(filter, "년대"))
		if err != nil {
			return false
		}
		return int(y) >= decade && int(y) < decade+10
	}
	if strings.Contains(filter, "..") {
		parts := strings.SplitN(filter, "..", 2)
		lo, _ := strconv.Atoi(parts[0])
		hi, _ := strconv.Atoi(parts[1])
		return int(y) >= lo && int(y) <= hi
	}
	v, _ := strconv.Atoi(filter)
	return int(y) == v
}

func sortHits(hits []hit, sortKey string, hasQuery bool) {
	sort.SliceStable(hits, func(i, j int) bool {
		a, b := &hits[i], &hits[j]

		if hasQuery {
			if a.score != b.score {
				return a.score > b.score
			}
			return a.e.id > b.e.id
		}

		switch sortKey {
		case "update":
			return a.e.latestTS > b.e.latestTS
		case "recent":
			if a.e.releaseYear != b.e.releaseYear {
				return a.e.releaseYear > b.e.releaseYear
			}
			return a.e.latestTS > b.e.latestTS
		case "cnt_eval":
			// sort by score count (from statistics); tie-break by id
			if a.e.evalCount != b.e.evalCount {
				return a.e.evalCount > b.e.evalCount
			}
			return a.e.id > b.e.id
		case "avg_rating":
			if a.e.avgRating != b.e.avgRating {
				return a.e.avgRating > b.e.avgRating
			}
			return a.e.evalCount > b.e.evalCount
		default: // "rank"
			// popularity: evalCount primary, avgRating secondary
			if a.e.evalCount != b.e.evalCount {
				return a.e.evalCount > b.e.evalCount
			}
			if a.e.avgRating != b.e.avgRating {
				return a.e.avgRating > b.e.avgRating
			}
			return a.e.id > b.e.id
		}
	})
}

// --------------------
// Autocomplete
// --------------------

func (idx *Index) Autocomplete(q string, limit int) []string {
	q = strings.TrimSpace(q)
	if q == "" {
		return []string{}
	}

	type scored struct {
		name  string
		score int
	}
	results := make([]scored, 0, limit*2)

	if isChosungOnly(q) {
		qFlat := strings.ReplaceAll(toDecomposed(q), " ", "")
		for _, e := range idx.all {
			if strings.Contains(e.chosung, qFlat) {
				s := 1
				if strings.HasPrefix(e.chosung, qFlat) {
					s = 2
				}
				results = append(results, scored{e.name, s})
			}
		}
	} else {
		qLower := strings.ToLower(q)
		qTokens := strings.Fields(qLower)
		qPure := strings.ReplaceAll(q, " ", "")
		qChosung := toChosung(qPure)
		qDecomp := toDecomposed(qPure)
		qTrigrams := trigramsOf(qDecomp)
		nQT := len(qTrigrams)

		seen := make(map[int64]struct{}, limit*4)
		// 단일 패스: prefix와 contains를 동시에 처리
		// decomp prefix: IME 조합 중간 상태 처리
		//   예) 입력 '맛' → qDecomp='ㅁㅏㅅ', '마슐' decomp='ㅁㅏㅅㅠㄹ' → prefix match
		for _, e := range idx.all {
			if strings.HasPrefix(e.nameLower, qLower) {
				seen[e.id] = struct{}{}
				results = append(results, scored{e.name, 3})
			} else if strings.HasPrefix(e.decomp, qDecomp) {
				// decomposed prefix: 음절 조합 중간 상태에서도 prefix로 인식
				seen[e.id] = struct{}{}
				results = append(results, scored{e.name, 3})
			} else if qChosung != "" && strings.Contains(e.chosung, qChosung) {
				seen[e.id] = struct{}{}
				results = append(results, scored{e.name, 2})
			} else if strings.Contains(e.nameLower, qLower) {
				seen[e.id] = struct{}{}
				results = append(results, scored{e.name, 2})
			} else if strings.Contains(e.decomp, qDecomp) {
				// decomposed contains: 중간에 포함되는 경우
				seen[e.id] = struct{}{}
				results = append(results, scored{e.name, 2})
			} else if len(qTokens) > 1 {
				tokenMatch := true
				for _, t := range qTokens {
					if !strings.Contains(e.nameLower, t) {
						tokenMatch = false
						break
					}
				}
				if tokenMatch {
					seen[e.id] = struct{}{}
					results = append(results, scored{e.name, 2})
				}
			}
		}
		// 역색인으로 퍼지 매칭 — 교집합 카운트로 Jaccard 직접 계산
		if nQT > 0 {
			trigramIntersect := make(map[*entry]int, 64)
			for tg := range qTrigrams {
				for _, e := range idx.inverted[tg] {
					if _, ok := seen[e.id]; !ok {
						trigramIntersect[e]++
					}
				}
			}
			for e, intersect := range trigramIntersect {
				if _, ok := seen[e.id]; ok {
					continue
				}
				union := nQT + e.nTrigrams - intersect
				sim := float32(0)
				if union > 0 {
					sim = float32(intersect) / float32(union)
				}
				if sim < trigramThreshold {
					sim = editSim(qDecomp, e.decomp)
				}
				if sim >= 0.5 {
					seen[e.id] = struct{}{}
					results = append(results, scored{e.name, 1})
				}
			}
		}
	}

	sort.SliceStable(results, func(i, j int) bool {
		return results[i].score > results[j].score
	})

	names := make([]string, 0, limit)
	for _, r := range results {
		if len(names) >= limit {
			break
		}
		names = append(names, r.name)
	}
	return names
}

// EndingItemIDs returns the set of item IDs where is_ending == true.
// Used by DiskSource to avoid re-reading item files after index build.
func (idx *Index) EndingItemIDs() map[int64]struct{} {
	m := make(map[int64]struct{}, len(idx.all)/4)
	for _, e := range idx.all {
		if e.isEnding {
			m[e.id] = struct{}{}
		}
	}
	return m
}
