# Paired product releases

The service and worker share one full release version and source SHA. A service
accepts every worker in its product major. Minor and patch releases keep that
worker contract in both version orders. Product versions and
`protocol_version: 1` identify separate contracts.

Workers advertise `X-Muse-Worker-Version` on HTTPS requests. Services
return `X-Muse-Service-Version`. Incompatible enrollment and starts return HTTP 426 `update_required`. Capable workers can negotiate an update without claiming work. Malformed
or duplicate version headers return 400. Only major-zero services accept an
absent legacy header. Legacy status never proves an exact installed version.
New nonzero workers preflight a legacy server before sending an enrollment code.
Major 1 uses native cron and a fresh store; do not reuse a major-0 worker or its configuration. Compatibility is not authentication.

At INFO, `worker.compatibility_accepted` records the boundary and legacy status;
WARN `worker.update_required` records service/worker versions, recommended
artifact and rejected new authority. The CLI emits ERROR `worker.update_required`
with manual corrective action and no retry or installation. Export the broker
diagnostics by the recorded request ID and the worker's protected diagnostics
through the existing CLI. Keep credential files private; never copy their values
into the diagnostic request or report. Missing captures remain incomplete.

## Automatic worker updates

An idle updater-enabled worker follows the exact package paired with the deployed
broker. The target can be a release candidate, a stable release or an earlier
updater-enabled release. Workers fetch the canonical public archive over HTTPS
and verify its digest, version and source before switching the existing launcher.
A worker reports the running version on authenticated pickup and busy check-in.
The target becomes confirmed after the same worker makes a fresh pickup from it.

Apply the first updater-enabled broker release with all older broker processes
stopped. Back up the SQLite store before the service applies migration 004.
Automatic rollback starts with the first updater-enabled release. Older brokers
require a compatible store and an operator-managed rollback. Later updater-enabled
brokers defer worker package switches while active brokers advertise different
release pins. A same-version digest conflict calls for verifying the deployed
images and release receipt.

An automatic major transition requires the paired image and archive to declare
support for the source worker's updater, state, credential and native checker.
The portal shows **Migration required** when that declaration is missing.
The major-0 to major-1 cutover uses separate configuration, credentials and storage.

From **Workers**, open an existing major-1 worker and copy **Enable automatic
updates** into its own Muse goal once. Wait for a fresh pickup to report the
target version. A worker with active or uncertain work waits for reconciliation.
If a download fails and the previous release is compatible and verified, the
worker serves jobs during retry backoff. An integrity failure calls for operator
inspection of the paired archive. An uncertain launcher switch keeps the worker
reserved pending recovery.

## Publication

Successful CI for an eligible merge to main triggers the paired publisher. It
increments the active patch series' RC number using the reserved Git tags and
reuses the same version for a retry of the same source. While stable is major 0,
new paired prereleases use `1.0.0-rc.N`. A completed major-1 stable promotion starts the next patch series at
`rc.0`. The publisher packs and verifies the worker, embeds that archive's digest and
the shared version in the service image, smoke-tests the image, and checks the
same worker bytes on the minimum Node runtime. Service-only releases still
publish their paired worker. Operator configuration has no package selector.

The workflow verifies immutable npm and public worker archives, then publishes
the service under both version and source-SHA tags. `product-release.json`
identifies the shared source/version, image digest and worker archive digest.
Only verified destinations and an anonymously retrieved matching receipt permit
the product completion marker. Failed or partial publications retain their
artifacts and source-bound version; retries verify existing bytes and publish
only missing destinations. Conflicts fail rather than overwrite anything.
Artifact publication is not a live Muse qualification receipt.

Schema-two `product-release.json` additionally identifies the Git tree, wire
protocol and SHA-256 of `package/setup/install.sh` extracted from the verified
worker archive. Qualification and promotion receipts remain separate files;
the candidate manifest is never rewritten. Historical receipts remain readable
with their missing identity fields explicit. They cannot satisfy final-candidate
verification and are never upgraded by inference.

The previous independent worker publisher is folded into this workflow because
it skipped service-only changes and could select a version independently.
Existing legacy releases are retained. Actual publication remains subject to
the owner's authorization and the repository's human merge gate.

## Publish stable from a paired prerelease

An administrator dispatches **Publish stable release** from `main`. Enter the exact
latest complete paired RC tag and the stable product version. For example, when
`v1.0.0-rc.0` is the latest complete RC:

```sh
gh workflow run release.yml --repo markhuangai/AaA-muse-ai --ref main \
  -f prerelease_tag=v1.0.0-rc.0 -f stable_version=1.0.0
```

The dispatch authorizes stable publication. The job verifies the named RC,
commit, tree, main CI including `Release / verify`, CodeQL, and each published
artifact. If a newer complete RC appears before the first stable write, review
that RC and dispatch again with its tag. A conflicting marker or artifact blocks
the run.

The native-cron source is for major 1. A selected major-1 RC cannot build or
promote a new major-0 version. The initial target for this cutover is `1.0.0`.
The historical `v0.1.0` candidate still reserves its npm version. Version
conflicts require an eligible unused version; never republish historical bytes
under an existing tag.
After a complete `1.0.0` publication, the next eligible merge starts the
`1.0.1-rc.0` series. An automatic transition to a new major requires the
migration declaration in both the broker image and the worker archive.

The workflow builds and smoke-tests the requested version from the verified RC
commit and tree. It checks the same worker on Node 22.12.0 and freezes
`worker.tgz`, `image.tar`, and `bundle.json` before publication. It stages the
final pair as a prerelease while the artifacts are being verified. In the same
run, it gives the existing GHCR image digest the stable version and `latest`
tags, moves npm `latest` to the verified worker version, and marks the GitHub
Release stable and latest. `promotion.json` records the verified destinations
and `live_qualification: not_established`. GitHub Packages and the public
Release contain identical worker bytes.

## Verification and incomplete publication

`make verify-release` builds and smoke-tests controlled `1.0.0` artifacts and
exercises publication against replaceable external I/O. It covers conflicts,
partial recovery, source drift, anonymous downloads, and promotion of the
frozen bytes. `Release / verify` retains `.artifacts/ci/release/receipt.json`
for seven days.

For read-only verification of a published schema-two pair:

```sh
RELEASE_TAG=v0.1.1 RELEASE_SOURCE_SHA='<verified-merge-sha>' \
RELEASE_MANIFEST_SHA256='<trusted-published-manifest-sha256>' make verify-release
```

Set `GH_TOKEN` privately with package-read authority. The verifier downloads
public worker assets anonymously and checks Git source and tree, embedded
versions, image configuration, and worker and installer bytes against the
pinned manifest digest.

For an incomplete publication, re-dispatch with the same inputs. The workflow
looks up the original `release-bundle-VERSION-SOURCE_SHA` artifact, retained
for seven days, or verifies the complete published pair. Conflicting
destinations or missing original bytes stop recovery. Once the versioned stable
image matches the saved intent, that promotion can finish even if a newer RC
has shipped. A saved intent by itself still requires the latest RC check.
Another started and incomplete stable promotion blocks a new one.
A major-zero RC cannot start a new build or stable promotion. With its exact
original run and artifact ID, recovery can finish a frozen candidate's
version-scoped destinations without moving shared release aliases. An already
started stable promotion uses its original verified intent as before.

Collect the exact job log with `gh run view RUN_ID --job JOB_ID --log` and filter
`product.release.*` or `worker.release.*` events by `operation_id`. INFO records
the verified source, version, and outcome. WARN identifies an incomplete
destination or a resumed promotion. ERROR records the failed operation,
requested pair, observed identity, completed destinations, causal status,
timing, and attempt. A stale source lists both RC tags. A conflict identifies the
destination and digest. A transport failure records the HTTP or process status.
Authentication-bearing output is omitted. `product.release.runner_cleanup`
records owned local-image cleanup.

## Live qualification evidence

The [final #18 record](https://github.com/markhuangai/AaA-muse-ai/issues/18#issuecomment-6947082016)
retains rc.11's 30/35 formal cases and inconclusive verdict. Exact artifact
identities bound that evidence. Live trials and deployments require their own
owner authorization.

When separately authorized complete live evidence exists, the qualification
tool can produce a safe independent receipt:

```sh
node tools/release-qualification.mjs candidate-manifest.json \
  /private/qualification/report.json /private/qualification/final-receipt.json
```

The validator reopens the protected report and exports and requires the exact
candidate source, version, image, installed workers and installer. Keep the
report and exports private. Historical promotion receipts retain their original
qualification evidence.

## Major-1 clean cutover

For a major-0 installation, use the
service's paired release receipt for the exact version and trusted archive
digest. Major 1 does not reuse major-0 configuration, keys, worker enrollment,
job history or download references. Start with fresh configuration, storage and
media mounts. Keep the original installation and its data intact unless the
owner separately authorizes retirement.

Before retiring an old installation, identify its exact broker configuration,
storage mounts, worker state directories and goal-owned registrations. Reconcile
outstanding work against the old broker and verify that no producer is still
active before stopping its runtime. Ambiguous work remains held. Do not disable
registrations belonging to other goals or remove shared storage. If major 1
refuses an existing mount, correct that installation's mount mapping; do not
erase data to clear the refusal.

Use a fresh enrollment prompt from the major-1 portal. Verify the archive,
private state modes and exactly one enabled goal-owned native agent cron at
`every: "1m"`. Read back its job ID and action, then check the authenticated
first poll. A green native run is not a job receipt. Use the claim-bound native
work run and the broker's terminal receipt to reconcile work. The old release
bundles and their verification records remain available for historical recovery.
