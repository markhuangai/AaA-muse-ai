package openai

import (
	"encoding/json"
	"errors"

	"github.com/markhuangai/AaA-muse-ai/internal/inference"
)

type Frame struct {
	Kind  string
	Bytes []byte
}

func Models() any {
	return map[string]any{"object": "list", "data": []any{map[string]any{"id": Model, "object": "model", "created": 0, "owned_by": "aaa-muse-ai"}}}
}

func decision(r inference.RequestView) (map[string]any, string, error) {
	if r.Output == nil {
		return nil, "", errors.New("output_not_available")
	}
	d := r.Output
	if d.Type == "final" {
		return map[string]any{"content": d.Text}, "stop", nil
	}
	if d.Type != "tool_call" {
		return nil, "", errors.New("unsupported_decision")
	}
	args, err := json.Marshal(d.Arguments)
	if err != nil {
		return nil, "", err
	}
	return map[string]any{"tool_calls": []any{map[string]any{"id": d.CallID, "type": "function", "function": map[string]any{"name": d.Name, "arguments": string(args)}}}}, "tool_calls", nil
}

func envelope(r inference.RequestView, object string, choice any) map[string]any {
	return map[string]any{"id": "chatcmpl-" + r.ID, "object": object, "created": r.CreatedAt.Unix(), "model": Model, "choices": []any{choice}}
}

func Completion(r inference.RequestView) ([]byte, error) {
	message, reason, err := decision(r)
	if err != nil {
		return nil, err
	}
	message["role"], message["refusal"] = "assistant", nil
	if reason == "tool_calls" {
		message["content"] = nil
	}
	return json.Marshal(envelope(r, "chat.completion", map[string]any{"index": 0, "message": message, "finish_reason": reason, "logprobs": nil}))
}

func Frames(r inference.RequestView) ([]Frame, error) {
	delta, reason, err := decision(r)
	if err != nil {
		return nil, err
	}
	if calls, ok := delta["tool_calls"].([]any); ok {
		calls[0].(map[string]any)["index"] = 0
	}
	frames := []Frame{}
	for _, event := range []struct {
		kind   string
		delta  map[string]any
		finish any
	}{
		{"role", map[string]any{"role": "assistant"}, nil},
		{reason, delta, nil},
		{"finish", map[string]any{}, reason},
	} {
		b, err := json.Marshal(envelope(r, "chat.completion.chunk", map[string]any{"index": 0, "delta": event.delta, "finish_reason": event.finish, "logprobs": nil}))
		if err != nil {
			return nil, err
		}
		frames = append(frames, Frame{Kind: event.kind, Bytes: append(append([]byte("data: "), b...), []byte("\n\n")...)})
	}
	return append(frames, Frame{Kind: "done", Bytes: []byte("data: [DONE]\n\n")}), nil
}
