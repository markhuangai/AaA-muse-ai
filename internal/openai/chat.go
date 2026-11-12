package openai

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"github.com/markhuangai/AaA-muse-ai/internal/inference"
)

const Model = "muse-pool-text"

type Error struct {
	Status      int
	Code, Param string
	Detail      any
}

func (e *Error) Error() string { return e.Code }

func reject(code, path string) error { return &Error{Status: 400, Code: code, Param: path} }

type Chat struct {
	Input    inference.RequestInput
	Stream   bool
	Admitted map[string]any
}

func fields(value any, path string, allowed ...string) (map[string]any, error) {
	m, ok := value.(map[string]any)
	if !ok {
		return nil, reject("object_required", path)
	}
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		found := false
		for _, a := range allowed {
			if a == k {
				found = true
				break
			}
		}
		if !found {
			return nil, reject("unsupported_parameter", join(path, k))
		}
	}
	return m, nil
}

func join(path, key string) string {
	if path == "" {
		return key
	}
	return path + "." + key
}

func stringField(m map[string]any, key, path string) (string, error) {
	v, ok := m[key].(string)
	if !ok {
		return "", reject("string_required", join(path, key))
	}
	return v, nil
}

func Normalize(body []byte) (Chat, error) {
	c := Chat{Input: inference.RequestInput{Version: 1, TimeoutSeconds: 300, Tools: []inference.Tool{}}}
	var raw map[string]any
	if err := inference.Decode(body, &raw); err != nil {
		return c, reject(err.Error(), "")
	}
	c.Admitted = raw
	m, err := fields(raw, "", "model", "messages", "tools", "stream", "n", "parallel_tool_calls", "tool_choice")
	if err != nil {
		return c, err
	}
	model, err := stringField(m, "model", "")
	if err != nil {
		return c, err
	}
	if model != Model {
		return c, &Error{Status: 404, Code: "model_not_found", Param: "model"}
	}
	if v, ok := m["stream"]; ok {
		c.Stream, ok = v.(bool)
		if !ok {
			return c, reject("boolean_required", "stream")
		}
	}
	if v, ok := m["n"]; ok && v != json.Number("1") {
		return c, reject("multiple_choices_unsupported", "n")
	}
	if v, ok := m["parallel_tool_calls"]; ok && v != false {
		return c, reject("parallel_tool_calls_unsupported", "parallel_tool_calls")
	}
	if rawTools, exists := m["tools"]; exists {
		tools, ok := rawTools.([]any)
		if !ok {
			return c, reject("array_required", "tools")
		}
		seen := map[string]bool{}
		for i, v := range tools {
			path := fmt.Sprintf("tools[%d]", i)
			t, err := normalizeTool(v, path)
			if err != nil {
				return c, err
			}
			if seen[t.Name] {
				return c, reject("duplicate_tool_name", path+".function.name")
			}
			seen[t.Name] = true
			c.Input.Tools = append(c.Input.Tools, t)
		}
	}
	if v, ok := m["tool_choice"]; ok && v != "auto" && !(v == "none" && len(c.Input.Tools) == 0) {
		return c, reject("tool_choice_unsupported", "tool_choice")
	}
	messages, ok := m["messages"].([]any)
	if !ok || len(messages) == 0 {
		return c, reject("nonempty_messages_required", "messages")
	}
	for i, v := range messages {
		items, err := normalizeMessage(v, fmt.Sprintf("messages[%d]", i))
		if err != nil {
			return c, err
		}
		c.Input.Messages = append(c.Input.Messages, items...)
	}
	if err = inference.CheckContext(c.Input.Messages, c.Input.Tools); err != nil {
		return c, &Error{Status: 413, Code: err.Error(), Param: "messages"}
	}
	return c, nil
}

func normalizeTool(value any, path string) (inference.Tool, error) {
	var t inference.Tool
	m, err := fields(value, path, "type", "function")
	if err != nil {
		return t, err
	}
	if m["type"] != "function" {
		return t, reject("function_tools_only", path+".type")
	}
	f, err := fields(m["function"], path+".function", "name", "description", "parameters", "strict")
	if err != nil {
		return t, err
	}
	if t.Name, err = stringField(f, "name", path+".function"); err != nil {
		return t, err
	}
	if _, exists := f["description"]; exists {
		if t.Description, err = stringField(f, "description", path+".function"); err != nil {
			return t, err
		}
	}
	if v, exists := f["strict"]; exists && v != false {
		return t, reject("strict_tools_unsupported", path+".function.strict")
	}
	var ok bool
	if t.Parameters, ok = f["parameters"].(map[string]any); !ok {
		return t, reject("object_required", path+".function.parameters")
	}
	if _, err = inference.Compile(t); err != nil {
		return t, &Error{Status: 400, Code: err.Error(), Param: path + ".function.parameters", Detail: err}
	}
	return t, nil
}

func text(value any, path string) (string, error) {
	if s, ok := value.(string); ok {
		return s, nil
	}
	parts, ok := value.([]any)
	if !ok || len(parts) == 0 {
		return "", reject("text_content_required", path)
	}
	var out strings.Builder
	for i, p := range parts {
		partPath := fmt.Sprintf("%s[%d]", path, i)
		m, err := fields(p, partPath, "type", "text")
		if err != nil {
			return "", err
		}
		if m["type"] != "text" {
			return "", reject("text_content_only", partPath+".type")
		}
		s, err := stringField(m, "text", partPath)
		if err != nil {
			return "", err
		}
		out.WriteString(s)
	}
	return out.String(), nil
}

func normalizeMessage(value any, path string) ([]inference.Item, error) {
	m, ok := value.(map[string]any)
	if !ok {
		return nil, reject("object_required", path)
	}
	role, err := stringField(m, "role", path)
	if err != nil {
		return nil, err
	}
	allowed := []string{"role", "content"}
	switch role {
	case "system", "developer", "user":
	case "assistant":
		allowed = append(allowed, "tool_calls", "refusal")
	case "tool":
		allowed = append(allowed, "tool_call_id")
	default:
		return nil, reject("unsupported_role", path+".role")
	}
	if _, err = fields(m, path, allowed...); err != nil {
		return nil, err
	}
	if v, exists := m["refusal"]; exists && v != nil {
		return nil, reject("refusals_unsupported", path+".refusal")
	}
	var calls []any
	if v, exists := m["tool_calls"]; exists {
		if calls, ok = v.([]any); !ok || len(calls) > 1 {
			return nil, reject("single_function_call_required", path+".tool_calls")
		}
	}
	content := ""
	if m["content"] != nil || len(calls) == 0 {
		if content, err = text(m["content"], path+".content"); err != nil {
			return nil, err
		}
	}
	if role == "tool" {
		id, err := stringField(m, "tool_call_id", path)
		if err != nil {
			return nil, err
		}
		if !inference.Identifier.MatchString(id) {
			return nil, reject("invalid_tool_call_id", path+".tool_call_id")
		}
		return []inference.Item{{Type: "tool_result", CallID: id, Output: content}}, nil
	}
	items := []inference.Item{}
	if len(calls) == 0 || content != "" {
		items = append(items, inference.Item{Type: "message", Role: role, Text: content})
	}
	if len(calls) == 1 {
		call, err := normalizeCall(calls[0], path+".tool_calls[0]")
		if err != nil {
			return nil, err
		}
		items = append(items, call)
	}
	return items, nil
}

func normalizeCall(value any, path string) (inference.Item, error) {
	c := inference.Item{Type: "tool_call"}
	m, err := fields(value, path, "id", "type", "function")
	if err != nil {
		return c, err
	}
	if m["type"] != "function" {
		return c, reject("function_tools_only", path+".type")
	}
	if c.CallID, err = stringField(m, "id", path); err != nil {
		return c, err
	}
	if !inference.Identifier.MatchString(c.CallID) {
		return c, reject("invalid_tool_call_id", path+".id")
	}
	f, err := fields(m["function"], path+".function", "name", "arguments")
	if err != nil {
		return c, err
	}
	if c.Name, err = stringField(f, "name", path+".function"); err != nil {
		return c, err
	}
	args, err := stringField(f, "arguments", path+".function")
	if err != nil {
		return c, err
	}
	if err = inference.Decode([]byte(args), &c.Arguments); err != nil {
		return c, reject("invalid_function_arguments", path+".function.arguments")
	}
	return c, nil
}
