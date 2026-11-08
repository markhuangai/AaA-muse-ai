package auth

import (
	"crypto/sha256"
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
	management, portal [32]byte
	clients            [][32]byte
}

func New(c config.Config) *Authority {
	a := &Authority{management: sha256.Sum256([]byte(c.Management.Key)), portal: sha256.Sum256([]byte(c.Portal.Password))}
	for _, key := range c.ClientKeys {
		a.clients = append(a.clients, sha256.Sum256([]byte(key)))
	}
	return a
}

func (a *Authority) Role(header string) string {
	if !strings.HasPrefix(header, "Bearer ") {
		return "unauthenticated"
	}
	value := strings.TrimPrefix(header, "Bearer ")
	if value == "" || strings.ContainsAny(value, " \t\r\n") {
		return "unauthenticated"
	}
	h := sha256.Sum256([]byte(value))
	if subtle.ConstantTimeCompare(h[:], a.management[:]) == 1 {
		return "management"
	}
	if subtle.ConstantTimeCompare(h[:], a.portal[:]) == 1 {
		return "portal"
	}
	for _, client := range a.clients {
		if subtle.ConstantTimeCompare(h[:], client[:]) == 1 {
			return "client"
		}
	}
	return "unauthenticated"
}
