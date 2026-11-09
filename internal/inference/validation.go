package inference

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"reflect"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/santhosh-tekuri/jsonschema/v6"
)

var Identifier = regexp.MustCompile(`^[A-Za-z0-9_-]{1,100}$`)
var toolName = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_.-]{0,63}$`)

func Decode(data []byte, out any) error {
	if !utf8.Valid(data) {
		return Reject("invalid_json", 400)
	}
	d := json.NewDecoder(bytes.NewReader(data))
	d.UseNumber()
	if err := unique(d); err != nil {
		return Reject("invalid_or_duplicate_json", 400)
	}
	if _, err := d.Token(); !errors.Is(err, io.EOF) {
		return Reject("single_json_value_required", 400)
	}
	var value any
	d = json.NewDecoder(bytes.NewReader(data))
	d.UseNumber()
	if err := d.Decode(&value); err != nil {
		return Reject("invalid_json", 400)
	}
	if err := exactFields(value, reflect.TypeOf(out)); err != nil {
		return err
	}
	d = json.NewDecoder(bytes.NewReader(data))
	d.UseNumber()
	d.DisallowUnknownFields()
	if err := d.Decode(out); err != nil {
		return Reject("unsupported_or_invalid_fields", 400)
	}
	if len(bytes.TrimSpace(data)) == 0 || bytes.TrimSpace(data)[0] != '{' {
		return Reject("json_object_required", 400)
	}
	return nil
}

func unique(d *json.Decoder) error {
	t, err := d.Token()
	if err != nil {
		return err
	}
	if delim, ok := t.(json.Delim); ok {
		switch delim {
		case '{':
			seen := map[string]bool{}
			for d.More() {
				key, err := d.Token()
				if err != nil {
					return err
				}
				name, ok := key.(string)
				if !ok || seen[name] {
					return errors.New("duplicate_field")
				}
				seen[name] = true
				if err = unique(d); err != nil {
					return err
				}
			}
		case '[':
			for d.More() {
				if err = unique(d); err != nil {
					return err
				}
			}
		default:
			return errors.New("invalid_delimiter")
		}
		_, err = d.Token()
	}
	return err
}

func Hash(v any) (string, error) {
	b, err := json.Marshal(v)
	if err != nil {
		return "", err
	}
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:]), nil
}

func VersionAndID(version int, id string) error {
	if version != Version {
		return Reject("unsupported_protocol_version", 400)
	}
	if !Identifier.MatchString(id) {
		return Reject("invalid_submission_id", 400)
	}
	return nil
}

type noResources struct{}

func (noResources) Load(string) (any, error) {
	return nil, errors.New("external_schema_resource_forbidden")
}

func Compile(tool Tool) (*jsonschema.Schema, error) {
	if !toolName.MatchString(tool.Name) || tool.Parameters == nil {
		return nil, Reject("invalid_tool_definition", 400, "tool", tool.Name)
	}
	if err := localSchema(tool.Parameters); err != nil {
		return nil, err
	}
	c := jsonschema.NewCompiler()
	c.DefaultDraft(jsonschema.Draft2020)
	c.UseLoader(noResources{})
	if err := c.AddResource("urn:muse:tool", tool.Parameters); err != nil {
		return nil, err
	}
	s, err := c.Compile("urn:muse:tool")
	if err != nil {
		return nil, Reject("invalid_tool_schema", 400, "tool", tool.Name, "schema_error", err.Error())
	}
	return s, nil
}

func localSchema(v any) error {
	switch v := v.(type) {
	case map[string]any:
		for k, x := range v {
			if k == "$ref" || k == "$dynamicRef" {
				s, ok := x.(string)
				if !ok || !strings.HasPrefix(s, "#") {
					return Reject("external_schema_reference_forbidden", 400)
				}
			}
			if k == "$schema" && x != "https://json-schema.org/draft/2020-12/schema" {
				return Reject("unsupported_schema_draft", 400)
			}
			switch k {
			case "$defs", "definitions", "properties", "patternProperties", "dependentSchemas":
				if children, ok := x.(map[string]any); ok {
					for _, child := range children {
						if err := localSchema(child); err != nil {
							return err
						}
					}
				}
			case "items", "additionalProperties", "unevaluatedProperties", "unevaluatedItems", "contains", "propertyNames", "not", "if", "then", "else", "contentSchema", "allOf", "anyOf", "oneOf", "prefixItems":
				if err := localSchema(x); err != nil {
					return err
				}
			}
		}
	case []any:
		for _, x := range v {
			if err := localSchema(x); err != nil {
				return err
			}
		}
	}
	return nil
}

func CheckContext(messages []Item, tools []Tool) error {
	b, err := json.Marshal(struct {
		Messages []Item `json:"messages"`
		Tools    []Tool `json:"tools"`
	}{messages, tools})
	if err != nil {
		return err
	}
	if len(b) > MaxContextBytes {
		return Reject("context_too_large", 413, "context_bytes", len(b), "max_context_bytes", MaxContextBytes)
	}
	return nil
}

func ValidateCreate(c *Create) error {
	if err := VersionAndID(c.Version, c.SubmissionID); err != nil {
		return err
	}
	if !Identifier.MatchString(c.WorkerID) || len(c.Messages) == 0 {
		return Reject("worker_and_messages_required", 400)
	}
	if c.TimeoutSeconds == 0 {
		c.TimeoutSeconds = 300
	}
	if c.TimeoutSeconds < 1 || c.TimeoutSeconds > 3600 {
		return Reject("invalid_timeout", 400)
	}
	tools := map[string]Tool{}
	for _, t := range c.Tools {
		if _, ok := tools[t.Name]; ok {
			return Reject("duplicate_tool_name", 400)
		}
		if _, err := Compile(t); err != nil {
			return err
		}
		tools[t.Name] = t
	}
	pending := ""
	calls := map[string]bool{}
	for _, m := range c.Messages {
		switch m.Type {
		case "message":
			if pending != "" || (m.Role != "system" && m.Role != "developer" && m.Role != "user" && m.Role != "assistant") || m.CallID != "" || m.Name != "" || m.Arguments != nil || m.Output != "" {
				return Reject("invalid_message", 400)
			}
		case "tool_call":
			if pending != "" || calls[m.CallID] {
				return Reject("invalid_tool_linkage", 400)
			}
			if err := ValidateDecision(m, c.Tools); err != nil {
				return err
			}
			pending = m.CallID
			calls[m.CallID] = true
		case "tool_result":
			if pending == "" || m.CallID != pending || m.Role != "" || m.Text != "" || m.Name != "" || m.Arguments != nil {
				return Reject("invalid_tool_linkage", 400)
			}
			pending = ""
		default:
			return Reject("unsupported_history_item", 400)
		}
	}
	if pending != "" {
		return Reject("unresolved_initial_tool_call", 400)
	}
	return CheckContext(c.Messages, c.Tools)
}

func ValidateDecision(d Item, tools []Tool) error {
	if d.Type == "final" {
		if d.Role != "" || d.CallID != "" || d.Name != "" || d.Arguments != nil || d.Output != "" {
			return Reject("invalid_final_decision", 400)
		}
		return nil
	}
	if d.Type != "tool_call" || !Identifier.MatchString(d.CallID) || !toolName.MatchString(d.Name) || d.Arguments == nil || d.Role != "" || d.Text != "" || d.Output != "" {
		return Reject("invalid_tool_decision", 400)
	}
	for _, t := range tools {
		if t.Name != d.Name {
			continue
		}
		s, err := Compile(t)
		if err != nil {
			return err
		}
		if err = s.Validate(d.Arguments); err != nil {
			fields := []any{"tool", d.Name, "schema_error", err.Error()}
			var validation *jsonschema.ValidationError
			if errors.As(err, &validation) {
				fields = append(fields, "schema_validation", validation.BasicOutput())
			}
			return Reject("invalid_tool_arguments", 400, fields...)
		}
		return nil
	}
	return Reject("unknown_tool", 400, "tool", d.Name)
}
