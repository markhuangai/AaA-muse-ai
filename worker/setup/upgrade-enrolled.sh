#!/usr/bin/env bash
set +x
set -euo pipefail
umask 077

fail() {
  printf '{"level":"ERROR","msg":"worker.upgrade_bootstrap_failed","cause":"%s","outcome":"stopped"}\n' "$1" >&2
  exit 1
}

[[ $# == 3 && "${1:-}" =~ ^(prepare|apply|cancel)$ && "${3:-}" == /* ]] || fail upgrade_arguments_required
mode=$1
archive=$2
state=$3
[[ -f "$archive" && ! -L "$archive" ]] || fail upgrade_archive_unavailable

supported_node() {
  [[ "$1" == /* && -x "$1" ]] && "$1" -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major >= 23 || major === 22 && minor >= 12 ? 0 : 1)' >/dev/null 2>&1
}
node=$(command -v node || true)
if ! supported_node "$node"; then
  node=''
  root="${XDG_DATA_HOME:-$HOME/.local/share}/aaa-muse-worker"
  for candidate in "$root"/runtime/node.*/node; do
    [[ -f "$candidate" && ! -L "$candidate" && -O "$candidate" && $(stat -c '%a:%h' "$candidate") == 700:1 ]] || continue
    if supported_node "$candidate"; then node=$candidate; break; fi
  done
fi
[[ -n "$node" ]] || fail upgrade_node_unavailable

# Use the existing enrolled launcher so the bootstrap never handles a raw credential.
if ! pin=$("$node" --input-type=module - "$state" <<'AAA_MUSE_PIN'
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { isAbsolute, join } from 'node:path';
import assert from 'node:assert/strict';
const [, , state] = process.argv;
const uid = process.geteuid();
function privatePath(path, mode, directory = false) {
  const stat = lstatSync(path);
  assert.equal(stat.uid, uid);
  assert.equal(stat.mode & 0o7777, mode);
  assert.ok(directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1);
}
function saved(name) {
  const file = openSync(join(state, name), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(file);
    assert.ok(info.isFile() && info.nlink === 1 && info.uid === uid && (info.mode & 0o7777) === 0o600 && info.size <= 65_536);
    return JSON.parse(readFileSync(file, 'utf8'));
  } finally { closeSync(file); }
}
try {
  privatePath(state, 0o700, true);
  const installed = saved('installation.json');
  const config = saved('config.json');
  assert.ok(isAbsolute(installed.root) && /^[a-f0-9]{32}$/.test(config.worker_id) && installed.worker_id === config.worker_id && installed.origin === config.origin);
  const bin = join(installed.root, 'bin');
  const launcher = join(bin, 'aaa-muse-worker');
  privatePath(installed.root, 0o700, true);
  privatePath(bin, 0o700, true);
  privatePath(launcher, 0o700);
  const response = spawnSync(launcher, ['status', '--state-dir', state], { encoding: 'utf8', maxBuffer: 3 * 1024 * 1024, timeout: 40_000 });
  assert.equal(response.status, 0);
  const worker = JSON.parse(response.stdout).worker;
  assert.equal(worker.id, installed.worker_id);
  const pin = worker.worker_package;
  assert.ok(/^\d+\.\d+\.\d+(-(rc|dev)\.\d+)?$/.test(pin.version) && /^[a-f0-9]{64}$/.test(pin.sha256));
  process.stdout.write(pin.version + ' ' + pin.sha256);
} catch {
  process.exitCode = 1;
}
AAA_MUSE_PIN
); then fail upgrade_authenticated_pin_unavailable; fi
read -r version expected <<< "$pin"

work=$(mktemp -d "${TMPDIR:-/tmp}/aaa-muse-upgrade.XXXXXXXX")
trap 'rm -r -- "$work"' EXIT
cp -- "$archive" "$work/worker.tgz"
observed=$(sha256sum "$work/worker.tgz")
[[ "${observed%% *}" == "$expected" ]] || fail upgrade_digest_mismatch
while IFS= read -r name; do
  [[ "$name" != *'/../'* && "$name" != *'/./'* && "$name" != *'/..' ]] || fail upgrade_package_path_invalid
  case "$name" in
    package/dist/*|package/setup/*|package/package.json|package/LICENSE|package/README.md) ;;
    *) fail upgrade_package_path_invalid ;;
  esac
done < <(tar -tzf "$work/worker.tgz")
while IFS= read -r detail; do
  [[ ${detail:0:1} == - || ${detail:0:1} == d ]] || fail upgrade_package_type_invalid
done < <(tar -tvzf "$work/worker.tgz")
tar -xzf "$work/worker.tgz" --no-same-owner --no-same-permissions -C "$work"
[[ -f "$work/package/setup/upgrade-enrolled.sh" ]] && cmp -s -- "${BASH_SOURCE[0]}" "$work/package/setup/upgrade-enrolled.sh" || fail upgrade_package_helper_mismatch
if ! "$node" --input-type=module - "$work/package" "$version" <<'AAA_MUSE_METADATA'
import { readFileSync } from 'node:fs';
const [, , root, version] = process.argv;
const manifest = JSON.parse(readFileSync(root + '/package.json', 'utf8'));
const build = JSON.parse(readFileSync(root + '/dist/build.json', 'utf8'));
if (manifest.name !== '@markhuangai/aaa-muse-worker' || manifest.version !== version || build.package_version !== version) process.exit(1);
AAA_MUSE_METADATA
then fail upgrade_package_mismatch; fi
"$node" "$work/package/dist/main.js" upgrade-enrolled --mode "$mode" --archive-sha256 "$expected" --state-dir "$state"
