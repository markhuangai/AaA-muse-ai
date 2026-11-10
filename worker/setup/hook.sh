#!/usr/bin/env bash
set -euo pipefail
[[ $# == 0 ]] || { printf '%s\n' '{"level":"ERROR","msg":"setup.runtime_unsupported","capability":"no-argument hook"}' >&2; exit 1; }
if [[ -z ${HATCH_HOOK_RUNTIME:-} ]]; then
  if [[ ${HATCH_HOOK_DRY_RUN:-0} != 1 && ${HATCH_HOOK_DRY_RUN:-0} != true ]]; then exec @LAUNCHER@ hook-check --state-dir @STATE@ --runtime-error missing_runtime; fi
  printf '%s\n' '{"level":"ERROR","msg":"setup.runtime_unsupported","capability":"HATCH_HOOK_RUNTIME","stopped_stage":"hook","protected_capture_unavailable":true}' >&2
  exit 1
fi
if ! source "$HATCH_HOOK_RUNTIME"; then
  if [[ ${HATCH_HOOK_DRY_RUN:-0} != 1 && ${HATCH_HOOK_DRY_RUN:-0} != true ]]; then exec @LAUNCHER@ hook-check --state-dir @STATE@ --runtime-error source_failed; fi
  exit 1
fi
if ! declare -F wake silent >/dev/null; then
  if [[ ${HATCH_HOOK_DRY_RUN:-0} != 1 && ${HATCH_HOOK_DRY_RUN:-0} != true ]]; then exec @LAUNCHER@ hook-check --state-dir @STATE@ --runtime-error missing_functions; fi
  exit 1
fi
if [[ ${HATCH_HOOK_DRY_RUN:-0} == 1 || ${HATCH_HOOK_DRY_RUN:-0} == true ]]; then
  silent 'Dry run: no worker reads, writes, network or subscriber launch'
  exit 0
fi
exec @LAUNCHER@ hook-check --state-dir @STATE@
