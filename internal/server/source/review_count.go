package source

import "encoding/json"

func DeriveReviewCountJSON(raw []byte) ([]byte, bool) {
	var doc struct {
		Count   int        `json:"count"`
		Results []struct{} `json:"results"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, false
	}
	count := doc.Count
	if count <= 0 && len(doc.Results) > 0 {
		count = len(doc.Results)
	}
	out, err := json.Marshal(map[string]int{"count": count})
	if err != nil {
		return nil, false
	}
	return out, true
}
