package inference

import (
	"encoding/base64"
	"testing"
	"time"
)

func TestHistoryCursorIdentityAndBounds(t *testing.T) {
	now := time.Date(2026, 11, 11, 12, 0, 0, 0, time.UTC)
	q := HistoryQuery{Kind: "requests", ConversationID: "conversation"}
	c := PageCursor{Kind: q.Kind, ConversationID: q.ConversationID, ID: "record", Time: now}
	encoded, err := EncodeCursor(c)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := DecodeCursor(encoded, q)
	if err != nil || decoded != c {
		t.Fatal("cursor lost identity", err)
	}
	for _, changed := range []PageCursor{
		{Kind: "conversations", ConversationID: q.ConversationID, ID: "record", Time: now},
		{Kind: q.Kind, ConversationID: "foreign", ID: "record", Time: now},
		{Kind: q.Kind, ConversationID: q.ConversationID, ID: "bad id", Time: now},
		{Kind: q.Kind, ConversationID: q.ConversationID, ID: "record", Time: now, Sequence: -1},
		{Kind: q.Kind, ConversationID: q.ConversationID, ID: "record"},
	} {
		value, _ := EncodeCursor(changed)
		if _, err = DecodeCursor(value, q); err == nil {
			t.Fatal("accepted foreign/malformed cursor")
		}
	}
	for _, value := range []string{"%", base64.RawURLEncoding.EncodeToString([]byte(`{"kind":"requests","extra":true}`)), string(make([]byte, 1025))} {
		if _, err = DecodeCursor(value, q); err == nil {
			t.Fatal("accepted invalid cursor")
		}
	}
	q = HistoryQuery{Kind: "timeline", ID: "conversation"}
	c = PageCursor{Kind: q.Kind, ID: q.ID, Sequence: 4}
	encoded, _ = EncodeCursor(c)
	if _, err = DecodeCursor(encoded, q); err != nil {
		t.Fatal(err)
	}
	q.ID = "foreign"
	if _, err = DecodeCursor(encoded, q); err == nil {
		t.Fatal("timeline cursor crossed conversations")
	}
	invalid := PageCursor{Time: time.Date(10000, 1, 1, 0, 0, 0, 0, time.UTC)}
	if _, err = EncodeCursor(invalid); err == nil {
		t.Fatal("unencodable cursor ignored")
	}
}

func TestCanonicalProjectionAndClientView(t *testing.T) {
	c := &Conversation{Items: []HistoryItem{{Sequence: 0, Item: Item{Type: "message", Role: "user", Text: "u\n"}}, {Sequence: 1, Item: Item{Type: "message", Role: "assistant", Text: "a\n"}}}}
	if got := Messages(c, 1); len(got) != 1 || got[0].Text != "u\n" {
		t.Fatal("request boundary lost")
	}
	r := &Request{ID: "request", Output: &Item{Type: "final", Text: "answer"}, ClientID: "private-owner", Input: RequestInput{SubmissionID: "private-input"}}
	if r.View(false).Output != nil || r.View(true).Output.Text != "answer" {
		t.Fatal("admission/read disclosure boundary incorrect")
	}
}
