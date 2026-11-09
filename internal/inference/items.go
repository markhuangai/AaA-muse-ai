package inference

import (
	"bytes"
	"encoding/json"
)

func (m Item) MarshalJSON() ([]byte, error) {
	var fields map[string]any
	switch m.Type {
	case "message":
		fields = map[string]any{"type": m.Type, "role": m.Role, "text": m.Text}
	case "tool_call":
		fields = map[string]any{"type": m.Type, "call_id": m.CallID, "name": m.Name, "arguments": m.Arguments}
	case "tool_result":
		fields = map[string]any{"type": m.Type, "call_id": m.CallID, "output": m.Output}
	case "final":
		fields = map[string]any{"type": m.Type, "text": m.Text}
	default:
		type plain Item
		return json.Marshal(plain(m))
	}
	return json.Marshal(fields)
}

func (m *Item) UnmarshalJSON(data []byte) error {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return err
	}
	var kind string
	if err := json.Unmarshal(fields["type"], &kind); err != nil {
		return err
	}
	allowed := map[string][]string{"message": {"type", "role", "text"}, "tool_call": {"type", "call_id", "name", "arguments"}, "tool_result": {"type", "call_id", "output"}, "final": {"type", "text"}}
	keys, ok := allowed[kind]
	if !ok {
		return Reject("unsupported_history_item", 400)
	}
	if len(fields) != len(keys) {
		return Reject("invalid_item_fields", 400)
	}
	for _, k := range keys {
		v, ok := fields[k]
		if !ok || bytes.Equal(bytes.TrimSpace(v), []byte("null")) {
			return Reject("required_item_field", 400)
		}
	}
	type plain Item
	d := json.NewDecoder(bytes.NewReader(data))
	d.UseNumber()
	d.DisallowUnknownFields()
	return d.Decode((*plain)(m))
}
