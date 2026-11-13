package inference

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestResponseViewsBoundPollingPayloadWithoutChangingSnapshots(t *testing.T) {
	instructions := "current instructions"
	r := Request{ID: "request", State: "inference", Response: &ResponseMetadata{Instructions: &instructions, Input: []Item{{Type: "message", Role: "user", Text: strings.Repeat("x", MaxContextBytes-1024)}}, ItemIDs: []string{""}, Tools: []Tool{}}}
	encoded, err := json.Marshal(r.View(true))
	if err != nil || len(encoded) > 1024 || r.View(true).Response != nil {
		t.Fatal("polling repeated admitted history", len(encoded), err)
	}
	r.Output = &Item{Type: "final", Text: "accepted"}
	view := r.View(true)
	if view.Response == nil || view.Response.Instructions == nil || *view.Response.Instructions != instructions || view.Response.Input != nil || view.Response.ItemIDs != nil {
		t.Fatal("terminal encoding metadata lost", view.Response)
	}
	if len(r.Response.Input) != 1 || len(r.Response.ItemIDs) != 1 || len(r.Response.Input[0].Text) != MaxContextBytes-1024 {
		t.Fatal("view changed durable snapshot")
	}
	if r.View(false).Output != nil || r.View(false).Response != nil {
		t.Fatal("admission view exposed terminal payload")
	}
	r.Output = nil
	for _, state := range []string{"interrupted", "cancelled"} {
		r.State = state
		if r.View(true).Response == nil {
			t.Fatal("failed lifecycle lost metadata", state)
		}
	}
}
