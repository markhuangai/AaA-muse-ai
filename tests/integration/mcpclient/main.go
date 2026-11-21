//go:build mcp_integration

// The media integration harness drives this client over a private stdin/stdout pipe.
package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"sync"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type input struct {
	Endpoint  string         `json:"endpoint"`
	Cert      string         `json:"cert"`
	Key       string         `json:"key"`
	Tool      string         `json:"tool"`
	Arguments map[string]any `json:"arguments"`
}

type authenticatedTransport struct {
	transport http.RoundTripper
	key       string
	mu        sync.Mutex
	requestID string
}

func (t *authenticatedTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	secured := req.Clone(req.Context())
	secured.Header.Set("Authorization", "Bearer "+t.key)
	response, err := t.transport.RoundTrip(secured)
	if err == nil && response.StatusCode != http.StatusAccepted {
		t.mu.Lock()
		t.requestID = response.Header.Get("X-Request-Id")
		t.mu.Unlock()
	}
	return response, err
}

func run() (any, error) {
	var in input
	if err := json.NewDecoder(os.Stdin).Decode(&in); err != nil {
		return nil, err
	}
	pem, err := os.ReadFile(in.Cert)
	if err != nil {
		return nil, err
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(pem) {
		return nil, errors.New("invalid private TLS fixture")
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.TLSClientConfig = &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12}
	client := mcp.NewClient(&mcp.Implementation{Name: "aaa-muse-media-integration", Version: "1"}, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 325*time.Second)
	defer cancel()
	authenticated := &authenticatedTransport{transport: transport, key: in.Key}
	session, err := client.Connect(ctx, &mcp.StreamableClientTransport{
		Endpoint: in.Endpoint, HTTPClient: &http.Client{Transport: authenticated},
		MaxRetries: -1, DisableStandaloneSSE: true,
	}, nil)
	if err != nil {
		return nil, err
	}
	defer session.Close()
	var result any
	if in.Tool == "" {
		result, err = session.ListTools(ctx, nil)
	} else {
		result, err = session.CallTool(ctx, &mcp.CallToolParams{Name: in.Tool, Arguments: in.Arguments})
	}
	authenticated.mu.Lock()
	defer authenticated.mu.Unlock()
	return struct {
		RequestID string `json:"request_id"`
		Result    any    `json:"result"`
	}{authenticated.requestID, result}, err
}

func main() {
	result, err := run()
	if err != nil {
		_, _ = os.Stderr.WriteString("Controlled MCP exchange failed.\n")
		os.Exit(1)
	}
	if json.NewEncoder(os.Stdout).Encode(result) != nil {
		os.Exit(1)
	}
}
