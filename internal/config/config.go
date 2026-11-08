package config

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/url"
	"reflect"
	"regexp"
	"strconv"
	"strings"

	"go.yaml.in/yaml/v3"
)

const DefaultPath = "/etc/aaa-muse-ai/config.yaml"

type Secret string

func (Secret) String() string               { return "[REDACTED]" }
func (Secret) LogValue() slog.Value         { return slog.StringValue("[REDACTED]") }
func (Secret) MarshalJSON() ([]byte, error) { return json.Marshal("[REDACTED]") }

type Config struct {
	Server struct {
		Listen    string `yaml:"listen" json:"listen"`
		PublicURL string `yaml:"public-url" json:"public_url"`
	} `yaml:"server" json:"server"`
	Database struct {
		URL Secret `yaml:"url" json:"url"`
	} `yaml:"database" json:"database"`
	Management struct {
		Key Secret `yaml:"key" json:"key"`
	} `yaml:"management" json:"management"`
	Portal struct {
		Password Secret `yaml:"password" json:"password"`
	} `yaml:"control-portal" json:"control_portal"`
	ClientKeys map[string]Secret `yaml:"client-keys" json:"client_keys"`
	Limits     struct {
		MaxWorkers int `yaml:"max-workers" json:"max_workers"`
		MaxJobs    int `yaml:"max-jobs" json:"max_jobs"`
		InFlight   int `yaml:"in-flight-per-worker" json:"in_flight_per_worker"`
	} `yaml:"limits" json:"limits"`
	Diagnostics struct {
		Level         string `yaml:"level" json:"level"`
		Directory     string `yaml:"directory" json:"directory"`
		RetentionDays int    `yaml:"retention-days" json:"retention_days"`
		MaxBytes      int64  `yaml:"max-bytes" json:"max_bytes"`
	} `yaml:"diagnostics" json:"diagnostics"`
}

type Error struct {
	Field, Reason string
	Line, Column  int
}

func (e *Error) Error() string {
	return fmt.Sprintf("configuration rejected: %s (%s)", e.Field, e.Reason)
}

func Defaults() Config {
	var c Config
	c.Server.Listen = "0.0.0.0:8080"
	c.ClientKeys = map[string]Secret{}
	c.Limits.MaxWorkers, c.Limits.MaxJobs, c.Limits.InFlight = 1, 1, 1
	c.Diagnostics.Level, c.Diagnostics.Directory = "info", "/var/lib/aaa-muse-ai/diagnostics"
	c.Diagnostics.RetentionDays, c.Diagnostics.MaxBytes = 7, 128*1024*1024
	return c
}

var envReference = regexp.MustCompile(`\$\{([A-Za-z_][A-Za-z0-9_]*)\}`)

func Load(readFile func(string) ([]byte, error), lookup func(string) (string, bool), path string) (Config, error) {
	b, err := readFile(path)
	if err != nil {
		return Config{}, &Error{Field: "configuration", Reason: "read_failed"}
	}
	return Parse(b, lookup)
}

func Parse(b []byte, lookup func(string) (string, bool)) (Config, error) {
	fail := func(reason string) (Config, error) { return Config{}, &Error{Field: "configuration", Reason: reason} }
	if len(b) > 1024*1024 {
		return fail("too_large")
	}
	var node yaml.Node
	d := yaml.NewDecoder(bytes.NewReader(b))
	if err := d.Decode(&node); err != nil {
		line, column := parserLocation(err)
		return Config{}, &Error{Field: "configuration", Reason: "invalid_yaml", Line: line, Column: column}
	}
	if node.Kind != yaml.DocumentNode || len(node.Content) != 1 || node.Content[0].Kind != yaml.MappingNode {
		return fail("mapping_required")
	}
	var extra yaml.Node
	if err := d.Decode(&extra); !errors.Is(err, io.EOF) {
		return Config{}, &Error{Field: "configuration", Reason: "single_document_required", Line: max(extra.Line, 1), Column: max(extra.Column, 1)}
	}
	locations := map[string]*yaml.Node{}
	if err := inspectMapping(node.Content[0], reflect.TypeFor[Config](), "", locations); err != nil {
		return Config{}, err
	}
	if err := resolve(&node, lookup); err != nil {
		if ce, ok := err.(*Error); ok {
			ce.Field = fieldAtPosition(locations, ce.Line, ce.Column)
		}
		return Config{}, err
	}
	c := Defaults()
	if err := node.Decode(&c); err != nil {
		line, column := parserLocation(err)
		return Config{}, &Error{Field: fieldAtPosition(locations, line, column), Reason: "invalid_field_type", Line: line, Column: column}
	}
	if err := c.Validate(); err != nil {
		if ce, ok := err.(*Error); ok {
			if n := locations[ce.Field]; n != nil {
				ce.Line, ce.Column = n.Line, n.Column
			}
		}
		return Config{}, err
	}
	return c, nil
}

var parserPosition = regexp.MustCompile(`line ([0-9]+)(?::([0-9]+))?`)

func parserLocation(err error) (int, int) {
	match := parserPosition.FindStringSubmatch(err.Error())
	if len(match) == 0 {
		return 1, 1
	}
	line, _ := strconv.Atoi(match[1])
	column := 1
	if match[2] != "" {
		column, _ = strconv.Atoi(match[2])
	}
	return line, column
}
func fieldAtPosition(locations map[string]*yaml.Node, line, column int) string {
	field, bestLine, bestColumn := "configuration", 0, 0
	for path, n := range locations {
		if n.Line > line || (n.Line == line && n.Column > column) {
			continue
		}
		if n.Line > bestLine || (n.Line == bestLine && n.Column >= bestColumn) {
			field, bestLine, bestColumn = path, n.Line, n.Column
		}
	}
	return field
}
func inspectMapping(node *yaml.Node, kind reflect.Type, parent string, locations map[string]*yaml.Node) error {
	if node.Kind != yaml.MappingNode {
		return nil
	}
	if kind.Kind() != reflect.Struct && kind.Kind() != reflect.Map {
		return nil
	}
	seen := map[string]bool{}
	for i := 0; i < len(node.Content); i += 2 {
		key, value := node.Content[i], node.Content[i+1]
		name := "<client>"
		child := kind
		if kind.Kind() == reflect.Map {
			child = kind.Elem()
		} else {
			name = "<unknown>"
			for index := 0; index < kind.NumField(); index++ {
				f := kind.Field(index)
				if f.Tag.Get("yaml") == key.Value {
					name = key.Value
					child = f.Type
					break
				}
			}
		}
		path := name
		if parent != "" {
			path = parent + "." + name
		}
		if name == "<unknown>" {
			return &Error{Field: path, Reason: "unknown_field", Line: key.Line, Column: key.Column}
		}
		if seen[key.Value] {
			return &Error{Field: path, Reason: "duplicate_field", Line: key.Line, Column: key.Column}
		}
		seen[key.Value] = true
		locations[path] = value
		if err := inspectMapping(value, child, path, locations); err != nil {
			return err
		}
	}
	return nil
}

func resolve(n *yaml.Node, lookup func(string) (string, bool)) error {
	if n.Kind == yaml.AliasNode {
		return &Error{Field: "configuration", Reason: "aliases_unsupported", Line: n.Line, Column: n.Column}
	}
	if n.Kind == yaml.ScalarNode && strings.Contains(n.Value, "${") {
		missing := false
		n.Value = envReference.ReplaceAllStringFunc(n.Value, func(match string) string {
			value, ok := lookup(match[2 : len(match)-1])
			if !ok || value == "" {
				missing = true
			}
			return value
		})
		if missing || strings.Contains(n.Value, "${") {
			return &Error{Field: "configuration", Reason: "unresolved_environment_reference", Line: n.Line, Column: n.Column}
		}
	}
	for _, child := range n.Content {
		if err := resolve(child, lookup); err != nil {
			return err
		}
	}
	return nil
}

func (c Config) Validate() error {
	bad := func(field, reason string) error { return &Error{Field: field, Reason: reason} }
	_, port, err := net.SplitHostPort(c.Server.Listen)
	p, portErr := strconv.Atoi(port)
	if err != nil || portErr != nil || p < 1 || p > 65535 {
		return bad("server.listen", "invalid_address")
	}
	u, err := url.Parse(c.Server.PublicURL)
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return bad("server.public-url", "https_origin_required")
	}
	db, err := url.Parse(string(c.Database.URL))
	if err != nil || (db.Scheme != "postgres" && db.Scheme != "postgresql") || db.Hostname() == "" || db.Path == "" || db.Path == "/" {
		return bad("database.url", "postgres_url_required")
	}
	if strings.TrimSpace(string(c.Portal.Password)) == "" {
		return bad("control-portal.password", "required")
	}
	seen := map[string]bool{string(c.Portal.Password): true}
	if c.Management.Key != "" {
		if strings.ContainsAny(string(c.Management.Key), " \t\r\n") {
			return bad("management.key", "bearer_key_contains_whitespace")
		}
		if !usableBearerKey(c.Management.Key) {
			return bad("management.key", "bearer_key_contains_control_bytes")
		}
		if strings.TrimSpace(string(c.Management.Key)) == "" || seen[string(c.Management.Key)] {
			return bad("management.key", "credential_roles_must_be_distinct")
		}
		seen[string(c.Management.Key)] = true
	}
	for name, key := range c.ClientKeys {
		if strings.TrimSpace(name) == "" || len(name) > 100 || !usableBearerKey(key) || seen[string(key)] {
			return bad("client-keys", "invalid_or_reused_credential")
		}
		seen[string(key)] = true
	}
	if c.Limits.MaxWorkers < 1 || c.Limits.MaxJobs < 1 || c.Limits.InFlight != 1 {
		return bad("limits", "positive_limits_and_single_in_flight_required")
	}
	if _, ok := map[string]bool{"debug": true, "info": true, "warn": true, "error": true}[c.Diagnostics.Level]; !ok {
		return bad("diagnostics.level", "unsupported_level")
	}
	if !strings.HasPrefix(c.Diagnostics.Directory, "/") || c.Diagnostics.Directory == "/" {
		return bad("diagnostics.directory", "absolute_directory_required")
	}
	if c.Diagnostics.RetentionDays < 1 || c.Diagnostics.RetentionDays > 7 || c.Diagnostics.MaxBytes < 6144 || c.Diagnostics.MaxBytes > 128*1024*1024 {
		return bad("diagnostics", "retention_out_of_range")
	}
	return nil
}

func usableBearerKey(value Secret) bool {
	if value == "" {
		return false
	}
	for _, b := range []byte(value) {
		if b <= 0x20 || b == 0x7f {
			return false
		}
	}
	return true
}

func (c Config) Secrets() []string {
	values := []string{string(c.Database.URL), string(c.Management.Key), string(c.Portal.Password)}
	if u, err := url.Parse(string(c.Database.URL)); err == nil && u.User != nil {
		if p, ok := u.User.Password(); ok {
			values = append(values, p)
		}
	}
	for _, key := range c.ClientKeys {
		values = append(values, string(key))
	}
	return values
}
