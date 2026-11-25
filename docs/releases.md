# Paired product releases

## Paired broker and worker

Managed hooks use the full broker release, including its RC suffix, and the digest of the worker archive pinned by that broker. Enrollment, pickup, start, media transfer and receipt settlement use hook-specific routes. A version or digest mismatch stops job traffic before it can change a claim or expose its brief.

## Automatic worker updates

Each verified 1.x candidate validates the detector template and the on-disk worker skill before activation. The new binary refreshes both assets from its archive and records their SHA-256 while confirming the update. For the first hop from `v1.1.1-rc.1`, the candidate performs the asset preflight when the installed updater requests its version.


First enroll the managed-hook worker with the pinned prompt in **Workers**. A native-cron worker displays **Migration required**. To switch, drain work and outstanding receipts on the old pair, update the broker, verify the new registration, then remove the identified old cron and revoke its credential. The schema-5 store, client keys and request history stay with the broker.

After that cutover, an idle managed worker can discover a strictly newer 1.x archive when the running brokers agree on its release pin. It downloads the canonical public artifact over HTTPS, checks its version, source and SHA-256, and swaps the launcher atomically. A fresh matching pickup confirms the update. Rollback is unsupported.

New managed-hook enrollments register a five-minute native watchdog. The launcher update leaves any hourly Muse watchdog registered at its existing cadence. Edit that cron in place and verify its native readback, or re-enroll with fresh state. Check `checked_at` in the worker's protected diagnostic export for the observed cadence. Live VM retention at five minutes remains unverified. [Worker update and diagnostics steps](../worker/README.md#updates)

Drain client intake, claims, deliveries and update attempts before switching versions. If a switch interrupts work, the original matching pair is required to reconcile its hold. Use the worker's protected export and the broker diagnostics to identify the observed and expected versions, archive digest and corrective action.

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

The managed-hook source is for major 1. A selected major-1 RC can build or
promote only an eligible major-1 version. Existing tags and npm versions remain
reserved. Automatic updates require a strictly newer 1.x pair. A move to a new
major requires separate enrollment and an operator-controlled cutover.

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

Use a fresh enrollment prompt from the managed-hook portal. Verify the archive
and private state modes. Read back the exact enabled 15-second hook and
goal-owned five-minute watchdog, then confirm an authenticated tick on the new
registration. Reconcile work with the bound wake invocation and the broker's
terminal receipt. The old release bundles and verification records remain
available for historical recovery.
