package http

import (
	"bytes"
	"encoding/json"

	"github.com/vmihailenco/msgpack/v5"
)

// jsonToMsgpack converts raw JSON bytes to MessagePack bytes.
// JSON numbers that are whole integers are encoded as int64; others as float64.
func jsonToMsgpack(b []byte) ([]byte, error) {
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return nil, err
	}
	return msgpack.Marshal(convertJSONNumbers(v))
}

// convertJSONNumbers recursively converts json.Number values to int64 or float64.
func convertJSONNumbers(v any) any {
	switch x := v.(type) {
	case json.Number:
		if i, err := x.Int64(); err == nil {
			return i
		}
		if f, err := x.Float64(); err == nil {
			return f
		}
		return x.String()
	case map[string]any:
		for k, val := range x {
			x[k] = convertJSONNumbers(val)
		}
	case []any:
		for i, val := range x {
			x[i] = convertJSONNumbers(val)
		}
	}
	return v
}
