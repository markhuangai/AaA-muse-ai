package openai

import (
	"encoding/json"
	"errors"
	"strings"

	"github.com/markhuangai/AaA-muse-ai/internal/inference"
)

func responseOutput(r inference.RequestView) (map[string]any, error) {
	if r.Output == nil {
		return nil, errors.New("output_not_available")
	}
	item := r.Output
	id := inference.OutputItemID(r.ID, item.Type)
	if item.Type == "final" {
		return map[string]any{"id": id, "type": "message", "role": "assistant", "status": "completed", "content": []any{outputText(item.Text)}}, nil
	}
	if item.Type != "tool_call" {
		return nil, errors.New("unsupported_decision")
	}
	arguments, err := argumentString(item)
	if err != nil {
		return nil, err
	}
	return map[string]any{"id": id, "type": "function_call", "call_id": item.CallID, "name": item.Name, "arguments": arguments, "status": "completed"}, nil
}

func outputText(text string) map[string]any {
	return map[string]any{"type": "output_text", "text": text, "annotations": []any{}}
}

func ResponseObject(r inference.RequestView, status, reason string) (map[string]any, error) {
	if r.ID == "" || r.ResponseID == "" {
		return nil, errors.New("response_identity_unavailable")
	}
	output := []any{}
	if status == "completed" {
		item, err := responseOutput(r)
		if err != nil {
			return nil, err
		}
		output = append(output, item)
	}
	var failure, instructions, previous any
	tools := []any{}
	if reason != "" {
		failure = map[string]any{"code": reason, "message": strings.ReplaceAll(reason, "_", " ")}
	}
	if r.Response != nil {
		if r.Response.Instructions != nil {
			instructions = *r.Response.Instructions
		}
		if r.Response.PreviousResponseID != "" {
			previous = r.Response.PreviousResponseID
		}
		tools = responseTools(r.Response.Tools)
	}
	return map[string]any{"id": r.ResponseID, "object": "response", "created_at": r.CreatedAt.Unix(), "status": status, "error": failure, "incomplete_details": nil, "instructions": instructions, "model": Model, "output": output, "parallel_tool_calls": false, "tool_choice": "auto", "tools": tools, "previous_response_id": previous, "usage": nil}, nil
}

func ResponseFrames(r inference.RequestView, failure string) ([]Frame, error) {
	progress, err := ResponseObject(r, "in_progress", "")
	if err != nil {
		return nil, err
	}
	frames := []Frame{}
	var encodeErr error
	emit := func(kind string, fields map[string]any) {
		if encodeErr != nil {
			return
		}
		fields["type"], fields["sequence_number"] = kind, len(frames)
		encoded, err := json.Marshal(fields)
		if err != nil {
			encodeErr = err
			return
		}
		frames = append(frames, Frame{Kind: kind, Bytes: []byte("event: " + kind + "\ndata: " + string(encoded) + "\n\n")})
	}
	emit("response.created", map[string]any{"response": progress})
	emit("response.in_progress", map[string]any{"response": progress})
	if failure != "" {
		failed, err := ResponseObject(r, "failed", failure)
		if err != nil {
			return nil, err
		}
		emit("response.failed", map[string]any{"response": failed})
		return frames, encodeErr
	}
	item, err := responseOutput(r)
	if err != nil {
		return nil, err
	}
	added := map[string]any{}
	for key, value := range item {
		added[key] = value
	}
	added["status"] = "in_progress"
	id := item["id"]
	if r.Output.Type == "final" {
		added["content"] = []any{}
	} else {
		added["arguments"] = ""
	}
	emit("response.output_item.added", map[string]any{"output_index": 0, "item": added})
	if r.Output.Type == "final" {
		emit("response.content_part.added", map[string]any{"item_id": id, "output_index": 0, "content_index": 0, "part": outputText("")})
		emit("response.output_text.delta", map[string]any{"item_id": id, "output_index": 0, "content_index": 0, "delta": r.Output.Text, "logprobs": []any{}})
		emit("response.output_text.done", map[string]any{"item_id": id, "output_index": 0, "content_index": 0, "text": r.Output.Text, "logprobs": []any{}})
		emit("response.content_part.done", map[string]any{"item_id": id, "output_index": 0, "content_index": 0, "part": outputText(r.Output.Text)})
	} else {
		emit("response.function_call_arguments.delta", map[string]any{"item_id": id, "output_index": 0, "delta": item["arguments"]})
		emit("response.function_call_arguments.done", map[string]any{"item_id": id, "output_index": 0, "arguments": item["arguments"]})
	}
	emit("response.output_item.done", map[string]any{"output_index": 0, "item": item})
	completed, err := ResponseObject(r, "completed", "")
	if err != nil {
		return nil, err
	}
	emit("response.completed", map[string]any{"response": completed})
	return frames, encodeErr
}
