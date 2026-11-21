#!/bin/sh
set -eu
umask 077
task_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
mkdir -p "$task_root/.artifacts/go-mod" "$task_root/.artifacts/go-cache" "$task_root/.artifacts/unit/service"
tools_image=${SERVICE_TOOLS_IMAGE:-aaa-muse-ai-tools:local}
docker build --target tools -t "$tools_image" "$task_root"
case "${1:-}" in
  check)
    docker run --rm --user "$(id -u):$(id -g)" -v "$task_root:/src" -v "$task_root/.artifacts/go-mod:/module-cache" -w /src \
      -e GOCACHE=/src/.artifacts/go-cache -e GOMODCACHE=/module-cache "$tools_image" \
      sh -ec 'test -z "$(gofmt -l cmd internal)"; go vet ./...; go build ./...'
    ;;
  unit)
    docker run --rm --user "$(id -u):$(id -g)" -v "$task_root:/src" -v "$task_root/.artifacts/go-mod:/module-cache" -w /src \
      -e GOCACHE=/src/.artifacts/go-cache -e GOMODCACHE=/module-cache "$tools_image" \
      sh -ec 'go version > .artifacts/unit/service/go-version.txt; go test -race -covermode=atomic -coverpkg="$(go list ./... | paste -sd, -)" -coverprofile=.artifacts/unit/service/service.cover ./...'
    node "$task_root/tools/coverage-policy.mjs" collect service
    ;;
  portal)
    docker run --rm --user "$(id -u):$(id -g)" -v "$task_root:/src" -v "$task_root/.artifacts/go-mod:/module-cache" -w /src \
      -e GOCACHE=/src/.artifacts/go-cache -e GOMODCACHE=/module-cache "$tools_image" \
      go test -race -v -count=1 ./internal/httpapi ./internal/service -run '^TestPortal'
    ;;
  mcp-client)
    mkdir -p "$task_root/.artifacts/integration-tools"
    docker run --rm --user "$(id -u):$(id -g)" -v "$task_root:/src" -v "$task_root/.artifacts/go-mod:/module-cache" -w /src \
      -e GOCACHE=/src/.artifacts/go-cache -e GOMODCACHE=/module-cache -e CGO_ENABLED=0 "$tools_image" \
      go build -tags mcp_integration -o .artifacts/integration-tools/mcp-client ./tests/integration/mcpclient
    ;;
  *) echo 'Expected check, unit, portal or mcp-client' >&2; exit 1 ;;
esac
