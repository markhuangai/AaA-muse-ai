# Paired product releases

The service and worker share one full release version and source SHA. A service
accepts every worker in its product major; minor and patch releases must retain
that worker contract in both version orders. The existing HTTP routes and
`protocol_version: 1` are separate wire identities. The current release line allocates `0.1.X-rc.N` and stamps the
selected final candidate `0.1.X`.

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

## Final-version candidate

After the owner merges the reviewed workflow and authorizes candidate publication,
an administrator dispatches `.github/workflows/release.yml` from `main` with
`phase=candidate`. The workflow selects the highest-numbered complete paired RC
in the active series. It verifies the exact release, artifact digests, merged
main source, successful main CI including `Release / verify`, and CodeQL.
An incomplete newer RC is ineligible. A verified completion marker with
conflicting artifacts blocks selection.

The allocator uses the RC's base as the minimum final version and advances
above existing final version reservations. The previously published
`v0.1.0` prerelease consumes that npm version. For example, a new candidate
selected from rc.13 with only that final reservation would use `0.1.1`.
The workflow logs the selected RC, version, and source and pins the originating
RC tag and manifest SHA-256 in the bundle and final manifest. Executable release
helpers come from the trusted workflow revision. The build uses the exact RC
commit and tree.

The workflow builds and smoke-tests final-version bytes once and checks the
same worker on Node 22.12.0. It freezes `worker.tgz`, `image.tar`, and
`bundle.json` in `release-bundle-VERSION-SOURCE_SHA` before publication.
This immutable workflow artifact is retained for seven days.

| Destination | Example for version 0.1.1 |
| --- | --- |
| GitHub Packages | `@markhuangai/aaa-muse-worker@0.1.1` with dist-tag `candidate-0.1.1` |
| Public GitHub Release | `v0.1.1` marked prerelease with the service's paired installation assets |
| GHCR | `candidate-0.1.1` and `sha-SOURCE_SHA-0.1.1` with identical manifest digests |

The npm `candidate` alias advances after the exact pair verifies. The candidate
receipt supplies the final version and manifest SHA-256 for live qualification.
Existing exact tags and packages are reservations. A fix to published bytes
requires another version. Historical pairs remain verifiable after aliases move.

## Verification and incomplete publication

After the independent plan audit, `make verify-release` builds and smoke-tests
controlled `0.1.1` artifacts and exercises the production release logic against
replaceable external I/O. It proves conflicts, missing destinations, partial
recovery, source drift, anonymous downloads, qualification rejection and
promotion without rebuilding. Its safe receipt is
`.artifacts/ci/release/receipt.json`; `Release / verify` retains it for seven days.
These controlled results never qualify live Muse.

For read-only verification of a published schema-two pair:

```sh
RELEASE_TAG=v0.1.1 RELEASE_SOURCE_SHA='<verified-merge-sha>' \
RELEASE_MANIFEST_SHA256='<trusted-candidate-manifest-sha256>' make verify-release
```

Set `GH_TOKEN` privately with package-read authority; never pass it as a command
argument. Worker and receipt Release downloads deliberately use no token.
The verifier checks every destination, Git source/tree, embedded versions,
image configuration and archive/installer bytes. All three selectors are
required together. It does not infer trusted digests from a mutable tag.

A failed publication remains incomplete. Re-dispatch `phase=candidate` for
the same latest RC to recover its original bundle. `resume_run_id` can name
that trusted run explicitly. The workflow verifies existing destinations and
publishes only missing identical bytes. Inspect the destination after an
ambiguous write. Conflicting artifacts, an unrelated reservation, or a missing
or expired original bundle block recovery. A newer complete RC supersedes
the earlier candidate for a new promotion.

Collect the exact job logs with `gh run view RUN_ID --job JOB_ID --log`. Filter
`worker.release.*` and `product.release.*` JSON events by `operation_id`, source
and version. INFO records verified boundaries/outcomes, WARN identifies missing
destinations, and ERROR identifies the failed operation, expected/observed
digests, causal status, completed destinations, timing and attempt. These fields
distinguish a credential/transport failure from an immutable conflict and tell
the operator whether to reconcile, supply the original bundle or stop. Raw
authentication-bearing output is explicitly omitted. Safe receipts retain no
credentials. `product.release.runner_cleanup` proves owned local-image cleanup;
published artifacts and the recovery bundle remain retained.

## Qualification and stable promotion

The [final #18 record](https://github.com/markhuangai/AaA-muse-ai/issues/18#issuecomment-6947082016)
is baseline evidence for rc.11's exact source/image/worker/installer identities.
It retains 30/35 formal cases and an inconclusive verdict. Functional acceptance
did not waive the passing-live gate. Stamping `0.1.0`, repacking or rebuilding
creates new identities. Map retained behavior evidence to those changes and
validate affected final-artifact requirements; do not repeat unrelated live
cases without a concrete requirement. Both former test credentials are revoked.
Further account use or live validation needs separate owner authorization.

When separately authorized complete live evidence exists, generate a safe
receipt by reopening its protected report and every export:

```sh
node tools/release-qualification.mjs candidate-manifest.json \
  /private/qualification/report.json /private/qualification/final-receipt.json
```

The existing validator must return a complete live pass, with exactly matching
candidate source, version, image, installed workers and installer. Synthetic,
missing, altered and mismatched evidence fails. Keep the report and exports
private; the output contains only safe identities/digests. The owner reviews
the generated receipt and uploads that safe file, without replacement, as an
asset of the selected final-version prerelease.

Only an explicit owner-authorized administrator dispatch of `phase=promote`
may publish stable distribution tags. Supply the final version,
`manifest_sha256`, `qualification_asset_id`, `qualification_sha256`, and exact
confirmation `promote X.Y.Z MANIFEST_SHA256 QUALIFICATION_SHA256` with the
candidate's final version substituted for `X.Y.Z`. The pinned manifest supplies
the source. The current latest complete RC must match before stable publication
begins. Separate execution authorization covers deployment and live validation.

Promotion records the approved digests and prior stable identity in
`promotion-intent.json`. It copies the verified image digest to GHCR `X.Y.Z`,
advances GHCR and npm `latest` from their verified prior targets, and marks
the same Release stable and latest. It then re-reads every stable destination
and uploads `promotion.json`. Promotion uses the original verified image and
worker bytes. Unknown or conflicting stable destinations block writes.

If the versioned stable image tag already verifies against its saved intent,
retry the same promotion inputs to reconcile the remaining destinations.
That retry completes the original operation even if a newer RC has since shipped.
A saved intent alone still requires the latest RC check. Another started and
incomplete promotion blocks a new one. A completed promotion can be verified
again by exact version after `latest` moves. Close #19 after the first complete
stable promotion and passing qualification receipt verify.

## Manual worker upgrade

An incompatible worker never downloads or installs replacement code. Use the
service's paired release receipt to obtain the exact version and trusted archive
digest. Align product majors by upgrading the service or installing its paired
worker; installing an arbitrary globally latest worker can remain incompatible.

Before changing the installation, inspect current work and retained journals.
An offline subscriber does not prove native inference stopped. Wait for a known
idle state; preserve any unresolved work, accepted receipt and worker credential.
Stop only the identified subscriber using the supported Muse shell controls.
Run the existing verified installer with the retained state and identity; do not
delete state, re-enroll, or add another hook. The installer refuses to replace a
different running version. Terminal-stop markers require diagnosis; never
remove one simply to restart a revoked or uncertain installation.

Verify the installed CLI version, archive provenance, protected modes, one hook
and one subscriber. Retain the enrolled worker's approved capability across
authenticated reconnects; initial approval still requires independent proof.
This is an operator procedure, not
an automatic repair command or inference retry.
