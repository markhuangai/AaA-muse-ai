# Paired product releases

The service and worker share one full release version and source SHA. A service
accepts every worker in its product major; minor and patch releases must retain
that worker contract in both version orders. The existing HTTP routes and
`protocol_version: 1` are separate wire identities. Current release allocation
continues the `0.1.0-rc.N` line rather than inventing a `1.0.0` release.

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

One workflow selects a monotonic, source-bound version using existing legacy and
paired tags. It packs and verifies the worker, embeds that archive's digest and
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

The previous independent worker publisher is folded into this workflow because
it skipped service-only changes and could select a version independently.
Existing legacy releases are retained. Actual publication remains subject to
the owner's authorization and the repository's human merge gate.

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
and one subscriber. Establish independent readiness evidence for the new
connection generation before routing work. This is an operator procedure, not
an automatic repair command or inference retry.
