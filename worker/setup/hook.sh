#!/usr/bin/env bash
set -euo pipefail
[[ $# == 0 ]] || { printf '%s\n' '{"level":"ERROR","msg":"setup.runtime_unsupported","capability":"no-argument hook"}' >&2; exit 1; }
if [[ -z ${HATCH_HOOK_RUNTIME:-} ]]; then
  printf '%s\n' '{"level":"ERROR","msg":"setup.runtime_unsupported","capability":"HATCH_HOOK_RUNTIME","stopped_stage":"hook","protected_capture_unavailable":true}' >&2
  exit 1
fi
if ! source "$HATCH_HOOK_RUNTIME" >&2; then
  printf '%s\n' '{"level":"ERROR","msg":"hook.runtime_unavailable","cause":"runtime_source_failed"}' >&2
  exit 1
fi
if ! declare -F wake >/dev/null || ! declare -F silent >/dev/null; then
  printf '%s\n' '{"level":"ERROR","msg":"hook.runtime_unavailable","cause":"runtime_functions_missing"}' >&2
  exit 1
fi
if [[ ${HATCH_HOOK_DRY_RUN:-0} == 1 || ${HATCH_HOOK_DRY_RUN:-0} == true ]]; then
  silent 'Dry run: no worker reads, writes, network or broker pull'
  exit 0
fi
exec @LAUNCHER@ hook-check
