#!/bin/sh
set -eu
umask 077
task_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
mkdir -p "$task_root/.artifacts/go-mod" "$task_root/.artifacts/go-cache" "$task_root/.artifacts/unit"
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
      sh -ec 'go test -race -covermode=atomic -coverpkg="$(go list ./... | paste -sd, -)" -coverprofile=.artifacts/unit/service.cover ./...'
    awk 'NR > 1 { if (($1 in statements) && statements[$1] != $2) invalid = 1; statements[$1] = $2; if ($3 > 0) hits[$1] = 1 } END { for (block in statements) { total += statements[block]; if (hits[block]) covered += statements[block] } printf "unit statements: %d/%d\n", covered, total; if (invalid || total == 0 || covered * 100 <= total * 90) exit 1 }' "$task_root/.artifacts/unit/service.cover"
    ;;
  *) echo 'Expected check or unit' >&2; exit 1 ;;
esac
