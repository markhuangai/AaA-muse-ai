# Deploy AaA-muse-ai

## Fresh install

Use Docker Compose on one Linux host with writable, dedicated configuration, SQLite, media and diagnostics mounts. Use the Compose file and image from the same paired release. The `:latest` tag follows the stable release. When you pin the image, use a verified digest from a release that supports the shipped `serve` command. [Paired releases](releases.md)

Create and edit `config/config.yaml` as the host account that will maintain it.

```sh
umask 077
mkdir -p config
cp -n config.example.yaml config/config.yaml
```

Set distinct values for `management.key` and `control-portal.password` in the private YAML.

```sh
docker compose up -d
curl -fsS http://127.0.0.1:8080/readyz
```

Compose creates missing bind sources and its diagnostics volume. The broker starts with the supplied filesystem and identity capabilities, secures its mount roots and broker-managed files, and drops all root IDs and supplementary groups before serving. It chooses the first non-root owner from `config.yaml`, `broker.sqlite3`, and the config directory. The fallback is `1000:1000`. A selected group of zero becomes the selected UID. The resulting owner can still edit the YAML after the portal atomically replaces it.

If startup finds an empty config mount, it reports the required YAML path and stops. If the directory was created under a different fallback UID, make that directory writable by the account that will maintain the YAML, then supply the file and restart. Automatic repair uses Linux `openat2` and local file locking. Host owner mappings assume a rootful Docker engine using the host’s user namespace. Direct image runs default to `10001:10001` and accept a readable single-file configuration mount.

The `8080:8080` mapping publishes plain HTTP on all host interfaces. Restrict direct access at the network boundary and serve the portal and API through the same HTTPS reverse proxy. Allow at least 330 seconds for inference responses. A ready broker returns HTTP 200 with `"ready":true`. `GET /healthz` checks the HTTP process. Keep the management key in a protected header file if you use the management API. When YAML leaves it empty, startup prints a generated management key once.

## Upgrade existing storage

For existing storage, use a verified image from the installation’s current major. An older Compose file can run a newer compatible image using its existing `prepare-mounts` command. The one-service Compose file needs a release that supports `serve`. An older image rejects that command before it opens the HTTP port.

For a planned major-0 to major-1 cutover, start in a separate Compose directory and project with a verified major-1 image, fresh YAML and credentials, empty SQLite and media directories, and fresh worker enrollment. Use a different host port if both stacks run on the same host. Keep the old files and registrations intact. `db.fresh_store_required` indicates a legacy SQLite file. `media.namespace_rejected` can indicate a populated, unmarked media directory. Correct the mount sources in either case. Namespace markers, prior job history, and download references belong to their original store. [Major-1 clean cutover](releases.md#major-1-clean-cutover)

For the first managed-hook release, drain client intake, held claims, deliveries and update attempts on the existing paired release. Back up the private SQLite store. Remove the old brokers from the serving origin before enrolling the new worker. Verify the 15-second hook and five-minute watchdog registrations before retiring the identified legacy cron and worker credential. Later managed-hook updates use the same drain before the broker changes version. [Paired releases](releases.md#automatic-worker-updates)

After upgrading an hourly watchdog's launcher, edit the native schedule in Muse or enroll a worker with fresh state. Read back the scheduled cadence in the owning goal and compare it with `checked_at` in a complete worker diagnostics export. Live VM retention at five minutes remains unverified. [Worker update and diagnostics steps](../worker/README.md#updates)

For a same-major replacement, inspect the old service container even if it is stopped. Record its project, runtime user, image, and exact mounts.

```sh
docker inspect OLD_SERVICE_CONTAINER --format '{{index .Config.Labels "com.docker.compose.project"}} {{.Config.User}} {{.Config.Image}}{{range .Mounts}}{{println}}{{println .Destination .Type .Name .Source}}{{end}}'
docker image inspect "$(docker inspect OLD_SERVICE_CONTAINER --format '{{.Image}}')" \
  --format '{{index .Config.Labels "org.opencontainers.image.version"}} {{join .RepoDigests " "}}'
```

- `/etc/aaa-muse-ai` holds `config.yaml` and its client keys. Keep the original directory bind, or copy the original single-file bind to the dedicated directory with `cp -n OLD_CONFIG config/config.yaml`. Keep the YAML owned by the account responsible for editing it. If the YAML references variables such as `${MUSE_PORTAL_PASSWORD}`, pass each existing variable through the broker’s `environment` mapping, for example `MUSE_PORTAL_PASSWORD: ${MUSE_PORTAL_PASSWORD}`.
- `/var/lib/aaa-muse-ai/state` and `/var/lib/aaa-muse-ai/media` hold SQLite and media. For bind mounts, set the mount sources in `compose.yaml` to the exact inspected paths, including `sqlite-v1` and `media-v1` where used. For named volumes, set `MUSE_SQLITE_VOLUME` and `MUSE_MEDIA_VOLUME` in `.env` to the inspected **Name** values and use `compose.named-volumes.yaml` as shown below. Docker requires those external volumes to exist.
- `/var/lib/aaa-muse-ai/diagnostics` uses the original volume when you pass its original project name with `-p OLD_PROJECT`. If the volume has a custom name, declare it in the top-level `diagnostics` volume with `external: true` and `name` set to its inspected **Name**.

Use `-p OLD_PROJECT` for an existing Compose project. For named storage, include both files on every command.

```sh
docker compose -p OLD_PROJECT -f compose.yaml -f compose.named-volumes.yaml config --quiet
docker compose -p OLD_PROJECT -f compose.yaml -f compose.named-volumes.yaml up -d service
```

Confirm the rendered mount sources before starting and check readiness, mounts, and prior registrations afterward. Match the original port mapping in `compose.yaml` if the reverse proxy still uses it. Stop all brokers using the store before handing it to a different YAML owner. Startup repairs broker-managed modes and ownership in place. Store contents and external volume names carry through the upgrade. Brokers sharing the same SQLite database should use the same owner and dedicated diagnostics volumes.

## SQLite state and cutover

Keep `broker.sqlite3`, its WAL and its shared-memory sidecar together on a local filesystem. SQLite requires the directory to be `0700` and the database and sidecars to be regular files with mode `0600`. Same-host sibling brokers use the same SQLite version and storage. For a backup, stop all brokers writing to the database and copy the complete private state directory. Back up configuration and protected diagnostics separately. Media has its own expiry lifecycle.

Protected diagnostics append to private `segment-*.ndjson` files. Legacy `capture-*.ndjson` files remain readable after an upgrade and age out under the same retention limits. Keep each broker's diagnostics directory dedicated to that process. Fully appended, unpruned captures survive a process-only crash; a torn tail is identified as incomplete in the export. Dirty segments sync in the background at a 250 ms target interval, on rotation, and during clean shutdown. This is not a sudden host power-loss bound. The SQLite store remains in WAL mode with `synchronous=FULL`.

Take this backup and stop every older broker before starting the first broker with automatic worker updates. That release applies migration 004. [Automatic worker updates](releases.md#automatic-worker-updates)

Schema 6 adds remote worker operations, background tasks, and a shared claim slot. It retains existing inference holds and the checksums of migrations 001–005. Back up the state directory while all brokers are stopped, then upgrade every broker that shares it to the current release. Previous broker binaries require their original SQLite schema. Keep the backup for recovery.

The queue maintains FIFO index entries for fixed, aligned ranges of job deadlines. A pull seeks only the head of each eligible range in priority order; neither expired nor live backlog expands the number of candidates inspected. Queue state and index membership change in the same SQLite transaction. Use the protected pull timing to separate scheduler entry delay, SQLite writer acquisition, and queue lookup.

For the earlier PostgreSQL-to-SQLite migration, consult the [historical major-0 procedure](https://github.com/markhuangai/AaA-muse-ai/blob/7b772e5dc1771d3e8d4de178ffe61dc99d4c6939/docs/deployment.md#upgrade-existing-storage). It is not a major-1 migration procedure or authorization to retire an existing deployment.

## Startup troubleshooting

Compose reports missing declared external volumes before the broker starts. Compare resolved sources with the previous container when upgrading. Use the service logs for configuration and mount failures.

```sh
docker compose logs --no-log-prefix service |
  jq -R 'fromjson? | select(.msg=="config.rejected" or (.msg|startswith("mounts.")))'
```

| Event or reason | Check |
| --- | --- |
| `mounts.prepare_failed`, `open_config`, `not_found` | Put the private `config.yaml` at the logged path. Check the bind source and the file extension. |
| `read_only`, `symlink`, `multiple_links`, `unexpected_file_type`, `nested_mount` | Use writable, dedicated directories with singly linked regular files. Check for nested mounts at the reported target. |
| `mounts_in_use` | Check for another broker using the SQLite state. Stop the other brokers before changing ownership. |
| `root_bootstrap_required`, `permission_denied` | Check the Compose user, capabilities, ownership mapping and the target’s mount type. |
| `config.rejected`, `read_failed` | Verify configuration readability. Direct runs using a custom `-config` path report the path as `custom`. |

Match `operation_id` and `revision` across startup events. `mounts.prepared` reports the owner source, selected identity and number of repairs. The corresponding error event reports the failed stage, expected and observed metadata, and the next corrective action. [Portal key persistence](portal.md#client-keys)
