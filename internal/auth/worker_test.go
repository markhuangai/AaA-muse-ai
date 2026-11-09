package auth

import (
	"bytes"
	"encoding/hex"
	"strings"
	"testing"
)

func TestWorkerTokenFormatsAndDigests(t *testing.T) {
	for _, prefix := range []string{EnrollmentPrefix, WorkerPrefix} {
		token, err := Token(prefix, bytes.NewReader(make([]byte, 32)))
		if err != nil || !ValidToken(token, prefix) || ValidToken(token+"x", prefix) || ValidToken("wrong"+token, prefix) {
			t.Fatal("token scope/length failed")
		}
		for _, invalid := range []string{prefix + strings.Repeat("!", 43), prefix + strings.Repeat("A", 42) + "B"} {
			if ValidToken(invalid, prefix) {
				t.Fatal("malformed or noncanonical token accepted")
			}
		}
		if _, err := Token(prefix, bytes.NewReader(nil)); err == nil {
			t.Fatal("entropy failure hidden")
		}
	}
	digest := Digest("abc")
	if hex.EncodeToString(digest[:]) != "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" {
		t.Fatal("credential digest incorrect")
	}
}
