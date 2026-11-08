package auth

import (
	"bytes"
	"encoding/base64"
	"strings"
	"testing"

	"github.com/markhuangai/AaA-muse-ai/internal/config"
)

func authConfig() config.Config {
	c := config.Defaults()
	c.Server.PublicURL = "https://example.test"
	c.Database.URL = "postgres://db/muse"
	c.Portal.Password = "portal-fixture"
	c.Management.Key = "admin-fixture"
	c.ClientKeys = map[string]config.Secret{"local": "client-fixture"}
	return c
}

func TestCredentialRoles(t *testing.T) {
	c := authConfig()
	a := New(c)
	for header, want := range map[string]string{"": "unauthenticated", "Basic admin-fixture": "unauthenticated", "Bearer ": "unauthenticated", "Bearer wrong": "unauthenticated", "Bearer admin-fixture extra": "unauthenticated", "Bearer admin-fixture": "management", "Bearer portal-fixture": "portal", "Bearer client-fixture": "client"} {
		if got := a.Role(header); got != want {
			t.Fatalf("expected role %s, got %s", want, got)
		}
	}
	generated, err := ManagementKey(&c, bytes.NewReader(nil))
	if err != nil || generated || c.Management.Key != "admin-fixture" {
		t.Fatal("configured key changed")
	}
	c.Management.Key = ""
	generated, err = ManagementKey(&c, bytes.NewReader(bytes.Repeat([]byte{17}, 32)))
	if err != nil || !generated {
		t.Fatal("generation failed")
	}
	b, err := base64.RawURLEncoding.DecodeString(string(c.Management.Key))
	if err != nil || len(b) != 32 {
		t.Fatal("key does not contain 256 bits")
	}
	c.Management.Key = ""
	if _, err = ManagementKey(&c, strings.NewReader("short")); err == nil {
		t.Fatal("accepted failed entropy")
	}
	c.Management.Key = ""
	c.Portal.Password = config.Secret(base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{17}, 32)))
	if _, err = ManagementKey(&c, bytes.NewReader(bytes.Repeat([]byte{17}, 32))); err == nil {
		t.Fatal("generated key reused portal authority")
	}
	if id, err := ID(bytes.NewReader(make([]byte, 16))); err != nil || len(id) != 32 {
		t.Fatal("identifier failed")
	}
	if _, err := ID(bytes.NewReader(nil)); err == nil {
		t.Fatal("accepted failed identifier entropy")
	}
}
