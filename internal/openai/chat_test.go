package openai

import (
	"encoding/json"
	"errors"
	"math"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/markhuangai/AaA-muse-ai/internal/inference"
)

func chatBody(messages any, extra map[string]any) []byte {
	m := map[string]any{"model": Model, "messages": messages}
	for k, v := range extra {
		m[k] = v
	}
	b, err := json.Marshal(m)
	if err != nil {
		panic(err)
	}
	return b
}

func TestChatNormalizeTextToolsAndRoundTrip(t *testing.T) {
	tool := map[string]any{"type": "function", "function": map[string]any{"name": "read_file", "description": "client only", "strict": false, "parameters": map[string]any{"type": "object", "properties": map[string]any{"path": map[string]any{"type": "string"}}, "required": []string{"path"}}}}
	messages := []any{
		map[string]any{"role": "system", "content": "system\r\n"},
		map[string]any{"role": "developer", "content": []any{map[string]any{"type": "text", "text": "first"}, map[string]any{"type": "text", "text": " second"}}},
		map[string]any{"role": "user", "content": "read"},
		map[string]any{"role": "assistant", "content": "before call", "refusal": nil, "tool_calls": []any{map[string]any{"id": "call-a", "type": "function", "function": map[string]any{"name": "read_file", "arguments": "{\"path\":\"client-only\",\"number\":9007199254740993}"}}}},
		map[string]any{"role": "tool", "tool_call_id": "call-a", "content": []any{map[string]any{"type": "text", "text": "exact\n"}}},
		map[string]any{"role": "assistant", "content": "answer", "tool_calls": []any{}},
	}
	c, err := Normalize(chatBody(messages, map[string]any{"tools": []any{tool}, "stream": true, "n": 1, "parallel_tool_calls": false, "tool_choice": "auto"}))
	if err != nil {
		t.Fatal(err)
	}
	if !c.Stream || len(c.Input.Messages) != 7 || c.Input.Messages[1].Text != "first second" || c.Input.Messages[4].Arguments["number"] != json.Number("9007199254740993") || c.Input.Messages[5].Output != "exact\n" || c.Input.TimeoutSeconds != 300 {
		t.Fatal("normalization lost admitted meaning", c)
	}
	if c.Input.Tools[0].Description != "client only" || c.Input.Messages[3].Text != "before call" {
		t.Fatal("assistant text or definition lost")
	}
	r := inference.RequestView{ID: "test", CreatedAt: time.Unix(100, 0), Output: &inference.Item{Type: "tool_call", CallID: "call-b", Name: "read_file", Arguments: map[string]any{"path": "client-only"}}}
	encoded, err := Completion(r)
	if err != nil {
		t.Fatal(err)
	}
	var response struct {
		Choices []struct {
			Message map[string]any `json:"message"`
		} `json:"choices"`
	}
	if err = json.Unmarshal(encoded, &response); err != nil {
		t.Fatal(err)
	}
	c, err = Normalize(chatBody([]any{response.Choices[0].Message, map[string]any{"role": "tool", "tool_call_id": "call-b", "content": "result"}}, map[string]any{"tools": []any{tool}}))
	if err != nil || len(c.Input.Messages) != 2 || c.Input.Messages[0].CallID != "call-b" {
		t.Fatal("returned assistant message cannot round-trip", err, c)
	}
	if _, err = Normalize(chatBody([]any{map[string]any{"role": "user", "content": ""}}, map[string]any{"tool_choice": "none"})); err != nil {
		t.Fatal(err)
	}
}

func TestChatRejectsUnsupportedAndMalformedInputsWithPaths(t *testing.T) {
	user := []any{map[string]any{"role": "user", "content": "x"}}
	function := map[string]any{"type": "function", "function": map[string]any{"name": "read_file", "parameters": map[string]any{"type": "object"}}}
	cases := []struct {
		extra    map[string]any
		messages any
		param    string
	}{
		{map[string]any{"model": "other"}, user, "model"},
		{map[string]any{"model": nil}, user, "model"},
		{map[string]any{"temperature": 1}, user, "temperature"},
		{map[string]any{"stream": "true"}, user, "stream"},
		{map[string]any{"n": 2}, user, "n"},
		{map[string]any{"parallel_tool_calls": true}, user, "parallel_tool_calls"},
		{map[string]any{"tool_choice": "required"}, user, "tool_choice"},
		{map[string]any{"tools": nil}, user, "tools"},
		{map[string]any{"tools": []any{function, function}}, user, "tools[1].function.name"},
		{nil, []any{}, "messages"}, {nil, nil, "messages"}, {nil, []any{7}, "messages[0]"},
		{nil, []any{map[string]any{"role": 3}}, "messages[0].role"},
		{nil, []any{map[string]any{"role": "function", "content": "x"}}, "messages[0].role"},
		{nil, []any{map[string]any{"role": "user", "content": "x", "name": "someone"}}, "messages[0].name"},
		{nil, []any{map[string]any{"role": "assistant", "content": "x", "refusal": "no"}}, "messages[0].refusal"},
		{nil, []any{map[string]any{"role": "assistant", "tool_calls": []any{1, 2}}}, "messages[0].tool_calls"},
		{nil, []any{map[string]any{"role": "assistant", "tool_calls": nil}}, "messages[0].tool_calls"},
		{nil, []any{map[string]any{"role": "user", "content": []any{}}}, "messages[0].content"},
		{nil, []any{map[string]any{"role": "user", "content": []any{7}}}, "messages[0].content[0]"},
		{nil, []any{map[string]any{"role": "user", "content": []any{map[string]any{"type": "image_url"}}}}, "messages[0].content[0].type"},
		{nil, []any{map[string]any{"role": "user", "content": []any{map[string]any{"type": "text", "text": nil}}}}, "messages[0].content[0].text"},
		{nil, []any{map[string]any{"role": "tool", "content": "x"}}, "messages[0].tool_call_id"},
		{nil, []any{map[string]any{"role": "tool", "content": "x", "tool_call_id": "bad id"}}, "messages[0].tool_call_id"},
	}
	for _, tc := range cases {
		_, err := Normalize(chatBody(tc.messages, tc.extra))
		var rejected *Error
		if !errors.As(err, &rejected) || rejected.Param != tc.param {
			t.Fatalf("wanted %s: %v", tc.param, err)
		}
	}
	for _, raw := range []string{"{", `{"model":"x","model":"x"}`, `{"model":"muse-pool-text","messages":[{"role":"user","content":"x","content":"y"}]}`, "null", "[]", string([]byte{0xff})} {
		if _, err := Normalize([]byte(raw)); err == nil {
			t.Fatal("invalid JSON admitted")
		}
	}
	large := chatBody([]any{map[string]any{"role": "user", "content": strings.Repeat("x", 1048576)}}, nil)
	var rejected *Error
	if _, err := Normalize(large); !errors.As(err, &rejected) || rejected.Status != 413 {
		t.Fatal("normalized context bound lost", err)
	}
}

func TestChatFunctionValidationPaths(t *testing.T) {
	for _, value := range []any{7, map[string]any{"type": "custom"}, map[string]any{"type": "function", "function": 7}, map[string]any{"type": "function", "function": map[string]any{"name": 7}}, map[string]any{"type": "function", "function": map[string]any{"name": "f", "description": 7}}, map[string]any{"type": "function", "function": map[string]any{"name": "f", "strict": true}}, map[string]any{"type": "function", "function": map[string]any{"name": "f", "parameters": false}}, map[string]any{"type": "function", "function": map[string]any{"name": "f", "parameters": map[string]any{"$ref": "https://example.test/schema"}}}} {
		if _, err := normalizeTool(value, "tools[0]"); err == nil {
			t.Fatal("invalid function admitted", value)
		}
	}
	base := map[string]any{"id": "call-a", "type": "function", "function": map[string]any{"name": "f", "arguments": "{}"}}
	mutations := []map[string]any{{"extra": true}, {"type": "custom"}, {"id": nil}, {"id": "bad id"}, {"function": false}, {"function": map[string]any{"name": false}}, {"function": map[string]any{"name": "f", "arguments": false}}, {"function": map[string]any{"name": "f", "arguments": "{\"x\":1,\"x\":2}"}}, {"function": map[string]any{"name": "f", "arguments": "null"}}}
	for _, mutation := range mutations {
		call := map[string]any{}
		for k, v := range base {
			call[k] = v
		}
		for k, v := range mutation {
			call[k] = v
		}
		if _, err := normalizeCall(call, "messages[0].tool_calls[0]"); err == nil {
			t.Fatal("invalid call admitted", call)
		}
	}
	if _, err := normalizeCall(7, "call"); err == nil {
		t.Fatal("non-object call admitted")
	}
	if _, err := normalizeMessage(map[string]any{"role": "assistant", "content": nil, "tool_calls": []any{base}}, "message"); err != nil {
		t.Fatal(err)
	}
}

func TestChatJSONAndBufferedSSE(t *testing.T) {
	for _, d := range []inference.Item{{Type: "final", Text: "exact\r\n😀\""}, {Type: "tool_call", CallID: "call-a", Name: "f", Arguments: map[string]any{"number": json.Number("9007199254740993"), "path": "a\nb"}}} {
		r := inference.RequestView{ID: "request", CreatedAt: time.Unix(100, 0), Output: &d}
		b, err := Completion(r)
		if err != nil {
			t.Fatal(err)
		}
		var value map[string]any
		if err = json.Unmarshal(b, &value); err != nil {
			t.Fatal(err)
		}
		if value["model"] != Model || value["id"] != "chatcmpl-request" || value["usage"] != nil {
			t.Fatal("identity or unknown usage incorrect")
		}
		frames, err := Frames(r)
		if err != nil || len(frames) != 4 || string(frames[3].Bytes) != "data: [DONE]\n\n" {
			t.Fatal("buffered SSE termination incorrect", err)
		}
		for _, frame := range frames[:3] {
			if !strings.HasPrefix(string(frame.Bytes), "data: ") || !strings.HasSuffix(string(frame.Bytes), "\n\n") {
				t.Fatal("invalid SSE frame")
			}
			if err = json.Unmarshal(frame.Bytes[6:len(frame.Bytes)-2], &value); err != nil {
				t.Fatal(err)
			}
			if value["id"] != "chatcmpl-request" || value["object"] != "chat.completion.chunk" {
				t.Fatal("unstable chunk identity")
			}
		}
	}
	if !reflect.DeepEqual(Models().(map[string]any)["data"].([]any)[0].(map[string]any)["id"], Model) {
		t.Fatal("model identity changed")
	}
	for _, d := range []*inference.Item{nil, {Type: "unsupported"}, {Type: "tool_call", Arguments: map[string]any{"bad": math.Inf(1)}}} {
		r := inference.RequestView{Output: d}
		if _, err := Completion(r); err == nil {
			t.Fatal("invalid decision encoded")
		}
		if _, err := Frames(r); err == nil {
			t.Fatal("invalid decision streamed")
		}
	}
}
