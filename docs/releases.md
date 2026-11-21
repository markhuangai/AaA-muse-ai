# Paired product releases

The service and worker share one full release version and source SHA. A service
accepts every worker in its product major. Minor and patch releases keep that
worker contract in both version orders. Product versions and
`protocol_version: 1` identify separate contracts.

New workers advertise `X-Muse-Worker-Version` on HTTP and SSE requests. Services
return `X-Muse-Service-Version`. Incompatible enrollment, subscriptions and
claims return HTTP 426 `update_required` before granting new authority. Malformed
or duplicate version headers return 400. Only major-zero services accept an
absent legacy header. Legacy status never proves an exact installed version.
New nonzero workers preflight a legacy server before sending an enrollment code.
Status, old job reads, heartbeats and decision receipts retain their original
ownership, lease and fencing rules; compatibility is not authentication.

At INFO, `worker.compatibility_accepted` records the boundary and legacy status;
WARN `worker.update_required` records service/worker versions, recommended
artifact and rejected new authority. The CLI emits ERROR `worker.update_required`
with manual corrective action and no retry or installation. Export the broker
diagnostics by the recorded request ID and the worker's protected diagnostics
through the existing CLI. Keep credential files private; never copy their values
into the diagnostic request or report. Missing captures remain incomplete.

## Publication

Successful CI for an eligible merge to main triggers the paired publisher. It
increments the active patch series' RC number using the reserved Git tags and
reuses the same version for a retry of the same source. The initial series is
`0.1.0-rc.N`. A completed stable promotion starts the next patch series at
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
`v0.1.0-rc.16` is the latest complete RC:

```sh
gh workflow run release.yml --repo markhuangai/AaA-muse-ai --ref main \
  -f prerelease_tag=v0.1.0-rc.16 -f stable_version=0.1.1
```

The dispatch authorizes stable publication. The job verifies the named RC,
commit, tree, main CI including `Release / verify`, CodeQL, and each published
artifact. If a newer complete RC appears before the first stable write, review
that RC and dispatch again with its tag. A conflicting marker or artifact blocks
the run.

A stable version can advance one patch, minor, or major, with lower components
reset. The initial release baseline is `0.1.0`. The historical `v0.1.0` candidate
already reserves that npm version. The first available targets are `0.1.1`,
`0.2.0`, and `1.0.0`. Version conflicts require an eligible unused version.
After a complete `1.0.0` publication, the next eligible merge starts the
`1.0.1-rc.0` series. A major release requires a manual worker upgrade.

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
A historical dispatch verifies the exact release and leaves the active
`latest` tags in place.

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

## Manual worker upgrade

An incompatible worker never downloads or installs replacement code. Use the
service's paired release receipt to obtain the exact version and trusted archive
digest. Align product majors by upgrading the service or installing its paired
worker; installing an arbitrary globally latest worker can remain incompatible.

Use the verified enrolled-upgrade helper below to inspect work and retained
journals and reserve the worker's slot before suspending its hook and watchdog.
The helper preserves the worker credential and accepted receipts. It verifies
the subscriber before stopping it and runs the installer with the saved state
and identity.

Verify the installed CLI version, archive provenance and protected modes.
Restore and read back the same hook and watchdog. With owner approval, update
the identified legacy job in place to use the new receipt's `watchdog-check`
command and exact hook ID and path. Verify one subscriber and its current
authenticated heartbeat. The worker resumes dispatch after its authenticated heartbeat and the release of its upgrade reservation.

### Existing worker upgrade prompt

Send this message once to each existing installation after all broker processes sharing its SQLite store run the fixed paired release. The archive pin comes from the enrolled worker's authenticated status. Download the advertised HTTPS archive into a private temporary directory. After checking its SHA-256, extract only the helper with `tar -xOzf "$archive" package/setup/upgrade-enrolled.sh > upgrade-enrolled.sh` in that directory. Keep the archive available for all three helper commands.

> Upgrade this existing AaA Muse worker in place. Use its saved installation and launcher. Run authenticated `status` privately and read the version, URL and SHA-256 from `worker.worker_package`. Verify the archive against that pin before executing any of its contents. If `package/setup/upgrade-enrolled.sh` is absent, report that the fixed paired release is still needed and leave the installation running.
>
> Inventory this installation’s native hook and watchdog, including disabled entries. Verify ownership and required permissions before interruption. Run the verified helper as `bash upgrade-enrolled.sh prepare ARCHIVE STATE_DIR`, using the actual archive and existing state paths. If already current and healthy, verify registrations and finish without restarting. If busy, wait and retry. Stop on conflicting registrations or unsafe state.
>
> Once the helper confirms the reservation, save and suspend only the identified registrations. Run `apply` with the same archive and state directory. Let the helper stop the verified subscriber and handle any evidenced outage latch. Restore and read back the same registrations. Update an identified legacy watchdog in place. For an older hook-only installation, register exactly one missing five-minute watchdog from the verified receipt, with its 300-second timeout. On an aborted attempt, run `cancel` and restore the saved registrations where safe. Report the installed version and the fresh heartbeat generation for one subscriber, or the specific blocker. Keep credentials, job contents and raw logs private.

The reservation is renewable and expires after 120 seconds without renewal. A fenced attempt leaves the process alone. Re-run prepare after restoring the original registrations. Cancel releases only the installation's own attempt. The verified helper can archive a legacy malformed status 404 latch when the protected diagnostics prove its origin. An ambiguous or genuine terminal stop requires inspection of the retained evidence.
