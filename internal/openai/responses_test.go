package openai

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/markhuangai/AaA-muse-ai/internal/inference"
)

func responseBody(input any, extra map[string]any) []byte {
	value := map[string]any{"model": Model, "input": input}
	for key, v := range extra {
		value[key] = v
	}
	encoded, _ := json.Marshal(value)
	return encoded
}

func TestResponsesNormalizeTypedTextAndFunctionItems(t *testing.T) {
	tool := map[string]any{"type": "function", "name": "read_file", "parameters": map[string]any{"type": "object"}, "strict": false}
	items := []any{
		map[string]any{"type": "message", "role": "developer", "content": []any{map[string]any{"type": "input_text", "text": "keep "}, map[string]any{"type": "input_text", "text": "exact\r\n😀"}}},
		map[string]any{"type": "function_call", "id": "fc_owned", "status": "completed", "call_id": "call-exact", "name": "read_file", "arguments": "{\"n\":1}"},
		map[string]any{"type": "function_call_output", "call_id": "call-exact", "output": "exact\r\n😀"},
		map[string]any{"type": "message", "id": "msg_owned", "role": "assistant", "status": "completed", "content": []any{map[string]any{"type": "output_text", "text": "answer", "annotations": []any{}}}},
	}
	r, err := NormalizeResponse(responseBody(items, map[string]any{"tools": []any{tool}, "instructions": "current only", "previous_response_id": "resp_owned", "stream": true, "parallel_tool_calls": false, "tool_choice": "auto"}))
	if err != nil || !r.Stream || *r.Input.Instructions != "current only" || r.Input.Input.Messages[0].Text != "keep exact\r\n😀" || r.Input.Input.Messages[1].CallID != "call-exact" || r.Input.ItemIDs[3] != "msg_owned" || len(r.Input.Input.Tools) != 1 {
		t.Fatal(r, err)
	}
	for _, fields := range []map[string]any{nil, {"instructions": nil, "previous_response_id": nil}, {"tool_choice": "none"}, {"instructions": ""}} {
		value, err := NormalizeResponse(responseBody("", fields))
		if err != nil || len(value.Input.Input.Messages) != 1 {
			t.Fatal(value, err)
		}
	}
}

func TestResponsesRejectUnsupportedFieldsAndMalformedItems(t *testing.T) {
	for _, fields := range []map[string]any{
		{"model": "unknown"}, {"stream": "true"}, {"parallel_tool_calls": true}, {"instructions": 4}, {"previous_response_id": 4}, {"previous_response_id": "bad space"}, {"tool_choice": "required"}, {"store": false}, {"temperature": 1}, {"tools": nil},
		{"tools": []any{4}}, {"tools": []any{map[string]any{"type": "web_search"}}}, {"tools": []any{map[string]any{"type": "function", "name": 4}}},
		{"tools": []any{map[string]any{"type": "function", "name": "f", "parameters": map[string]any{"type": "object"}, "strict": true}}},
		{"tools": []any{map[string]any{"type": "function", "name": "f", "parameters": map[string]any{"type": "nonsense"}}}},
		{"tools": []any{map[string]any{"type": "function", "name": "f", "parameters": map[string]any{"type": "object"}}, map[string]any{"type": "function", "name": "f", "parameters": map[string]any{"type": "object"}}}},
	} {
		if _, err := NormalizeResponse(responseBody("x", fields)); err == nil {
			t.Fatal("unsupported request admitted", fields)
		}
	}
	for _, item := range []any{
		4, map[string]any{"type": "reasoning"}, map[string]any{"role": "user", "content": "x", "extra": true}, map[string]any{"role": "tool", "content": "x"}, map[string]any{"role": 4, "content": "x"}, map[string]any{"role": "user", "content": nil},
		map[string]any{"role": "user", "content": []any{}}, map[string]any{"role": "user", "content": []any{4}}, map[string]any{"role": "user", "content": []any{map[string]any{"type": "input_image"}}},
		map[string]any{"role": "user", "content": []any{map[string]any{"type": "input_text", "text": 5}}}, map[string]any{"role": "user", "content": "x", "id": 4}, map[string]any{"role": "user", "content": "x", "id": "bad space"}, map[string]any{"role": "user", "content": "x", "status": "in_progress"},
		map[string]any{"role": "assistant", "content": []any{map[string]any{"type": "output_text", "text": "x", "annotations": []any{1}}}}, map[string]any{"role": "assistant", "content": []any{map[string]any{"type": "output_text", "text": "x", "annotations": "bad"}}},
		map[string]any{"type": "function_call_output", "call_id": "bad space", "output": "x"}, map[string]any{"type": "function_call_output", "call_id": 4, "output": "x"}, map[string]any{"type": "function_call_output", "call_id": "call", "output": 4},
		map[string]any{"type": "function_call", "call_id": "call", "name": 4, "arguments": "{}"}, map[string]any{"type": "function_call", "call_id": "call", "name": "f", "arguments": 4}, map[string]any{"type": "function_call", "call_id": "call", "name": "f", "arguments": "null"},
	} {
		if _, err := NormalizeResponse(responseBody([]any{item}, nil)); err == nil {
			t.Fatal("malformed item admitted", item)
		}
	}
	for _, raw := range []string{"{", `{"model":"muse-pool-text","input":[]}`, `{"model":3,"input":"x"}`, `{"input":"x"}`} {
		if _, err := NormalizeResponse([]byte(raw)); err == nil {
			t.Fatal(raw)
		}
	}
	_, err := NormalizeResponse(responseBody("x", map[string]any{"instructions": strings.Repeat("x", inference.MaxContextBytes)}))
	if err == nil {
		t.Fatal("oversized effective context admitted")
	}
}

func TestResponsesEncodeLifecycleAndExactOutput(t *testing.T) {
	for _, output := range []inference.Item{{Type: "final", Text: "exact\r\n😀"}, {Type: "tool_call", CallID: "exact-call", Name: "read_file", Arguments: map[string]any{"path": "fixture"}}} {
		instruction := "current"
		r := inference.RequestView{ID: "request", ResponseID: "resp_request", CreatedAt: time.Unix(123, 0), Output: &output, Response: &inference.ResponseMetadata{Instructions: &instruction, PreviousResponseID: "resp_old", Tools: []inference.Tool{{Name: "read_file", Parameters: map[string]any{"type": "object"}}}}}
		object, err := ResponseObject(r, "completed", "")
		if err != nil || object["usage"] != nil || object["instructions"] != "current" {
			t.Fatal(object, err)
		}
		frames, err := ResponseFrames(r, "")
		if err != nil {
			t.Fatal(err)
		}
		for i, frame := range frames {
			parts := strings.Split(string(frame.Bytes), "\ndata: ")
			var event map[string]any
			if len(parts) != 2 || json.Unmarshal([]byte(strings.TrimSpace(parts[1])), &event) != nil || event["sequence_number"] != float64(i) || event["type"] != frame.Kind {
				t.Fatal("invalid typed frame", frame)
			}
		}
		if frames[0].Kind != "response.created" || frames[1].Kind != "response.in_progress" || frames[len(frames)-1].Kind != "response.completed" {
			t.Fatal(frames)
		}
		failed, err := ResponseFrames(r, "worker_disconnected")
		if err != nil || len(failed) != 3 || failed[2].Kind != "response.failed" {
			t.Fatal(failed, err)
		}
	}
	for _, r := range []inference.RequestView{{}, {ID: "r", ResponseID: "resp_r"}, {ID: "r", ResponseID: "resp_r", Output: &inference.Item{Type: "unknown"}}, {ID: "r", ResponseID: "resp_r", Output: &inference.Item{Type: "tool_call", Arguments: map[string]any{"invalid": make(chan int)}}}} {
		if _, err := ResponseObject(r, "completed", ""); err == nil {
			t.Fatal("invalid output encoded", r)
		}
		if _, err := ResponseFrames(r, ""); err == nil {
			t.Fatal("invalid output streamed", r)
		}
	}
}
