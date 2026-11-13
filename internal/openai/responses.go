package openai

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/markhuangai/AaA-muse-ai/internal/inference"
)

type Responses struct {
	Input    inference.ResponseInput
	Stream   bool
	Admitted map[string]any
}

func NormalizeResponse(body []byte) (Responses, error) {
	r := Responses{Input: inference.ResponseInput{Input: inference.RequestInput{Version: 1, TimeoutSeconds: 300, Tools: []inference.Tool{}}, ItemIDs: []string{}}}
	if err := inference.Decode(body, &r.Admitted); err != nil {
		return r, reject(err.Error(), "")
	}
	m, err := fields(r.Admitted, "", "model", "input", "instructions", "tools", "stream", "parallel_tool_calls", "tool_choice", "previous_response_id")
	if err != nil {
		return r, err
	}
	model, err := stringField(m, "model", "")
	if err != nil {
		return r, err
	}
	if model != Model {
		return r, &Error{Status: 404, Code: "model_not_found", Param: "model"}
	}
	if value, ok := m["stream"]; ok {
		if r.Stream, ok = value.(bool); !ok {
			return r, reject("boolean_required", "stream")
		}
	}
	if value, ok := m["instructions"]; ok && value != nil {
		text, err := stringField(m, "instructions", "")
		if err != nil {
			return r, err
		}
		r.Input.Instructions = &text
	}
	if value, ok := m["previous_response_id"]; ok && value != nil {
		id, err := stringField(m, "previous_response_id", "")
		if err != nil {
			return r, err
		}
		if !inference.Identifier.MatchString(id) {
			return r, reject("invalid_response_id", "previous_response_id")
		}
		r.Input.Input.PreviousResponseID = id
	}
	if value, ok := m["parallel_tool_calls"]; ok && value != false {
		return r, reject("parallel_tool_calls_unsupported", "parallel_tool_calls")
	}
	if value, ok := m["tools"]; ok {
		tools, ok := value.([]any)
		if !ok {
			return r, reject("array_required", "tools")
		}
		seen := map[string]bool{}
		for i, value := range tools {
			path := fmt.Sprintf("tools[%d]", i)
			flat, err := fields(value, path, "type", "name", "description", "parameters", "strict")
			if err != nil {
				return r, err
			}
			function := map[string]any{}
			for key, value := range flat {
				if key != "type" {
					function[key] = value
				}
			}
			tool, err := normalizeTool(map[string]any{"type": flat["type"], "function": function}, path)
			if boundary, ok := err.(*Error); ok {
				copy := *boundary
				copy.Param = strings.Replace(copy.Param, ".function", "", 1)
				err = &copy
			}
			if err != nil {
				return r, err
			}
			if seen[tool.Name] {
				return r, reject("duplicate_tool_name", path+".name")
			}
			seen[tool.Name] = true
			r.Input.Input.Tools = append(r.Input.Input.Tools, tool)
		}
	}
	if value, ok := m["tool_choice"]; ok && value != "auto" && !(value == "none" && len(r.Input.Input.Tools) == 0) {
		return r, reject("tool_choice_unsupported", "tool_choice")
	}
	if text, ok := m["input"].(string); ok {
		r.Input.Input.Messages = []inference.Item{{Type: "message", Role: "user", Text: text}}
		r.Input.ItemIDs = []string{""}
	} else {
		items, ok := m["input"].([]any)
		if !ok || len(items) == 0 {
			return r, reject("nonempty_input_required", "input")
		}
		for i, value := range items {
			item, id, err := responseItem(value, fmt.Sprintf("input[%d]", i))
			if err != nil {
				return r, err
			}
			r.Input.Input.Messages = append(r.Input.Input.Messages, item)
			r.Input.ItemIDs = append(r.Input.ItemIDs, id)
		}
	}
	messages := r.Input.Input.Messages
	if r.Input.Instructions != nil {
		messages = append([]inference.Item{{Type: "message", Role: "system", Text: *r.Input.Instructions}}, messages...)
	}
	if err := inference.CheckContext(messages, r.Input.Input.Tools); err != nil {
		return r, &Error{Status: 413, Code: err.Error(), Param: "input"}
	}
	return r, nil
}

func responseItem(value any, path string) (inference.Item, string, error) {
	item := inference.Item{}
	m, ok := value.(map[string]any)
	if !ok {
		return item, "", reject("object_required", path)
	}
	kind, exists := m["type"]
	if !exists {
		kind = "message"
	}
	allowed := []string{"type", "role", "content", "id", "status"}
	switch kind {
	case "message":
		item.Type = "message"
	case "function_call":
		item.Type = "tool_call"
		allowed = []string{"type", "id", "status", "call_id", "name", "arguments"}
	case "function_call_output":
		item.Type = "tool_result"
		allowed = []string{"type", "call_id", "output"}
	default:
		return item, "", reject("unsupported_input_item", path+".type")
	}
	if _, err := fields(m, path, allowed...); err != nil {
		return item, "", err
	}
	id := ""
	var err error
	if _, ok := m["id"]; ok {
		if id, err = stringField(m, "id", path); err != nil {
			return item, "", err
		}
		if !inference.Identifier.MatchString(id) {
			return item, "", reject("invalid_item_id", path+".id")
		}
	}
	if status, ok := m["status"]; ok && status != "completed" {
		return item, "", reject("completed_item_required", path+".status")
	}
	if item.Type == "message" {
		if item.Role, err = stringField(m, "role", path); err != nil {
			return item, "", err
		}
		if item.Role != "system" && item.Role != "developer" && item.Role != "user" && item.Role != "assistant" {
			return item, "", reject("unsupported_role", path+".role")
		}
		item.Text, err = responseText(m["content"], item.Role, path+".content")
	} else {
		if item.CallID, err = stringField(m, "call_id", path); err != nil {
			return item, "", err
		}
		if !inference.Identifier.MatchString(item.CallID) {
			return item, "", reject("invalid_tool_call_id", path+".call_id")
		}
		if item.Type == "tool_result" {
			item.Output, err = stringField(m, "output", path)
		} else {
			if item.Name, err = stringField(m, "name", path); err != nil {
				return item, "", err
			}
			var arguments string
			if arguments, err = stringField(m, "arguments", path); err != nil {
				return item, "", err
			}
			if inference.Decode([]byte(arguments), &item.Arguments) != nil || item.Arguments == nil {
				return item, "", reject("invalid_function_arguments", path+".arguments")
			}
		}
	}
	return item, id, err
}

func responseText(value any, role, path string) (string, error) {
	if text, ok := value.(string); ok {
		return text, nil
	}
	parts, ok := value.([]any)
	if !ok || len(parts) == 0 {
		return "", reject("text_content_required", path)
	}
	var out strings.Builder
	for i, value := range parts {
		partPath := fmt.Sprintf("%s[%d]", path, i)
		part, err := fields(value, partPath, "type", "text", "annotations")
		if err != nil {
			return "", err
		}
		if part["type"] != "input_text" && !(role == "assistant" && part["type"] == "output_text") {
			return "", reject("text_content_only", partPath+".type")
		}
		if value, exists := part["annotations"]; exists {
			annotations, ok := value.([]any)
			if !ok || len(annotations) > 0 || part["type"] != "output_text" {
				return "", reject("annotations_unsupported", partPath+".annotations")
			}
		}
		text, err := stringField(part, "text", partPath)
		if err != nil {
			return "", err
		}
		out.WriteString(text)
	}
	return out.String(), nil
}

func responseTools(tools []inference.Tool) []any {
	result := []any{}
	for _, tool := range tools {
		result = append(result, map[string]any{"type": "function", "name": tool.Name, "description": tool.Description, "parameters": tool.Parameters, "strict": false})
	}
	return result
}

func argumentString(item *inference.Item) (string, error) {
	value, err := json.Marshal(item.Arguments)
	return string(value), err
}
