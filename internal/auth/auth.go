package auth

import (
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"io"
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
	management, portal []byte
	clients            map[string][]byte
}

func New(c config.Config) *Authority {
	a := &Authority{management: []byte(c.Management.Key), portal: []byte(c.Portal.Password), clients: map[string][]byte{}}
	for name, key := range c.ClientKeys {
		a.clients[name] = []byte(key)
	}
	return a
}

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
	if subtle.ConstantTimeCompare(credential, a.portal) == 1 {
		return "portal", ""
	}
	for name, client := range a.clients {
		if subtle.ConstantTimeCompare(credential, client) == 1 {
			return "client", name
		}
	}
	return "unauthenticated", ""
}
