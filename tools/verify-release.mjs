import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { inspectSource } from './source-inventory.mjs';
import { inspectWorker, need, sameDigest } from '../.github/scripts/release-manifest.mjs';
import { imageConfigDigest } from '../.github/scripts/image-policy.mjs';
import { verifyPublished } from '../.github/scripts/release-verify.mjs';
import { logEvent } from '../.github/scripts/ci-log.mjs';

const controlledVersion = '0.1.1';

export async function main({ env = process.env, execute = execFileSync, read = readFileSync, write = writeFileSync,
  mkdir = mkdirSync, list = readdirSync, inspect = inspectSource, verify = verifyPublished } = {}) {
  const selectors = [env.RELEASE_TAG, env.RELEASE_SOURCE_SHA, env.RELEASE_MANIFEST_SHA256];
  let image, receipt, imageCreated = false;
  try {
    need(selectors.every(Boolean) || selectors.every(value => !value), 'product_release_verification_selectors_required');
    if (selectors.every(Boolean)) {
      const result = await verify({ tag: selectors[0], sourceSHA: selectors[1], manifestSHA256: selectors[2], token: env.GH_TOKEN || env.GITHUB_TOKEN });
      return { exit_code: 0, receipt: result.receipt };
    }
    const source = inspect();
    image = `aaa-muse-release-verification:${process.pid}`;
    execute('make', ['smoke-image', 'PRODUCT_VERSION=' + controlledVersion, `SERVICE_IMAGE=${image}`], { stdio: 'inherit' });
    imageCreated = true;
    const packageReceipt = JSON.parse(read('.artifacts/worker-package/latest.json'));
    const worker = inspectWorker(packageReceipt.archive, { read, execute });
    need(worker.version === controlledVersion && worker.source.source_sha === source.identity.sha, 'product_release_controlled_worker_identity_mismatch');
    sameDigest(worker.sha256, packageReceipt.sha256, 'controlled_worker');
    const built = JSON.parse(execute('docker', ['image', 'inspect', image], { encoding: 'utf8' }))[0];
    need(built.Config.Labels['org.opencontainers.image.version'] === controlledVersion && built.Config.Labels['org.opencontainers.image.revision'] === source.identity.sha,
      'product_release_controlled_image_identity_mismatch');
    const tests = list('.github/scripts').filter(name => /^release.*\.test\.mjs$/.test(name)).sort().map(name => '.github/scripts/' + name);
    need(tests.length > 0, 'product_release_controlled_tests_missing');
    execute(process.execPath, ['--test', ...tests, 'tools/release-qualification.test.mjs'], { stdio: 'inherit' });
    need(inspect().identity.tree_sha256 === source.identity.tree_sha256, 'product_release_controlled_source_drift');
    receipt = { schema_version: 1, source: source.identity, version: controlledVersion, suite: 'controlled_release',
      image_config_digest: imageConfigDigest(built), worker_sha256: worker.sha256, installer_sha256: worker.installer_sha256,
      outcome: 'passed', live_qualification: 'not_established', tests, cleanup: 'pending' };
    return { exit_code: 0, receipt };
  } catch (error) {
    logEvent(null, 'error', 'product.release.verification_failed', { cause: error.fields ? error.message : 'required_verification_operation_failed',
      ...error.fields, process_status: Number.isInteger(error.status) ? error.status : null, outcome: 'incomplete', raw_output_omitted: true });
    return { exit_code: 1 };
  } finally {
    if (imageCreated) {
      execute('docker', ['image', 'rm', '--no-prune', image], { stdio: ['ignore', 'ignore', 'pipe'] });
      logEvent(null, 'info', 'product.release.test_cleanup', { image, outcome: 'removed', remote_images_removed: false });
    }
    if (receipt) {
      receipt.cleanup = 'passed'; mkdir('.artifacts/ci/release', { recursive: true });
      write('.artifacts/ci/release/receipt.json', JSON.stringify(receipt, null, 2) + '\n');
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = (await main()).exit_code;
