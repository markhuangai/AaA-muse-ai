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
	for header, want := range map[string]string{"": "unauthenticated", "Basic admin-fixture": "unauthenticated", "Bearer ": "unauthenticated", "Bearer wrong": "unauthenticated", "Bearer admin-fixture extra": "unauthenticated", "Bearer admin-fixture": "management", "Bearer portal-fixture": "unauthenticated", "Bearer client-fixture": "client"} {
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

func TestCredentialComparisonRequiresExactValue(t *testing.T) {
	c := authConfig()
	c.Management.Key = "management-key"
	c.Portal.Password = "portal-password-with-a-different-length"
	c.ClientKeys = map[string]config.Secret{"first": "client", "second": "another-client-key"}
	a := New(c)
	for value, role := range map[string]string{
		string(c.Management.Key): "management", string(c.Portal.Password): "unauthenticated",
		"client": "client", "another-client-key": "client",
	} {
		if a.Role("Bearer "+value) != role {
			t.Fatalf("exact credential did not identify %s", role)
		}
		for _, wrong := range []string{value[:len(value)-1], value + "x", "x" + value[1:]} {
			if a.Role("Bearer "+wrong) != "unauthenticated" {
				t.Fatal("accepted a partial or changed credential")
			}
		}
	}
}

func TestPortalPasswordIsLoginOnlyAndExact(t *testing.T) {
	c := authConfig()
	a := New(c)
	if !a.PortalPassword(string(c.Portal.Password)) || a.Role("Bearer "+string(c.Portal.Password)) != "unauthenticated" {
		t.Fatal("portal password crossed the bearer boundary")
	}
	for _, value := range []string{"", "portal", "portal-fixture-extra", string(c.Management.Key), string(c.ClientKeys["local"])} {
		if a.PortalPassword(value) {
			t.Fatal("non-password credential authenticated portal login")
		}
	}
	c.Portal.Password = ""
	if New(c).PortalPassword("") {
		t.Fatal("empty portal password was enabled")
	}
	if !a.Reserved("portal-fixture") || !a.Reserved("admin-fixture") || !a.Reserved("client-fixture") || a.Reserved("unreserved") {
		t.Fatal("credential collision reservation changed")
	}
}
