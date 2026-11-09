package inference

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

func fixtureTool() Tool {
	return Tool{Name: "read_file", Parameters: map[string]any{"type": "object", "properties": map[string]any{"path": map[string]any{"type": "string"}}, "required": []any{"path"}, "additionalProperties": false}}
}
func fixtureCreate() Create {
	return Create{Version: 1, SubmissionID: "create", WorkerID: "worker", Messages: []Item{{Type: "message", Role: "system", Text: "instructions"}, {Type: "message", Role: "user", Text: "read my file"}}, Tools: []Tool{fixtureTool()}}
}
func toolIntent() Item {
	return Item{Type: "tool_call", CallID: "call1", Name: "read_file", Arguments: map[string]any{"path": "fixture"}}
}

func TestStrictJSONAndItems(t *testing.T) {
	for _, body := range []string{"", `{`, `null`, `[]`, `1`, `{"x":1} {}`, `{"x":1,"x":2}`, `{"x":[{"a":1,"a":2}]}`, `{"x":[}`, `{"x":}`, `{"x":null,"unknown":1}`, "{\"x\":\"\xff\"}"} {
		var value struct {
			X any `json:"x"`
		}
		if err := Decode([]byte(body), &value); err == nil {
			t.Fatalf("accepted invalid input %q", body)
		}
	}
	var v struct {
		X any `json:"x"`
	}
	if err := Decode([]byte(`{"x":[1,{"ok":true}]}`), &v); err != nil {
		t.Fatal(err)
	}
	for _, m := range []Item{{Type: "message", Role: "user", Text: ""}, toolIntent(), {Type: "tool_call", CallID: "empty", Name: "empty", Arguments: map[string]any{}}, {Type: "tool_result", CallID: "call1", Output: ""}, {Type: "final", Text: ""}} {
		data, err := json.Marshal(m)
		if err != nil {
			t.Fatal(err)
		}
		var got Item
		if err = Decode(data, &got); err != nil {
			t.Fatal(err)
		}
		reencoded, err := json.Marshal(got)
		if err != nil || string(reencoded) != string(data) {
			t.Fatal("item changed on persistence round trip")
		}
	}
	for _, body := range []string{`null`, `[]`, `{}`, `{"type":1}`, `{"type":"media"}`, `{"type":"final"}`, `{"type":"final","text":null}`, `{"type":"final","text":1}`, `{"type":"final","text":"x","role":""}`, `{"type":"message","text":"x","role":"user","unknown":null}`} {
		var m Item
		if json.Unmarshal([]byte(body), &m) == nil {
			t.Fatalf("invalid item admitted: %s", body)
		}
	}
	if _, err := Hash(make(chan int)); err == nil {
		t.Fatal("unencodable hash succeeded")
	}
	if _, err := json.Marshal(Item{Type: "invalid", Arguments: map[string]any{"x": make(chan int)}}); err == nil {
		t.Fatal("unencodable item succeeded")
	}
}

func TestDraft2020OfflineValidation(t *testing.T) {
	testTool := fixtureTool()
	testTool.Parameters = map[string]any{"$schema": "https://json-schema.org/draft/2020-12/schema", "type": "object", "$defs": map[string]any{"p": map[string]any{"type": "integer", "minimum": json.Number("9007199254740993")}}, "properties": map[string]any{"$ref": map[string]any{"type": "string"}, "n": map[string]any{"$ref": "#/$defs/p"}}, "required": []any{"n"}, "additionalProperties": false}
	s, err := Compile(testTool)
	if err != nil {
		t.Fatal(err)
	}
	if err = s.Validate(map[string]any{"n": json.Number("9007199254740993"), "$ref": "ordinary field"}); err != nil {
		t.Fatal(err)
	}
	if s.Validate(map[string]any{"n": json.Number("9007199254740992")}) == nil {
		t.Fatal("numeric precision lost")
	}
	for _, schema := range []map[string]any{
		{"$ref": "https://invalid.example/schema"}, {"$ref": "file:///private/schema"}, {"$dynamicRef": "other.json"}, {"$ref": 42}, {"$schema": "http://json-schema.org/draft-07/schema"}, {"type": "not_a_type"}, {"properties": map[string]any{"p": map[string]any{"$ref": "remote"}}}, {"items": map[string]any{"$ref": "remote"}}, {"allOf": []any{map[string]any{"$ref": "remote"}}},
	} {
		testTool.Parameters = schema
		if _, err = Compile(testTool); err == nil {
			t.Fatal("unsupported/invalid schema accepted")
		}
	}
	for _, tool := range []Tool{{Name: "invalid name", Parameters: map[string]any{}}, {Name: "valid"}} {
		if _, err := Compile(tool); err == nil {
			t.Fatal("invalid definition accepted")
		}
	}
	if _, err := (noResources{}).Load("file:///private"); err == nil {
		t.Fatal("external loader enabled")
	}
	if err := localSchema(map[string]any{"allOf": []any{true, map[string]any{}}}); err != nil {
		t.Fatal(err)
	}
}

func TestCreateAndDecisionValidation(t *testing.T) {
	c := fixtureCreate()
	if err := ValidateCreate(&c); err != nil || c.TimeoutSeconds != 300 {
		t.Fatal("defaults/valid context failed")
	}
	c.Messages = append(c.Messages, toolIntent(), Item{Type: "tool_result", CallID: "call1", Output: "client result"}, Item{Type: "message", Role: "assistant", Text: "done"})
	if err := ValidateCreate(&c); err != nil {
		t.Fatal(err)
	}
	for _, edit := range []func(*Create){
		func(c *Create) { c.Version = 2 }, func(c *Create) { c.SubmissionID = "!" }, func(c *Create) { c.WorkerID = "" }, func(c *Create) { c.Messages = nil }, func(c *Create) { c.TimeoutSeconds = -1 }, func(c *Create) { c.TimeoutSeconds = 3601 }, func(c *Create) { c.Tools = append(c.Tools, c.Tools[0]) }, func(c *Create) { c.Tools[0].Name = "bad name" }, func(c *Create) { c.Messages[0].Role = "media" }, func(c *Create) { c.Messages = append(c.Messages, toolIntent()) }, func(c *Create) { c.Messages = append(c.Messages, Item{Type: "tool_result", CallID: "missing"}) }, func(c *Create) { c.Messages[0].Type = "image" }, func(c *Create) { c.Messages = append(c.Messages, toolIntent(), toolIntent()) }, func(c *Create) {
			c.Messages = append(c.Messages, toolIntent(), Item{Type: "message", Role: "user", Text: "bad"})
		},
	} {
		c := fixtureCreate()
		edit(&c)
		if ValidateCreate(&c) == nil {
			t.Fatal("invalid context accepted")
		}
	}
	for _, edit := range []func(*Item){
		func(d *Item) { d.Name = "unknown" }, func(d *Item) { d.Arguments = map[string]any{"path": 12} }, func(d *Item) { d.Arguments = nil }, func(d *Item) { d.Role = "assistant" }, func(d *Item) { d.CallID = "" },
	} {
		d := toolIntent()
		edit(&d)
		if ValidateDecision(d, []Tool{fixtureTool()}) == nil {
			t.Fatal("invalid decision accepted")
		}
	}
	if ValidateDecision(toolIntent(), []Tool{fixtureTool()}) != nil || ValidateDecision(Item{Type: "final", Text: "done"}, nil) != nil {
		t.Fatal("valid decision failed")
	}
	if ValidateDecision(Item{Type: "final", Role: "assistant"}, nil) == nil {
		t.Fatal("extra final fields accepted")
	}
	if ValidateDecision(toolIntent(), []Tool{{Name: "read_file", Parameters: map[string]any{"type": "invalid"}}}) == nil {
		t.Fatal("broken stored schema ignored")
	}
	if CheckContext([]Item{{Type: "message", Text: strings.Repeat("x", MaxContextBytes)}}, nil) == nil {
		t.Fatal("oversized context accepted")
	}
	if CheckContext([]Item{{Type: "invalid", Arguments: map[string]any{"bad": make(chan int)}}}, nil) == nil {
		t.Fatal("unencodable context accepted")
	}
	c = fixtureCreate()
	c.Messages = append(c.Messages, toolIntent(), Item{Type: "tool_result", CallID: "wrong"})
	if ValidateCreate(&c) == nil {
		t.Fatal("wrong call result accepted")
	}
	c = fixtureCreate()
	c.Messages = append(c.Messages, toolIntent(), Item{Type: "tool_result", CallID: "call1"}, toolIntent())
	if ValidateCreate(&c) == nil {
		t.Fatal("duplicate call accepted")
	}
}

func TestConnectionAndTerminalStates(t *testing.T) {
	now := time.Now()
	c := Connection{}
	if c.Status(now) != "not_observed" {
		t.Fatal("invented connection")
	}
	c.ID = "id"
	if c.Status(now) != "offline" {
		t.Fatal("disconnected online")
	}
	c.Connected = true
	c.OpenedAt = now
	if c.Status(now) != "connecting" || c.Status(now.Add(HealthWindow)) != "offline" {
		t.Fatal("initial health window invalid")
	}
	c.LastAckAt = &now
	if c.Status(now) != "online" || c.Status(now.Add(HealthWindow)) != "offline" {
		t.Fatal("health expiry invalid")
	}
	for _, state := range []string{"completed", "cancelled", "interrupted"} {
		if !(Experiment{State: state}).Terminal() {
			t.Fatal("terminal state not recognized")
		}
	}
	if (Experiment{State: "waiting_for_tool"}).Terminal() {
		t.Fatal("tool wait terminal")
	}
	e := Reject("test", 409, "expected", 1).(*Rejection)
	if e.Error() != "test" || e.Fields["expected"] != 1 {
		t.Fatal("rejection context lost")
	}
}

func TestExactStructuralFieldsAndSchemaLocations(t *testing.T) {
	for _, body := range []string{
		`{"protocol_version":1,"submission_id":"id","worker_id":"worker","messages":[],"tools":[],"TIMEOUT_SECONDS":1}`,
		`{"protocol_version":1,"submission_id":"id","worker_id":"worker","messages":[],"tools":[],"timeout_seconds":300,"TIMEOUT_SECONDS":1}`,
		`{"tools":[{"name":"read_file","Name":"other","parameters":{}}]}`,
		`{"context_probe":{"kind":"full","Kind":"delta"}}`,
		`{"messages":[{"type":"message","role":"user","TEXT":"x"}]}`,
	} {
		var c Create
		if Decode([]byte(body), &c) == nil {
			t.Fatal("case alias accepted", body)
		}
	}
	var submit Submit
	if Decode([]byte(`{"protocol_version":1,"Connection_id":"alias"}`), &submit) == nil {
		t.Fatal("embedded field alias accepted")
	}
	var c Create
	if Decode([]byte(`{"protocol_version":1,"submission_id":"id","worker_id":"worker","messages":[{"type":"message","role":"user","text":"x"}],"tools":[{"name":"read_file","parameters":{"type":"object","properties":{"UPPER_FIELD":{"type":"string"}}}}]}`), &c) != nil {
		t.Fatal("arbitrary schema property rejected")
	}
	tool := Tool{Name: "read_file", Parameters: map[string]any{"type": "object", "$defs": map[string]any{"path": map[string]any{"type": "string"}}, "properties": map[string]any{"path": map[string]any{"$ref": "#/$defs/path"}}}}
	err := ValidateDecision(Item{Type: "tool_call", CallID: "call", Name: "read_file", Arguments: map[string]any{"path": 1}}, []Tool{tool})
	var rejected *Rejection
	if !errors.As(err, &rejected) {
		t.Fatal("expected schema rejection")
	}
	evidence, err := json.Marshal(rejected.Fields["schema_validation"])
	if err != nil || !strings.Contains(string(evidence), `"instanceLocation":"/path"`) || !strings.Contains(string(evidence), "#/$defs/path/type") {
		t.Fatal("instance/reference schema locations missing", string(evidence))
	}
}
