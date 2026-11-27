import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { logEvent } from '../.github/scripts/ci-log.mjs';
import { inspectSource } from './source-inventory.mjs';

const decoderPaths = ['worker/dist/diagnostics.js', 'worker/dist/state.js', 'worker/dist/errors.js', 'worker/dist/json.js'];
const versionPattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-(dev|rc)\.(0|[1-9][0-9]*))?$/;
const digest = data => createHash('sha256').update(data).digest('hex');
const same = (left, right) => isDeepStrictEqual(left, right);
const fail = cause => { throw Object.assign(new Error(cause), { cause }); };
const need = (condition, cause) => { if (!condition) fail(cause); };
const safeHash = value => /^[a-f0-9]{64}$/.test(value ?? '') ? value : null;
const safeSource = value => value && typeof value === 'object' ? {
  sha: /^[a-f0-9]{40}$/.test(value.sha ?? '') ? value.sha : null,
  dirty: typeof value.dirty === 'boolean' ? value.dirty : null,
  tree_sha256: safeHash(value.tree_sha256),
} : null;
const safeDecoders = value => value && typeof value === 'object' ? Object.fromEntries(decoderPaths.map(path => [path, safeHash(value[path])])) : null;

function safeEvidence(fields) {
  const secrets = Object.entries(process.env).filter(([name, value]) =>
    /(?:TOKEN|PASSWORD|PASSWD|SECRET|CREDENTIAL|API[_-]?KEY|(?:^|_)PAT(?:_|$)|PRIVATE[_-]?KEY)/i.test(name) && value).map(([, value]) => value);
  return JSON.parse(JSON.stringify(fields, (_key, value) => {
    if (typeof value !== 'string') return value;
    for (const secret of secrets) value = value.split(secret).join('[REDACTED]');
    return value.replace(/\b(?:muse|aaa_muse_ai)_[A-Za-z0-9_-]+/gi, '[REDACTED]')
      .replace(/\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]+/gi, '[REDACTED]')
      .replace(/\bBearer\s+[^\s;,"']+/gi, 'Bearer [REDACTED]');
  }));
}

function readJSON(path, cause) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fail(cause); }
}

function writeJSON(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = path + '.' + process.pid + '.tmp';
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  renameSync(temporary, path);
}

function parseArgs(args) {
  const mode = args[0], fields = {};
  need(['capture', 'prepare', 'write', 'verify'].includes(mode), 'invalid_operation');
  for (let index = 1; index < args.length; index += 2) {
    const name = args[index];
    need(['--docker', '--image', '--source-sha', '--source-dirty', '--product-version'].includes(name) &&
      args[index + 1] && !Object.hasOwn(fields, name), 'invalid_arguments');
    fields[name] = args[index + 1];
  }
  need(Object.keys(fields).length === 5 && /^[a-f0-9]{40}$/.test(fields['--source-sha']) &&
    /^(true|false)$/.test(fields['--source-dirty']) && versionPattern.test(fields['--product-version']) &&
    /^[0-9A-Za-z][0-9A-Za-z./:_-]{0,199}$/.test(fields['--image']), 'invalid_arguments');
  return { mode, docker: fields['--docker'], image: fields['--image'], sha: fields['--source-sha'],
    dirty: fields['--source-dirty'] === 'true', version: fields['--product-version'] };
}

function observedSource(root, inspect, options, evidence) {
  let source;
  try { source = inspect(root).identity; } catch { return fail('source_inspection_failed'); }
  evidence.observed_source = safeSource(source);
  need(source && source.sha === options.sha && source.dirty === options.dirty && /^[a-f0-9]{64}$/.test(source.tree_sha256 ?? ''), 'source_flags_mismatch');
  return source;
}

function workerSnapshot(root, source, options, evidence) {
  const directory = join(root, '.artifacts/worker-package');
  const worker = readJSON(join(directory, 'latest.json'), 'worker_receipt_unavailable');
  evidence.observed_product_version = versionPattern.test(worker.version ?? '') ? worker.version : null;
  need(worker.outcome === 'passed' && worker.version === options.version && worker.source?.package_version === options.version &&
    worker.source?.source_sha === source.sha && worker.source?.source_dirty === source.dirty, 'worker_receipt_identity_mismatch');
  need(typeof worker.archive === 'string' && /^[a-f0-9]{64}$/.test(worker.sha256 ?? ''), 'worker_receipt_invalid');
  evidence.expected_worker_sha256 ??= worker.sha256;
  const archive = resolve(root, worker.archive);
  let data;
  try {
    const resolved = realpathSync(archive), within = relative(realpathSync(directory), resolved);
    need(within !== '' && !within.startsWith('..') && !within.startsWith('/') && resolved.endsWith('.tgz') && lstatSync(resolved).isFile(), 'worker_archive_path_invalid');
    data = readFileSync(resolved);
  } catch (error) { if (error.cause === 'worker_archive_path_invalid') throw error; return fail('worker_archive_unavailable'); }
  evidence.observed_worker_sha256 = digest(data);
  need(evidence.observed_worker_sha256 === worker.sha256, 'worker_archive_digest_mismatch');
  const installerPath = join(dirname(archive), 'unpacked/package/setup/install.sh');
  let installer;
  try {
    const resolved = realpathSync(installerPath), within = relative(realpathSync(directory), resolved);
    need(within !== '' && !within.startsWith('..') && !within.startsWith('/') && lstatSync(installerPath).isFile(), 'worker_installer_path_invalid');
    installer = digest(readFileSync(installerPath));
  } catch (error) { if (error.cause === 'worker_installer_path_invalid') throw error; return fail('worker_installer_unavailable'); }
  evidence.observed_installer_sha256 = installer;
  const decoders = {};
  for (const path of decoderPaths) {
    try { decoders[path] = digest(readFileSync(join(root, path))); } catch { evidence.missing_dist_files.push(path); }
  }
  evidence.observed_decoder_sha256 = decoders;
  need(evidence.missing_dist_files.length === 0, 'worker_decoders_unavailable');
  return { archive: worker.archive, worker_sha256: worker.sha256, installer_sha256: installer, decoder_sha256: decoders };
}

function inspectImage(options, evidence, execute) {
  let image;
  try { image = JSON.parse(execute(options.docker, ['image', 'inspect', options.image], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))[0]; }
  catch { return fail('image_inspection_failed'); }
  evidence.observed_image_id = /^sha256:[a-f0-9]{64}$/.test(image?.Id ?? '') ? image.Id : null;
  const labels = image?.Config?.Labels ?? {};
  const observedLabels = Object.fromEntries(Object.keys(evidence.expected_labels).map(key => {
    const value = labels[key];
    const pattern = key.endsWith('.revision') ? /^[a-f0-9]{40}$/ : key.endsWith('.version') ? versionPattern : /^(true|false)$/;
    return [key, typeof value === 'string' && pattern.test(value) ? value : null];
  }));
  evidence.label_mismatches = Object.keys(evidence.expected_labels).filter(key => observedLabels[key] !== evidence.expected_labels[key]);
  evidence.observed_labels = Object.fromEntries(Object.keys(evidence.expected_labels).map(key => {
    if (observedLabels[key] === evidence.expected_labels[key]) return [key, observedLabels[key]];
    if (!Object.hasOwn(labels, key)) return [key, 'missing'];
    if (observedLabels[key] === null) return [key, 'invalid'];
    return [key, 'sha256:' + digest(observedLabels[key])];
  }));
  need(evidence.observed_image_id, 'image_id_invalid');
  need(same(observedLabels, evidence.expected_labels), 'image_labels_mismatch');
  return evidence.observed_image_id;
}

function expectedSnapshot(snapshot, source, worker, evidence) {
  need(snapshot && snapshot.schema_version === 1, 'image_receipt_invalid');
  evidence.expected_source = safeSource(snapshot.source);
  evidence.expected_worker_sha256 = safeHash(snapshot.worker_sha256);
  evidence.expected_installer_sha256 = safeHash(snapshot.installer_sha256);
  evidence.expected_decoder_sha256 = safeDecoders(snapshot.decoder_sha256);
  need(same(snapshot.source, source), 'source_drift');
  need(snapshot.worker_sha256 === worker.worker_sha256 && snapshot.archive === worker.archive, 'worker_archive_binding_mismatch');
  need(snapshot.installer_sha256 === worker.installer_sha256, 'worker_installer_digest_mismatch');
  need(same(snapshot.decoder_sha256, worker.decoder_sha256), 'worker_decoder_digest_mismatch');
}

export function main(args = process.argv.slice(2), { root = process.cwd(), inspect = inspectSource, execute = execFileSync } = {}) {
  let options;
  const evidence = { cause: null, image: null, expected_image_id: null, observed_image_id: null, expected_labels: null,
    observed_labels: null, label_mismatches: [], expected_source: null, observed_source: null, expected_product_version: null, observed_product_version: null,
    expected_worker_sha256: null, observed_worker_sha256: null, expected_installer_sha256: null, observed_installer_sha256: null,
    expected_decoder_sha256: null, observed_decoder_sha256: null,
    missing_dist_files: [], remediation: 'make image' };
  try {
    options = parseArgs(args);
    evidence.image = options.image;
    evidence.expected_product_version = options.version;
    evidence.expected_labels = { 'org.opencontainers.image.revision': options.sha, 'org.opencontainers.image.version': options.version,
      'io.aaa-muse.source-dirty': String(options.dirty) };
    const source = observedSource(root, inspect, options, evidence);
    const directory = join(root, '.artifacts/service-image');
    const capturePath = join(directory, 'source.json'), buildPath = join(directory, 'build.json'), receiptPath = join(directory, 'latest.json');
    if (options.mode === 'capture') {
      writeJSON(capturePath, { schema_version: 1, source });
    } else {
      const preparing = options.mode === 'prepare';
      const prior = readJSON(preparing ? capturePath : options.mode === 'write' ? buildPath : receiptPath,
        preparing ? 'source_capture_unavailable' : 'image_receipt_unavailable');
      need(prior && prior.schema_version === 1, 'image_receipt_invalid');
      evidence.expected_source = safeSource(prior.source);
      evidence.expected_worker_sha256 = safeHash(prior.worker_sha256);
      evidence.expected_installer_sha256 = safeHash(prior.installer_sha256);
      evidence.expected_decoder_sha256 = safeDecoders(prior.decoder_sha256);
      if (options.mode === 'verify') evidence.expected_image_id = /^sha256:[a-f0-9]{64}$/.test(prior.image_id ?? '') ? prior.image_id : null;
      need(same(prior.source, source), 'source_drift');
      const worker = workerSnapshot(root, source, options, evidence);
      if (preparing) {
        writeJSON(buildPath, { schema_version: 1, source, ...worker });
      } else {
        expectedSnapshot(prior, source, worker, evidence);
        need(options.mode === 'write' || prior.image === options.image, 'image_name_mismatch');
        const imageID = inspectImage(options, evidence, execute);
        if (options.mode === 'write') {
          writeJSON(receiptPath, { ...prior, image: options.image, image_id: imageID, labels: evidence.observed_labels, product_version: options.version });
        } else {
          need(prior.product_version === options.version && same(prior.labels, evidence.expected_labels), 'receipt_labels_mismatch');
          need(prior.image_id === imageID, 'image_id_mismatch');
        }
      }
    }
    const event = { capture: 'ci.image_source_captured', prepare: 'ci.image_build_prepared',
      write: 'ci.image_receipt_written', verify: 'ci.image_receipt_verified' }[options.mode];
    logEvent(null, 'info', event, safeEvidence({ ...evidence, operation: options.mode }));
    return 0;
  } catch (error) {
    evidence.cause = /^[a-z_]+$/.test(error.cause ?? '') ? error.cause : 'image_receipt_failed';
    logEvent(null, 'error', 'ci.image_receipt_rejected', safeEvidence(evidence));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
