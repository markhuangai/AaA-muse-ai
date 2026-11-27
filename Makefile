ACTIONLINT ?= actionlint
DOCKER ?= docker
SERVICE_IMAGE ?= aaa-muse-ai-service:local
SOURCE_SHA ?= $(shell git rev-parse HEAD)
SOURCE_DIRTY ?= $(shell test -z "$$(git --no-optional-locks status --porcelain --untracked-files=all)" && echo false || echo true)
PRODUCT_VERSION ?= $(if $(WORKER_RELEASE_VERSION),$(WORKER_RELEASE_VERSION),$(shell node -p "require('./worker/package.json').version"))
PRODUCT_E2E_SHARD ?= all
PREBUILT_IMAGE ?= 0
IMAGE_PREREQ := $(if $(filter 1 true,$(PREBUILT_IMAGE)),verify-prebuilt-image,image)

.PHONY: test-worker-updates test-worker-tls test-media verify-release check-ci-policy check-file-sizes test-unit-coverage check-workflows check-service test-service-unit test-service test-worker-auth test-inference test-history test-routing test-broker-recovery test-chat test-responses smoke-image image capture-image-source verify-prebuilt-image worker-package test-worker-transport test-worker-setup test-worker-recovery test-portal-shell test-portal-workers test-portal-history test-product-e2e

verify-release:
	node tools/verify-release.mjs

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
	node tools/image-receipt.mjs prepare --docker $(DOCKER) --image $(SERVICE_IMAGE) --source-sha $(SOURCE_SHA) --source-dirty $(SOURCE_DIRTY) --product-version $(PRODUCT_VERSION)
	$(DOCKER) build --provenance=false --build-arg SOURCE_SHA=$(SOURCE_SHA) --build-arg SOURCE_DIRTY=$(SOURCE_DIRTY) --build-arg PRODUCT_VERSION=$(PRODUCT_VERSION) --build-arg WORKER_SHA256="$$(node -p "require('./.artifacts/service-image/build.json').worker_sha256")" -t $(SERVICE_IMAGE) .
	node tools/image-receipt.mjs write --docker $(DOCKER) --image $(SERVICE_IMAGE) --source-sha $(SOURCE_SHA) --source-dirty $(SOURCE_DIRTY) --product-version $(PRODUCT_VERSION)

capture-image-source:
	node tools/image-receipt.mjs capture --docker $(DOCKER) --image $(SERVICE_IMAGE) --source-sha $(SOURCE_SHA) --source-dirty $(SOURCE_DIRTY) --product-version $(PRODUCT_VERSION)

verify-prebuilt-image:
	node tools/image-receipt.mjs verify --docker $(DOCKER) --image $(SERVICE_IMAGE) --source-sha $(SOURCE_SHA) --source-dirty $(SOURCE_DIRTY) --product-version $(PRODUCT_VERSION)

test-service: $(IMAGE_PREREQ)
	python3 -B tests/integration/service.py --image $(SERVICE_IMAGE) --suite service --source-sha $(SOURCE_SHA) --source-dirty $(SOURCE_DIRTY)

test-worker-auth: $(IMAGE_PREREQ)
	python3 -B tests/integration/worker_auth.py --image $(SERVICE_IMAGE) --source-sha $(SOURCE_SHA) --source-dirty $(SOURCE_DIRTY)

test-inference: $(IMAGE_PREREQ)
	python3 -B tests/integration/inference.py --image $(SERVICE_IMAGE) --source-sha $(SOURCE_SHA) --source-dirty $(SOURCE_DIRTY)

test-history: $(IMAGE_PREREQ)
	python3 -B tests/integration/history.py --image $(SERVICE_IMAGE) --source-sha $(SOURCE_SHA) --source-dirty $(SOURCE_DIRTY)

test-media: $(IMAGE_PREREQ)
	python3 -B -m unittest tests/integration/test_media_cleanup.py
	sh scripts/go.sh mcp-client
	python3 -B tests/integration/media.py --image $(SERVICE_IMAGE) --source-sha $(SOURCE_SHA) --source-dirty $(SOURCE_DIRTY) --package-receipt .artifacts/worker-package/latest.json

test-routing: $(IMAGE_PREREQ)
	python3 -B tests/integration/routing.py --image $(SERVICE_IMAGE) --source-sha $(SOURCE_SHA) --source-dirty $(SOURCE_DIRTY)

test-broker-recovery: $(IMAGE_PREREQ)
	python3 -B tests/integration/broker_recovery.py --image $(SERVICE_IMAGE) --source-sha $(SOURCE_SHA) --source-dirty $(SOURCE_DIRTY)

test-chat: $(IMAGE_PREREQ)
	python3 -B tests/integration/chat.py --image $(SERVICE_IMAGE) --source-sha $(SOURCE_SHA) --source-dirty $(SOURCE_DIRTY)

test-responses: $(IMAGE_PREREQ)
	python3 -B tests/integration/responses.py --image $(SERVICE_IMAGE) --source-sha $(SOURCE_SHA) --source-dirty $(SOURCE_DIRTY)

smoke-image: image
	python3 -B tests/integration/service.py --image $(SERVICE_IMAGE) --suite image --source-sha $(SOURCE_SHA) --source-dirty $(SOURCE_DIRTY)

test-portal-shell: $(IMAGE_PREREQ)
	sh scripts/go.sh portal
	python3 -B tests/integration/portal.py --image $(SERVICE_IMAGE) --source-sha $(SOURCE_SHA) --source-dirty $(SOURCE_DIRTY)

test-portal-workers: $(IMAGE_PREREQ)
	python3 -B -m unittest tests/integration/test_portal_workers_diagnostics.py
	python3 -B tests/integration/portal_workers.py --image $(SERVICE_IMAGE) --source-sha $(SOURCE_SHA) --source-dirty $(SOURCE_DIRTY)

test-portal-history: $(IMAGE_PREREQ)
	python3 -B tests/integration/portal_history.py --image $(SERVICE_IMAGE) --source-sha $(SOURCE_SHA) --source-dirty $(SOURCE_DIRTY)

worker-package: | capture-image-source
	WORKER_RELEASE_VERSION=$(PRODUCT_VERSION) npm run build --workspace worker
	npm run test:package --workspace worker

test-worker-transport: $(IMAGE_PREREQ)
	python3 -B tests/integration/worker_transport.py --image $(SERVICE_IMAGE) --source-sha $(SOURCE_SHA) --source-dirty $(SOURCE_DIRTY) --package-receipt .artifacts/worker-package/latest.json

test-worker-updates:
	python3 -B tests/integration/worker_updates.py --source-sha $(SOURCE_SHA) --source-dirty $(SOURCE_DIRTY)

test-worker-tls:
	python3 -B -m unittest tests/integration/test_worker_tls.py

test-worker-setup: $(IMAGE_PREREQ)
	python3 -B tests/integration/worker_setup.py --image $(SERVICE_IMAGE) --source-sha $(SOURCE_SHA) --source-dirty $(SOURCE_DIRTY) --package-receipt .artifacts/worker-package/latest.json

test-worker-recovery: $(IMAGE_PREREQ)
	python3 -B tests/integration/worker_recovery.py --image $(SERVICE_IMAGE) --source-sha $(SOURCE_SHA) --source-dirty $(SOURCE_DIRTY) --package-receipt .artifacts/worker-package/latest.json

test-product-e2e: $(IMAGE_PREREQ)
	python3 -B tests/integration/product_runner.py --image $(SERVICE_IMAGE) --source-sha $(SOURCE_SHA) --source-dirty $(SOURCE_DIRTY) --package-receipt .artifacts/worker-package/latest.json --shard $(PRODUCT_E2E_SHARD)
