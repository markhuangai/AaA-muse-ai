# Deploy AaA-muse-ai

## Fresh install

Use Docker Compose on one Linux host with dedicated local directories for configuration, SQLite, and media. The Compose file follows the stable `:latest` image. To pin a verified paired release, set both `image` entries to its published digest. Numeric IDs in this guide assume Docker uses the host’s user namespace. On remapped or rootless engines, identify the corresponding container IDs first. [Paired releases](releases.md)

From your Compose directory, create the host directories and supply `config/config.yaml`.

```sh
umask 077
mkdir -p config sqlite media
cp -n config.example.yaml config/config.yaml
```

Set distinct values for `management.key` and `control-portal.password` in the private `config/config.yaml`.

The broker defaults to `1000:1000`. If a different non-root account owns the YAML, look up its numeric owner with `stat -c '%u:%g' config/config.yaml`. Set `service.user` and the argument to `prepare-mounts` to that same pair so the account keeps access after a portal save. The setup container runs as `0:0` and sets directory mode `0700` and YAML mode `0600` before the broker starts.

```sh
docker compose config --quiet
docker compose up -d service
curl -fsS http://127.0.0.1:8080/readyz
```

The `8080:8080` mapping publishes plain HTTP on all host interfaces. Restrict direct access at the network boundary and serve the portal and API through the same HTTPS reverse proxy. Allow at least 330 seconds for inference responses. A ready broker returns HTTP 200 with `"ready":true`. `GET /healthz` checks the HTTP process. Keep the management key in a protected header file if you use the management API. When YAML leaves it empty, startup prints a generated management key once.

## Upgrade existing storage

Pin both Compose services to a verified image from the installation’s current major before reusing storage. For an installation running `1.0.0-rc.0`, the matching image is `ghcr.io/markhuangai/aaa-muse-ai@sha256:11b46f321c353f20a0a65823e927d9e6aef54ad67f1b8aa30ea608b833846d86`. The `:latest` tag follows stable publication and can select a different major. [Published v1 prerelease](https://github.com/markhuangai/AaA-muse-ai/releases/tag/v1.0.0-rc.0)

For a planned major-0 to major-1 cutover, start in a separate Compose directory and project with a verified major-1 image, fresh YAML and credentials, empty SQLite and media directories, and fresh worker enrollment. Use a different host port if both stacks run on the same host. Keep the old files and registrations intact. `db.fresh_store_required` indicates a legacy SQLite file. `media.namespace_rejected` can indicate a populated, unmarked media directory. Correct the mount sources in either case. Namespace markers, prior job history, and download references belong to their original store. [Major-1 clean cutover](releases.md#major-1-clean-cutover)

For a same-major replacement, inspect the old service container even if it is stopped. Record its project, runtime user, image, and exact mounts.

```sh
docker inspect OLD_SERVICE_CONTAINER --format '{{index .Config.Labels "com.docker.compose.project"}} {{.Config.User}} {{.Config.Image}}{{range .Mounts}}{{println}}{{println .Destination .Type .Name .Source}}{{end}}'
docker image inspect "$(docker inspect OLD_SERVICE_CONTAINER --format '{{.Image}}')" \
  --format '{{index .Config.Labels "org.opencontainers.image.version"}} {{join .RepoDigests " "}}'
```

- `/etc/aaa-muse-ai` holds `config.yaml` and its client keys. Keep the original directory bind, or copy the original single-file bind to the dedicated directory with `cp -n OLD_CONFIG config/config.yaml`. Use the original UID and GID in both the helper command argument and `service.user`. If the YAML references variables such as `${MUSE_PORTAL_PASSWORD}`, pass each existing variable through the broker’s `environment` mapping, for example `MUSE_PORTAL_PASSWORD: ${MUSE_PORTAL_PASSWORD}`.
- `/var/lib/aaa-muse-ai/state` and `/var/lib/aaa-muse-ai/media` hold SQLite and media. For bind mounts, set the shared mount sources in `compose.yaml` to the exact inspected paths, including `sqlite-v1` and `media-v1` where used. For named volumes, set `MUSE_SQLITE_VOLUME` and `MUSE_MEDIA_VOLUME` in `.env` to the inspected **Name** values and use `compose.named-volumes.yaml` as shown below. Docker requires those external volumes to exist.
- `/var/lib/aaa-muse-ai/diagnostics` uses the original volume when you pass its original project name with `-p OLD_PROJECT`. If the volume has a custom name, declare it in the top-level `diagnostics` volume with `external: true` and `name` set to its inspected **Name**.

Use `-p OLD_PROJECT` for an existing Compose project. For named storage, include both files on every command.

```sh
docker compose -p OLD_PROJECT -f compose.yaml -f compose.named-volumes.yaml config --quiet
docker compose -p OLD_PROJECT -f compose.yaml -f compose.named-volumes.yaml up -d service
```

Confirm the rendered mount sources before starting and check readiness, mounts, and prior registrations afterward. Match the original port mapping in `compose.yaml` if the reverse proxy still uses it. A populated directory owned by another ID requires the existing service identity or an offline ownership migration. The setup service changes data-directory ownership only on empty directories.

## SQLite state and cutover

Keep `broker.sqlite3`, its WAL and its shared-memory sidecar together on a local filesystem. SQLite requires the directory to be `0700` and the database and sidecars to be regular files with mode `0600`. Same-host sibling brokers use the same SQLite version and storage. For a backup, stop all brokers writing to the database and copy the complete private state directory. Back up configuration and protected diagnostics separately. Media has its own expiry lifecycle.

The queue maintains FIFO index entries for fixed, aligned ranges of job deadlines. A pull seeks only the head of each eligible range in priority order; neither expired nor live backlog expands the number of candidates inspected. Queue state and index membership change in the same SQLite transaction. Use the protected pull timing to separate scheduler entry delay, SQLite writer acquisition, and queue lookup.

For the earlier PostgreSQL-to-SQLite migration, consult the [historical major-0 procedure](https://github.com/markhuangai/AaA-muse-ai/blob/7b772e5dc1771d3e8d4de178ffe61dc99d4c6939/docs/deployment.md#upgrade-existing-storage). It is not a major-1 migration procedure or authorization to retire an existing deployment.

## Startup troubleshooting

On standard Linux Docker, Compose reports missing host directories or external volumes before the broker can start. Docker Desktop file sharing can create empty bind-source directories. Compare resolved mount sources to the previous container before upgrading. Once the containers exist, filter their logs to configuration and mount events.

```sh
docker compose logs --no-log-prefix prepare-mounts service |
  jq -R 'fromjson? | select(.msg=="config.rejected" or (.msg|startswith("mounts.")))'
```

| Event or reason | Check |
| --- | --- |
| `mounts.prepare_failed`, `open_directory`, `permission_denied` | Check that `prepare-mounts.user` is `0:0` and its command targets the broker’s UID and GID. `observed: null` means the helper could not open the reported directory to inspect it. |
| `config.rejected`, `read_failed`, `not_found` | Verify the directory mount exposes `/etc/aaa-muse-ai/config.yaml`. The `.yml` spelling is common in host files. Verify the target spelling and the actual source. |
| `read_failed`, `permission_denied` or `is_directory` | Check directory traversal, file readability as the service user, and whether the mount points at a regular file. A custom `-config` path is logged as `custom`. |
| `mounts.prepare_failed`, `config_owner_mismatch` | Compare `expected` and `observed` to the YAML creator’s UID and GID. The selected identity must match the non-root owner. |
| `populated_directory_owner_mismatch` | Select the identity that owns the existing store. Verify the volume target before restarting. |
| `read_only`, `symlink`, or `multiple_links` | Use writable, dedicated directories and check the reported mount for symbolic links. Supply a regular singly linked `config.yaml`. The portal saves by creating a new file and renaming it in the directory. |

`mounts.prepared` records an expected and observed mode and ownership per target. Match `operation_id` and `revision` to diagnose the relevant attempt. [Portal key persistence](portal.md#client-keys)
