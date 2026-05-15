package bootstrap

import (
	"encoding/json"
	"log"
	"os"
	"regexp"
	"sort"
	"strings"

	cachepkg "github.com/bsdrop/lafdb/internal/server/cache"
)

const generatedOpenAPIPath = "./laftel/openapi.json"
const GeneratedOpenAPIPath = generatedOpenAPIPath

var isoDateTimeLike = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$`)

// Type inference (quicktype-style)

// inferFromValues infers a single JSON Schema from a slice of observed values
// for one field. Handles nullable detection by checking for nils in the slice.
func inferFromValues(vals []interface{}) interface{} {
	hasNull := false
	var nonNull []interface{}
	for _, v := range vals {
		if v == nil {
			hasNull = true
		} else {
			nonNull = append(nonNull, v)
		}
	}

	if len(nonNull) == 0 {
		return map[string]interface{}{"nullable": true}
	}

	typeBuckets := map[string][]interface{}{}
	for _, v := range nonNull {
		t := jsonTypeName(v)
		typeBuckets[t] = append(typeBuckets[t], v)
	}

	typeNames := make([]string, 0, len(typeBuckets))
	for t := range typeBuckets {
		typeNames = append(typeNames, t)
	}
	sort.Strings(typeNames)

	if len(typeNames) == 1 {
		schema := schemaForTypedValues(typeNames[0], typeBuckets[typeNames[0]])
		if hasNull {
			schema["nullable"] = true
		}
		return schema
	}

	options := make([]interface{}, 0, len(typeNames))
	for _, t := range typeNames {
		options = append(options, schemaForTypedValues(t, typeBuckets[t]))
	}
	schema := map[string]interface{}{"oneOf": options}
	if hasNull {
		schema["nullable"] = true
	}
	return schema
}

func schemaForTypedValues(typeName string, vals []interface{}) map[string]interface{} {
	switch typeName {
	case "object":
		return mergeObjectValues(vals)
	case "array":
		return mergeArrayValues(vals)
	case "integer":
		return map[string]interface{}{"type": "integer", "format": "int64"}
	case "number":
		return map[string]interface{}{"type": "number", "format": "double"}
	case "string":
		return inferStringSchema(vals)
	case "boolean":
		return map[string]interface{}{"type": "boolean"}
	default:
		return map[string]interface{}{}
	}
}

func jsonTypeName(v interface{}) string {
	switch v.(type) {
	case map[string]interface{}:
		return "object"
	case []interface{}:
		return "array"
	case float64:
		if v == float64(int64(v.(float64))) {
			return "integer"
		}
		return "number"
	case string:
		return "string"
	case bool:
		return "boolean"
	}
	return "null"
}

func mergeObjectValues(vals []interface{}) map[string]interface{} {
	// collect all values per key across all samples
	propSamples := map[string][]interface{}{}
	allKeys := map[string]bool{}
	presentCount := map[string]int{}
	for _, v := range vals {
		m, ok := v.(map[string]interface{})
		if !ok {
			continue
		}
		for k, fv := range m {
			allKeys[k] = true
			presentCount[k]++
			propSamples[k] = append(propSamples[k], fv)
		}
	}
	// fields missing from some samples are implicitly nullable
	for k := range allKeys {
		if len(propSamples[k]) < len(vals) {
			// pad with nils so nullable is detected
			for i := len(propSamples[k]); i < len(vals); i++ {
				propSamples[k] = append(propSamples[k], nil)
			}
		}
	}
	props := make(map[string]interface{}, len(allKeys))
	required := make([]string, 0, len(allKeys))
	for k, vs := range propSamples {
		props[k] = inferFromValues(vs)
		if presentCount[k] == len(vals) {
			required = append(required, k)
		}
	}
	sort.Strings(required)
	schema := map[string]interface{}{
		"type":                 "object",
		"properties":           props,
		"additionalProperties": false,
	}
	if len(required) > 0 {
		schema["required"] = required
	}
	return schema
}

func mergeArrayValues(vals []interface{}) map[string]interface{} {
	var items []interface{}
	for _, v := range vals {
		arr, ok := v.([]interface{})
		if !ok || len(arr) == 0 {
			continue
		}
		items = append(items, arr...)
	}
	if len(items) == 0 {
		return map[string]interface{}{"type": "array", "items": map[string]interface{}{}}
	}
	return map[string]interface{}{"type": "array", "items": inferFromValues(items)}
}

// schemaFromMap infers a schema by scanning ALL entries in the map.
// It scans all entries and keeps all observed values per top-level field
// so mixed and nullable types can be represented more accurately.
func schemaFromMap(m map[int64][]byte, label string) map[string]interface{} {
	total := len(m)
	if total == 0 {
		return map[string]interface{}{}
	}

	type fieldAcc struct {
		count   int
		samples []interface{}
	}
	fields := map[string]*fieldAcc{}

	logEvery := total / 10
	if logEvery < 1 {
		logEvery = 1
	}

	i := 0
	for _, raw := range m {
		var obj map[string]interface{}
		if json.Unmarshal(raw, &obj) == nil {
			for k, v := range obj {
				acc := fields[k]
				if acc == nil {
					acc = &fieldAcc{}
					fields[k] = acc
				}
				acc.count++
				acc.samples = append(acc.samples, v)
			}
		}
		i++
		if i%logEvery == 0 || i == total {
			log.Printf("openapi [%s] %d/%d (%.0f%%)", label, i, total, float64(i)/float64(total)*100)
		}
	}

	if len(fields) == 0 {
		return map[string]interface{}{}
	}

	props := make(map[string]interface{}, len(fields))
	required := make([]string, 0, len(fields))
	for k, acc := range fields {
		missing := total - acc.count
		padded := acc.samples
		if missing > 0 {
			need := len(padded) + missing
			for len(padded) < need {
				padded = append(padded, nil)
			}
		}
		if s, ok := inferFromValues(padded).(map[string]interface{}); ok {
			props[k] = s
		} else {
			props[k] = inferFromValues(padded)
		}
		if acc.count == total {
			required = append(required, k)
		}
	}

	sort.Strings(required)
	schema := map[string]interface{}{
		"type":                 "object",
		"properties":           props,
		"additionalProperties": false,
	}
	if len(required) > 0 {
		schema["required"] = required
	}
	return schema
}

func inferStringSchema(vals []interface{}) map[string]interface{} {
	schema := map[string]interface{}{"type": "string"}
	strs := make([]string, 0, len(vals))
	seen := make(map[string]struct{}, len(vals))
	allDateTime := len(vals) > 0
	for _, v := range vals {
		s, ok := v.(string)
		if !ok {
			allDateTime = false
			continue
		}
		strs = append(strs, s)
		seen[s] = struct{}{}
		if !isoDateTimeLike.MatchString(s) {
			allDateTime = false
		}
	}
	if allDateTime && len(strs) > 0 {
		schema["format"] = "date-time"
	}
	if enumVals := inferStringEnum(strs, seen); len(enumVals) > 0 {
		schema["enum"] = enumVals
	}
	return schema
}

func inferStringEnum(strs []string, seen map[string]struct{}) []string {
	if len(strs) == 0 || len(seen) < 1 || len(seen) > 16 {
		return nil
	}
	if len(seen)*4 > len(strs)+3 {
		return nil
	}
	enumVals := make([]string, 0, len(seen))
	for value := range seen {
		if strings.TrimSpace(value) == "" {
			return nil
		}
		if len(value) > 64 {
			return nil
		}
		enumVals = append(enumVals, value)
	}
	sort.Strings(enumVals)
	return enumVals
}

// Parameter helpers

func pathIntParam(name string) map[string]interface{} {
	return map[string]interface{}{
		"name": name, "in": "path", "required": true,
		"schema": map[string]interface{}{"type": "integer", "format": "int32"},
	}
}
func pathStrParam(name string) map[string]interface{} {
	return map[string]interface{}{
		"name": name, "in": "path", "required": true,
		"schema": map[string]interface{}{"type": "string"},
	}
}
func queryParam(name, typ string, required bool, extra ...interface{}) map[string]interface{} {
	schema := map[string]interface{}{"type": typ}
	for i := 0; i+1 < len(extra); i += 2 {
		schema[extra[i].(string)] = extra[i+1]
	}
	return map[string]interface{}{"name": name, "in": "query", "required": required, "schema": schema}
}

type params = []interface{}

func buildPath(summary, tag string, ps params, schema map[string]interface{}) interface{} {
	resp200 := map[string]interface{}{"description": "OK"}
	if len(schema) > 0 {
		resp200["content"] = map[string]interface{}{
			"application/json": map[string]interface{}{"schema": schema},
		}
	}
	return map[string]interface{}{
		"get": map[string]interface{}{
			"tags": []string{tag}, "summary": summary,
			"parameters": ps,
			"responses": map[string]interface{}{
				"200": resp200,
				"404": map[string]interface{}{"description": "Not found"},
			},
		},
	}
}

// Spec assembly

func generateOpenAPISpec(store *cachepkg.Store) ([]byte, error) {
	log.Printf("openapi: inferring schemas from full store (this may take a moment)...")
	itemSchema := schemaFromMap(store.ItemByItemID, "items")
	seriesSchema := schemaFromMap(store.SeriesBySeriesID, "series")
	epListSchema := schemaFromMap(store.EpisodesListByItemID, "ep-list")
	epSchema := schemaFromMap(store.EpisodeByEpisodeID, "episodes")
	statsSchema := schemaFromMap(store.StatisticsByItemID, "statistics")
	reviewSchema := schemaFromMap(store.ReviewListByItemID, "reviews")
	commentSchema := schemaFromMap(store.CommentListByEpisodeID, "comments")
	log.Printf("openapi: schema inference complete")

	paths := map[string]interface{}{
		// Items
		"/api/items/v4/{id}": buildPath(
			"Item detail", "items",
			params{pathIntParam("id")},
			itemSchema,
		),
		"/api/items/v2/series/{id}": buildPath(
			"Series list", "items",
			params{pathIntParam("id")},
			seriesSchema,
		),
		"/api/items/v1/{id}/statistics/": buildPath(
			"Item statistics", "items",
			params{pathIntParam("id")},
			statsSchema,
		),

		// Episodes
		"/api/episodes/v3/list": buildPath(
			"Episode list for an item", "episodes",
			params{
				queryParam("item_id", "integer", true),
				queryParam("offset", "integer", false, "default", 0),
				queryParam("limit", "integer", false, "default", 30),
				queryParam("sort", "string", false, "enum", []string{"oldest", "newest"}),
			},
			epListSchema,
		),
		"/api/episodes/v3/{episodeId}": buildPath(
			"Episode detail", "episodes",
			params{pathIntParam("episodeId")},
			epSchema,
		),
		"/api/episodes/v3/{episodeId}/video": buildPath(
			"Episode video / DRM keys", "episodes",
			params{pathIntParam("episodeId")},
			map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"dash_url": map[string]interface{}{"type": "string"},
					"keys": map[string]interface{}{
						"type": "array",
						"items": map[string]interface{}{
							"type": "object",
							"properties": map[string]interface{}{
								"key_id": map[string]interface{}{"type": "string"},
								"key":    map[string]interface{}{"type": "string"},
							},
						},
					},
				},
			},
		),
		"/api/episode/{episodeId}/item": buildPath(
			"Item containing the episode", "episodes",
			params{pathIntParam("episodeId")},
			itemSchema,
		),
		"/api/episode/{episodeId}/episodes": buildPath(
			"Episode list via episode ID", "episodes",
			params{pathIntParam("episodeId")},
			epListSchema,
		),

		// Reviews
		"/api/reviews/v1/count": buildPath(
			"Review count for an item", "reviews",
			params{queryParam("item_id", "integer", true)},
			map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"count": map[string]interface{}{"type": "integer"},
				},
			},
		),
		"/api/reviews/v2/list": buildPath(
			"Review list for an item", "reviews",
			params{
				queryParam("item_id", "integer", true),
				queryParam("offset", "integer", false, "default", 0),
				queryParam("limit", "integer", false, "default", 20),
				queryParam("sorting", "string", false, "enum", []string{"like", "newest", "created"}),
			},
			reviewSchema,
		),

		// Comments
		"/api/comments/v1/count": buildPath(
			"Comment count for an episode", "comments",
			params{queryParam("episode_id", "integer", true)},
			map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"comment_count": map[string]interface{}{"type": "integer"},
				},
			},
		),
		"/api/comments/v1/list": buildPath(
			"Comment list (episode or replies)", "comments",
			params{
				queryParam("episode_id", "integer", false),
				queryParam("parent_comment_id", "integer", false),
				queryParam("offset", "integer", false, "default", 0),
				queryParam("limit", "integer", false, "default", 20),
				queryParam("sorting", "string", false, "enum", []string{"top", "newest", "oldest"}),
			},
			commentSchema,
		),

		// Users
		"/api/users/v1/banned_words": buildPath(
			"Banned word list", "users",
			params{},
			map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"banned_word_list": map[string]interface{}{"type": "array", "items": map[string]interface{}{"type": "string"}},
					"replacement_word": map[string]interface{}{"type": "string"},
				},
			},
		),

		// Search
		"/api/search/v1/auto_complete": buildPath(
			"Autocomplete suggestions", "search",
			params{queryParam("keyword", "string", true)},
			map[string]interface{}{"type": "array", "items": map[string]interface{}{"type": "string"}},
		),
		"/api/search/v3/keyword": buildPath(
			"Keyword search", "search",
			params{
				queryParam("keyword", "string", true),
				queryParam("offset", "integer", false, "default", 0),
				queryParam("size", "integer", false, "default", 24),
			},
			map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"count":   map[string]interface{}{"type": "integer"},
					"next":    map[string]interface{}{"type": "string", "nullable": true},
					"results": map[string]interface{}{"type": "array", "items": itemSchema},
				},
			},
		),
		"/api/search/v1/discover": buildPath(
			"Discover / browse", "search",
			params{
				queryParam("offset", "integer", false, "default", 0),
				queryParam("size", "integer", false, "default", 24),
				queryParam("sort", "string", false, "enum", []string{"recent", "update", "rank", "avg_rating", "cnt_eval"}),
				queryParam("genres", "string", false),
				queryParam("tags", "string", false),
				queryParam("exclude_genres", "string", false),
				queryParam("exclude_tags", "string", false),
				queryParam("ending", "boolean", false),
				queryParam("medium", "string", false),
				queryParam("years", "string", false),
			},
			map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"count":   map[string]interface{}{"type": "integer"},
					"next":    map[string]interface{}{"type": "string", "nullable": true},
					"results": map[string]interface{}{"type": "array", "items": itemSchema},
				},
			},
		),

		// Media
		"/mediacloud/{path}": buildPath(
			"Mediacloud file (upstream proxy)", "media",
			params{pathStrParam("path")}, map[string]interface{}{},
		),
		"/thumbnail/{path}": buildPath(
			"Thumbnail image", "media",
			params{pathStrParam("path")}, map[string]interface{}{},
		),
		"/streaming-bp/{path}": buildPath(
			"Mediacloud file (upstream proxy)", "media",
			params{pathStrParam("path")}, map[string]interface{}{},
		),
	}

	spec := map[string]interface{}{
		"openapi": "3.0.3",
		"info": map[string]interface{}{
			"title":       "lafdb",
			"version":     "1.0.0",
			"description": "Local Laftel cache server",
		},
		"paths": paths,
	}
	return json.MarshalIndent(spec, "", "  ")
}

func generateAndSaveOpenAPI(store *cachepkg.Store) {
	data, err := generateOpenAPISpec(store)
	if err != nil {
		log.Printf("openapi gen: %v", err)
		return
	}
	if err := os.WriteFile(generatedOpenAPIPath, data, 0644); err != nil {
		log.Printf("openapi save: %v", err)
		return
	}
	log.Printf("openapi spec saved to %s", generatedOpenAPIPath)
}
