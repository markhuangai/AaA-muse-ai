ACTIONLINT ?= actionlint
DOCKER ?= docker
SERVICE_IMAGE ?= aaa-muse-ai-service:local
SOURCE_SHA ?= $(shell git rev-parse HEAD)
SOURCE_DIRTY ?= $(shell test -z "$$(git --no-optional-locks status --porcelain --untracked-files=all)" && echo false || echo true)

.PHONY: check-ci-policy check-workflows check-service test-service-unit test-service test-worker-auth test-inference smoke-image image worker-package test-worker-transport test-worker-setup

check-ci-policy:
	node .github/scripts/ci-policy.mjs

check-workflows:
	@test "$$($(ACTIONLINT) -version 2>&1 | head -n 1)" = '1.7.12' || { echo 'actionlint 1.7.12 is required' >&2; exit 1; }
	$(ACTIONLINT) -shellcheck= -pyflakes=

check-service:
	sh scripts/go.sh check

test-service-unit:
	sh scripts/go.sh unit

image:
	$(DOCKER) build --provenance=false --build-arg SOURCE_SHA=$(SOURCE_SHA) --build-arg SOURCE_DIRTY=$(SOURCE_DIRTY) -t $(SERVICE_IMAGE) .

test-service: image
	python3 tests/integration/service.py --image $(SERVICE_IMAGE) --suite service --source-sha $(SOURCE_SHA) --source-dirty $(SOURCE_DIRTY)

test-worker-auth: image
	python3 -B tests/integration/worker_auth.py --image $(SERVICE_IMAGE) --source-sha $(SOURCE_SHA) --source-dirty $(SOURCE_DIRTY)

test-inference: image
	python3 -B tests/integration/inference.py --image $(SERVICE_IMAGE) --source-sha $(SOURCE_SHA) --source-dirty $(SOURCE_DIRTY)

smoke-image: image
	python3 tests/integration/service.py --image $(SERVICE_IMAGE) --suite image --source-sha $(SOURCE_SHA) --source-dirty $(SOURCE_DIRTY)

worker-package:
	npm run build --workspace worker
	npm run test:package --workspace worker

test-worker-transport: image worker-package
	python3 -B tests/integration/worker_transport.py --image $(SERVICE_IMAGE) --source-sha $(SOURCE_SHA) --source-dirty $(SOURCE_DIRTY) --package-receipt .artifacts/worker-package/latest.json

test-worker-setup: image worker-package
	python3 -B tests/integration/worker_setup.py --image $(SERVICE_IMAGE) --source-sha $(SOURCE_SHA) --source-dirty $(SOURCE_DIRTY) --package-receipt .artifacts/worker-package/latest.json
