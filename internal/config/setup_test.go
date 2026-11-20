package config

import (
	"errors"
	"strings"
	"testing"
)

func TestLegacyDatabaseIsRejectedBeforeResolvingSecrets(t *testing.T) {
	source := fixture + "\ndatabase:\n  url: postgres://owner:obsolete-secret@db/broker\n  password: \x24{OLD_DATABASE_PASSWORD}\n"
	_, err := Parse([]byte(source), func(name string) (string, bool) {
		t.Fatalf("legacy configuration resolved %s", name)
		return "", false
	})
	var rejected *Error
	if !errors.As(err, &rejected) || rejected.Field != "database" || rejected.Reason != "legacy_database_configuration_remove_section" || rejected.Line == 0 || strings.Contains(err.Error(), "obsolete-secret") {
		t.Fatal("legacy configuration lost its safe rejection", err)
	}
}

func TestRemovedWorkerConfiguration(t *testing.T) {
	_, err := Parse([]byte(fixture+"\nworker:\n  version: 0.1.0\n"), absent)
	var rejected *Error
	if !errors.As(err, &rejected) || rejected.Reason != "unknown_field" {
		t.Fatal("removed worker version override accepted", err)
	}
}
