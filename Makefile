ACTIONLINT ?= actionlint

.PHONY: check-ci-policy check-workflows

check-ci-policy:
	node .github/scripts/ci-policy.mjs

check-workflows:
	@test "$$($(ACTIONLINT) -version 2>&1 | head -n 1)" = '1.7.12' || { echo 'actionlint 1.7.12 is required' >&2; exit 1; }
	$(ACTIONLINT) -shellcheck= -pyflakes=
