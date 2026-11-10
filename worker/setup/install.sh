#!/usr/bin/env bash
set +x
set -euo pipefail
umask 077
[[ $# == 6 ]] || { printf '%s\n' '{"level":"ERROR","msg":"setup.runtime_unsupported","cause":"installer_arguments_required","protected_capture_unavailable":true}' >&2; exit 1; }
archive=$1
version=$2
expected=$3
origin=$4
setup_id=$5
receipt=$6
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-(rc|dev)\.[0-9]+)?$ && "$expected" =~ ^[0-9a-f]{64}$ && "$setup_id" =~ ^[0-9a-f]{32}$ ]] || exit 1
[[ -f "$receipt" && ! -L "$receipt" && -O "$receipt" && $(stat -c '%a:%h' "$receipt") == 600:1 && $(stat -c '%s' "$receipt") -le 65536 ]] || { printf '%s\n' '{"level":"ERROR","msg":"setup.runtime_unsupported","cause":"bootstrap_evidence_unsafe","protected_capture_unavailable":true}' >&2; exit 1; }
stage=installer
observed=''
execution_started=false
capability=artifact_installation
expected_state=verified_artifact
observed_state=pending
cause=none
started=$(date +%s)
event() {
  local line elapsed
  elapsed=$(( ($(date +%s) - started) * 1000 ))
  line=$(printf '{"level":"%s","msg":"%s","setup_id":"%s","operation_id":"%s","stage":"%s","package_version":"%s","expected_digest":"%s","observed_digest":"%s","execution_started":%s,"attempt":1,"capability":"%s","expected_state":"%s","observed_state":"%s","cause":"%s","duration_ms":%s}' "$1" "$2" "$setup_id" "$setup_id" "$stage" "$version" "$expected" "$observed" "$execution_started" "$capability" "$expected_state" "$observed_state" "$cause" "$elapsed")
  [[ $(stat -c '%s' "$receipt") -lt 60000 ]] || { printf '%s\n' '{"level":"ERROR","msg":"setup.runtime_unsupported","cause":"bootstrap_capture_full","protected_capture_unavailable":true}' >&2; exit 1; }
  if ! printf '%s\n' "$line" >> "$receipt"; then
    trap - ERR
    printf '{"level":"ERROR","msg":"setup.bootstrap_capture_failed","setup_id":"%s","stage":"%s","cause":"receipt_append_failed","protected_capture_unavailable":true,"execution_started":%s}\n' "$setup_id" "$stage" "$execution_started" >&2
    exit 1
  fi
  printf '%s\n' "$line" >&2
}
trap 'cause=command_failed_exit_$?; event ERROR setup.runtime_unsupported' ERR
private_dir() {
  mkdir -p -m 700 "$1"
  if [[ ! -d "$1" || -L "$1" || ! -O "$1" || $(stat -c '%a' "$1") != 700 ]]; then
    capability=${2:-private_directory}
    expected_state=owned_directory_mode_700
    observed_state="mode_$(stat -c '%a' "$1")_uid_$(stat -c '%u' "$1")"
    cause=unsafe_private_directory
    event ERROR setup.runtime_unsupported
    exit 1
  fi
}
event INFO setup.installer_started
observed=$(sha256sum "$archive"); observed=${observed%% *}
if [[ "$observed" != "$expected" ]]; then event ERROR setup.digest_mismatch; exit 1; fi
actual_version=$(tar -xOzf "$archive" package/package.json | sed -nE 's/^  "version": "([A-Za-z0-9.+-]+)",?$/\1/p')
actual_name=$(tar -xOzf "$archive" package/package.json | sed -nE 's/^  "name": "([@A-Za-z0-9/_-]+)",?$/\1/p')
if [[ "$actual_version" != "$version" || "$actual_name" != '@markhuangai/aaa-muse-worker' ]]; then event ERROR setup.package_mismatch; exit 1; fi
root="${XDG_DATA_HOME:-$HOME/.local/share}/aaa-muse-worker"
state="${XDG_STATE_HOME:-$HOME/.local/state}/aaa-muse-worker"
[[ "$root" == /* && "$state" == /* ]]
private_dir "$root" install_directory
private_dir "$root/releases" bundle_directory
private_dir "$state" state_directory
stage=runtime
capability=node_runtime
expected_state=node_22_12_or_linux_x64_fallback
observed_state="$(uname -s)_$(uname -m)"
node=$(command -v node || true)
supported=false
if [[ "$node" == /* ]]; then
  if "$node" -e 'const [major,minor]=process.versions.node.split(".").map(Number);process.exit(major>22||(major===22&&minor>=12)?0:1)' >/dev/null 2>&1; then supported=true; fi
fi
if [[ "$supported" != true ]]; then
  [[ $(uname -s) == Linux && $(uname -m) == x86_64 ]] || { event ERROR setup.runtime_unsupported; exit 1; }
  private_dir "$root/runtime"
  runtime=$(mktemp -d "$root/runtime/node.XXXXXXXX")
  node_expected=48cc0e21e048790e54c0cf5749c2725005313d652651c40b7a21feb9697aaf75
  curl -q --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --connect-timeout 10 --max-time 120 https://nodejs.org/dist/v24.22.2/node-v24.22.2-linux-x64.tar.xz --output "$runtime/node.tar.xz"
  node_observed=$(sha256sum "$runtime/node.tar.xz"); node_observed=${node_observed%% *}
  if [[ "$node_observed" != "$node_expected" ]]; then
    expected=$node_expected
    observed=$node_observed
    stage=node
    event ERROR setup.digest_mismatch
    exit 1
  fi
  tar -xOJf "$runtime/node.tar.xz" node-v24.22.2-linux-x64/bin/node > "$runtime/node"
  tar -xOJf "$runtime/node.tar.xz" node-v24.22.2-linux-x64/LICENSE > "$runtime/LICENSE"
  chmod 700 "$runtime/node"
  node="$runtime/node"
  [[ $("$node" --version) == v24.22.2 ]]
fi
observed_state=supported_node
event INFO setup.runtime_verified
stage=extract
while IFS= read -r entry; do
  [[ "$entry" == package/* && "$entry" != /* && "$entry" != *'/../'* && "$entry" != *'/./'* && "$entry" != *'/..' && "$entry" != *$'\n'* ]]
  case "$entry" in package/dist/*|package/setup/*|package/package.json|package/LICENSE|package/README.md) ;; *) event ERROR setup.package_mismatch; exit 1 ;; esac
done < <(tar -tzf "$archive")
while IFS= read -r entry; do [[ ${entry:0:1} == - || ${entry:0:1} == d ]]; done < <(tar -tvzf "$archive")
bundle=$(mktemp -d "$root/releases/bundle.XXXXXXXX")
tar -xzf "$archive" --no-same-owner --no-same-permissions -C "$bundle"
"$node" --input-type=module - "$bundle/package" "$version" <<'AAA_MUSE_METADATA'
import { readFileSync } from 'node:fs';
const [root,version]=process.argv.slice(2);
const manifest=JSON.parse(readFileSync(root+'/package.json','utf8'));
const build=JSON.parse(readFileSync(root+'/dist/build.json','utf8'));
if(manifest.name!=='@markhuangai/aaa-muse-worker'||manifest.version!==version||build.package_version!==version) process.exit(1);
AAA_MUSE_METADATA
stage=worker
event INFO setup.package_verified
execution_started=true
"$node" "$bundle/package/dist/main.js" setup --origin "$origin" --code-stdin --install-dir "$root" --setup-id "$setup_id" --bootstrap "$receipt" --state-dir "$state"
