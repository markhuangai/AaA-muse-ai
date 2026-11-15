ACTIONLINT ?= actionlint
DOCKER ?= docker
SERVICE_IMAGE ?= aaa-muse-ai-service:local
SOURCE_SHA ?= $(shell git rev-parse HEAD)
SOURCE_DIRTY ?= $(shell test -z "$$(git --no-optional-locks status --porcelain --untracked-files=all)" && echo false || echo true)
PRODUCT_VERSION ?= $(if $(WORKER_RELEASE_VERSION),$(WORKER_RELEASE_VERSION),$(shell node -p "require('./worker/package.json').version"))
PRODUCT_E2E_SHARD ?= all

.PHONY: check-ci-policy check-file-sizes test-unit-coverage check-workflows check-service test-service-unit test-service test-worker-auth test-inference test-history test-routing test-broker-recovery test-chat test-responses smoke-image image worker-package test-worker-transport test-worker-setup test-worker-recovery test-portal-shell test-portal-workers test-portal-history test-product-e2e

check-ci-policy:
	node .github/scripts/ci-policy.mjs

check-file-sizes:
	node tools/file-size-policy.mjs

test-unit-coverage:
	node tools/unit-runner.mjs all

check-workflows:
	@test "$$($(ACTIONLINT) -version 2>&1 | head -n 1)" = '1.7.12' || { echo 'actionlint 1.7.12 is required' >&2; exit 1; }
	$(ACTIONLINT) -shellcheck= -pyflakes=

check-service:
	sh scripts/go.sh check

test-service-unit:
	sh scripts/go.sh unit

image: worker-package
	$(DOCKER) build --provenance=false --build-arg SOURCE_SHA=$(SOURCE_SHA) --build-arg SOURCE_DIRTY=$(SOURCE_DIRTY) --build-arg PRODUCT_VERSION=$(PRODUCT_VERSION) --build-arg WORKER_SHA256="$$(node -p "require('./.artifacts/worker-package/latest.json').sha256")" -t $(SERVICE_IMAGE) .

test-service: image
	python3 tests/integration/service.py --image $(SERVICE_IMAGE) --suite service --source-sha $(SOURCE_SHA) --source-dirty $(SOURCE_DIRTY)

test-worker-auth: image
	python3 -B tests/integration/worker_auth.py --image $(SERVICE_IMAGE) --source-sha $(SOURCE_SHA) --source-dirty $(SOURCE_DIRTY)

test-inference: image
	python3 -B tests/integration/inference.py --image $(SERVICE_IMAGE) --source-sha $(SOURCE_SHA) --source-dirty $(SOURCE_DIRTY)

test-history: image
	npm run build --workspace worker
	python3 -B tests/integration/history.py --image $(SERVICE_IMAGE) --source-sha $(SOURCE_SHA) --source-dirty $(SOURCE_DIRTY)

test-routing: image
	npm run build --workspace worker
	python3 -B tests/integration/routing.py --image $(SERVICE_IMAGE) --source-sha $(SOURCE_SHA) --source-dirty $(SOURCE_DIRTY)

test-broker-recovery: image
	npm run build --workspace worker
	python3 -B tests/integration/broker_recovery.py --image $(SERVICE_IMAGE) --source-sha $(SOURCE_SHA) --source-dirty $(SOURCE_DIRTY)

test-chat: image
	npm run build --workspace worker
	python3 -B tests/integration/chat.py --image $(SERVICE_IMAGE) --source-sha $(SOURCE_SHA) --source-dirty $(SOURCE_DIRTY)

test-responses: image
	npm run build --workspace worker
	python3 -B tests/integration/responses.py --image $(SERVICE_IMAGE) --source-sha $(SOURCE_SHA) --source-dirty $(SOURCE_DIRTY)

smoke-image: image
	python3 tests/integration/service.py --image $(SERVICE_IMAGE) --suite image --source-sha $(SOURCE_SHA) --source-dirty $(SOURCE_DIRTY)

test-portal-shell: image
	npm run check --workspace portal
	npm run build --workspace worker
	sh scripts/go.sh portal
	python3 -B tests/integration/portal.py --image $(SERVICE_IMAGE) --source-sha $(SOURCE_SHA) --source-dirty $(SOURCE_DIRTY)

test-portal-workers: image
	npm run check --workspace portal
	npm run build --workspace worker
	sh scripts/go.sh portal
	python3 -B tests/integration/portal_workers.py --image $(SERVICE_IMAGE) --source-sha $(SOURCE_SHA) --source-dirty $(SOURCE_DIRTY)

test-portal-history: image
	npm run check --workspace portal
	npm run build --workspace worker
	sh scripts/go.sh portal
	python3 -B tests/integration/portal_history.py --image $(SERVICE_IMAGE) --source-sha $(SOURCE_SHA) --source-dirty $(SOURCE_DIRTY)

worker-package:
	WORKER_RELEASE_VERSION=$(PRODUCT_VERSION) npm run build --workspace worker
	npm run test:package --workspace worker

test-worker-transport: image worker-package
	python3 -B tests/integration/worker_transport.py --image $(SERVICE_IMAGE) --source-sha $(SOURCE_SHA) --source-dirty $(SOURCE_DIRTY) --package-receipt .artifacts/worker-package/latest.json

test-worker-setup: image worker-package
	python3 -B tests/integration/worker_setup.py --image $(SERVICE_IMAGE) --source-sha $(SOURCE_SHA) --source-dirty $(SOURCE_DIRTY) --package-receipt .artifacts/worker-package/latest.json

test-worker-recovery: image worker-package
	python3 -B tests/integration/worker_recovery.py --image $(SERVICE_IMAGE) --source-sha $(SOURCE_SHA) --source-dirty $(SOURCE_DIRTY) --package-receipt .artifacts/worker-package/latest.json

test-product-e2e: image
	python3 -B tests/integration/product_runner.py --image $(SERVICE_IMAGE) --source-sha $(SOURCE_SHA) --source-dirty $(SOURCE_DIRTY) --package-receipt .artifacts/worker-package/latest.json --shard $(PRODUCT_E2E_SHARD)
