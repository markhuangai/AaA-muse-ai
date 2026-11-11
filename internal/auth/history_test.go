package auth

import (
	"github.com/markhuangai/AaA-muse-ai/internal/config"
	"testing"
)

func TestNamedClientIdentitySurvivesKeyRotation(t *testing.T) {
	c := config.Defaults()
	c.Management.Key = "administrator"
	c.Portal.Password = "portal"
	c.ClientKeys = map[string]config.Secret{"stable-client": "first-key"}
	a := New(c)
	if role, name := a.Identity("Bearer first-key"); role != "client" || name != "stable-client" {
		t.Fatal("named identity discarded")
	}
	c.ClientKeys["stable-client"] = "rotated-key"
	a = New(c)
	if role, name := a.Identity("Bearer rotated-key"); role != "client" || name != "stable-client" {
		t.Fatal("rotation changed owner")
	}
	if a.Role("Bearer first-key") != "unauthenticated" {
		t.Fatal("removed key retained authority")
	}
}
