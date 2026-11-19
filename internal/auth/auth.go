package auth

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"io"
	"maps"
	"strings"

	"github.com/markhuangai/AaA-muse-ai/internal/config"
)

func ManagementKey(c *config.Config, random io.Reader) (bool, error) {
	if c.Management.Key != "" {
		return false, nil
	}
	b := make([]byte, 32)
	if _, err := io.ReadFull(random, b); err != nil {
		return false, errors.New("management_key_generation_failed")
	}
	c.Management.Key = config.Secret(base64.RawURLEncoding.EncodeToString(b))
	return true, c.Validate()
}

func ID(random io.Reader) (string, error) {
	b := make([]byte, 16)
	if _, err := io.ReadFull(random, b); err != nil {
		return "", errors.New("identifier_generation_failed")
	}
	return hex.EncodeToString(b), nil
}

type Authority struct {
	management    []byte
	portal        [32]byte
	portalEnabled bool
	clientKeys    func() map[string]config.Secret
}

func New(c config.Config) *Authority {
	c.ClientKeys = maps.Clone(c.ClientKeys)
	return NewWithConfiguration(func() *config.Config { return &c })
}

func NewWithConfiguration(current func() *config.Config) *Authority {
	c := current()
	return &Authority{
		management: []byte(c.Management.Key), portal: sha256.Sum256([]byte(c.Portal.Password)),
		portalEnabled: c.Portal.Password != "", clientKeys: func() map[string]config.Secret { return current().ClientKeys },
	}
}

func (a *Authority) HasClient(name string) bool { _, ok := a.clientKeys()[name]; return ok }

func (a *Authority) Role(header string) string {
	role, _ := a.Identity(header)
	return role
}

func (a *Authority) Identity(header string) (string, string) {
	if !strings.HasPrefix(header, "Bearer ") {
		return "unauthenticated", ""
	}
	value := strings.TrimPrefix(header, "Bearer ")
	if value == "" || strings.ContainsAny(value, " \t\r\n") {
		return "unauthenticated", ""
	}
	credential := []byte(value)
	if subtle.ConstantTimeCompare(credential, a.management) == 1 {
		return "management", ""
	}
	for name, client := range a.clientKeys() {
		if subtle.ConstantTimeCompare(credential, []byte(client)) == 1 {
			return "client", name
		}
	}
	return "unauthenticated", ""
}

func (a *Authority) PortalPassword(password string) bool {
	digest := sha256.Sum256([]byte(password))
	return subtle.ConstantTimeCompare(digest[:], a.portal[:]) == 1 && a.portalEnabled
}

func (a *Authority) Reserved(credential string) bool {
	return a.PortalPassword(credential) || a.Role("Bearer "+credential) != "unauthenticated"
}
