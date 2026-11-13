package auth

import (
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"io"
	"strings"
)

const EnrollmentPrefix = "muse_enroll_"
const WorkerPrefix = "muse_worker_"
const PortalPrefix = "muse_portal_"

func Token(prefix string, random io.Reader) (string, error) {
	b := make([]byte, 32)
	if _, err := io.ReadFull(random, b); err != nil {
		return "", errors.New("worker_token_generation_failed")
	}
	return prefix + base64.RawURLEncoding.EncodeToString(b), nil
}

func ValidToken(value, prefix string) bool {
	if !strings.HasPrefix(value, prefix) || len(value) != len(prefix)+43 {
		return false
	}
	b, err := base64.RawURLEncoding.Strict().DecodeString(value[len(prefix):])
	return err == nil && len(b) == 32
}

func Digest(value string) [32]byte { return sha256.Sum256([]byte(value)) }
