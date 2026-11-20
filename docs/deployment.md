# Deploy AaA-muse-ai

## Fresh install

Use standard Linux Docker and Docker Compose on a single host. Select a verified paired release whose broker image includes `prepare-mounts`. Use dedicated local directories for the three bind mounts. Numeric IDs in this guide assume Docker uses the host’s user namespace. On remapped or rootless engines, identify the corresponding IDs inside the container first. [Paired releases](releases.md)

From your Compose directory, create the host directories and supply `config/config.yaml`.

```sh
umask 077
mkdir -p config sqlite media
cp -n config.example.yaml config/config.yaml
stat -c '%u:%g' config/config.yaml
```

For an existing single-file `./config.yml`, use it as the source of `cp -n` in place of the example. Keep the canonical name `config/config.yaml` in the directory mount. `cp -n` leaves an existing destination in place. Keep any environment variables the YAML references.

Create a private `.env` with your image and credentials. Use the YAML creator’s positive numeric UID and GID so that account can still edit the file after a portal save. For root-owned YAML or an existing Compose deployment using the stock image identity, use `10001:10001`.

```dotenv
MUSE_SERVICE_IMAGE=ghcr.io/markhuangai/aaa-muse-ai@sha256:<verified-paired-release-digest>
MUSE_SERVICE_USER=1000:1000
MUSE_MANAGEMENT_KEY=<management-key>
MUSE_PORTAL_PASSWORD=<distinct-portal-password>
```

```sh
docker compose config --quiet
docker compose up -d service
curl -fsS http://127.0.0.1:8081/readyz
```

The setup service prepares the directory modes (`0700`) and the regular YAML (`0600`) before the broker starts as the selected non-root user. The default HTTP binding is `127.0.0.1:8081`. Route the portal and API through the same HTTPS origin and allow at least 330 seconds for inference responses. A ready broker returns HTTP 200 with `"ready":true`. `GET /healthz` checks the HTTP process. Keep the management key in a protected header file if you use the management API. When YAML leaves it empty, startup prints a generated management key once.

## Upgrade existing storage

Before replacing an existing Compose file, inspect the old service container even if it is stopped. Match the actual mounts to their container targets and record the original project name. The following command prints mount metadata.

```sh
docker inspect OLD_SERVICE_CONTAINER --format '{{index .Config.Labels "com.docker.compose.project"}}{{range .Mounts}}{{println}}{{println .Destination .Type .Name .Source}}{{end}}'
```

- `/etc/aaa-muse-ai` holds the private configuration directory. Keep the existing `config.yaml`, including the client-key entries. For a single-file bind, copy the real YAML into the dedicated directory as described above. Use the original service UID and GID for populated stores and every broker sharing them.
- `/var/lib/aaa-muse-ai/state` and `/var/lib/aaa-muse-ai/media` hold SQLite and media. If they already use the default host directories, verify the paths resolve to the original directories. For the old named layout, set `MUSE_SQLITE_VOLUME` and `MUSE_MEDIA_VOLUME` in `.env` to the exact inspected **Name** values for these two targets. Docker requires both external volumes to exist. Compare them to the old container's mounts even when `./sqlite` and `./media` already exist.
- `/var/lib/aaa-muse-ai/diagnostics` keeps the original named volume under the same Compose project. Verify the project name and diagnostics mount before starting the replacement.

For the named storage upgrade, retain both Compose files in every command and pass the actual old project name.

```sh
docker compose -p OLD_PROJECT -f compose.yaml -f compose.named-volumes.yaml config --quiet
docker compose -p OLD_PROJECT -f compose.yaml -f compose.named-volumes.yaml up -d service
```

Check readiness and confirm the new container mounts the same state, media and diagnostics. Check that prior registrations are present before resuming submissions. A mount with populated storage owned by another ID requires using the existing service identity or arranging an offline ownership migration. The setup service changes ownership only on empty data directories.

## SQLite state and cutover

Keep `broker.sqlite3`, its WAL and its shared-memory sidecar together on a local filesystem. SQLite requires the directory to be `0700` and the database and sidecars to be regular files with mode `0600`. Same-host sibling brokers use the same SQLite version and storage. For a backup, stop all brokers writing to the database and copy the complete private state directory. Back up configuration and protected diagnostics separately. Media has its own expiry lifecycle.

For the one-time fresh start from a PostgreSQL deployment, stop submissions, let media drain and keep the old worker journal. Confirm the legacy project and the mount at `/var/lib/postgresql` before decommissioning PostgreSQL. Remove the `database` block from the protected YAML and remove `POSTGRES_PASSWORD` from the Compose environment. Start with new SQLite state and retain diagnostics. Old worker registrations, approvals, history and pending jobs belonged to PostgreSQL. For each returning worker, stop the old subscriber, retire its old hook, keep its journal and enroll using a fresh private absolute `XDG_STATE_HOME`. [Worker state and recovery](../worker/README.md#registration-reconnect-and-removal)

## Startup troubleshooting

On standard Linux Docker, Compose reports missing host directories, external volumes or required settings before the broker can start. Docker Desktop file sharing can create empty bind-source directories. Compare resolved mount sources to the previous container before upgrading. Once the containers exist, filter their logs to configuration and mount events.

```sh
docker compose logs --no-log-prefix prepare-mounts service |
  jq -R 'fromjson? | select(.msg=="config.rejected" or (.msg|startswith("mounts.")))'
```

| Event or reason | Check |
| --- | --- |
| `config.rejected`, `read_failed`, `not_found` | Verify the directory mount exposes `/etc/aaa-muse-ai/config.yaml`. The `.yml` spelling is common in host files. Verify the target spelling and the actual source. |
| `read_failed`, `permission_denied` or `is_directory` | Check directory traversal, file readability as the service user, and whether the mount points at a regular file. A custom `-config` path is logged as `custom`. |
| `mounts.prepare_failed`, `config_owner_mismatch` | Compare `expected` and `observed` to the YAML creator’s UID and GID. The selected identity must match the non-root owner. |
| `populated_directory_owner_mismatch` | Select the identity that owns the existing store. Verify the volume target before restarting. |
| `read_only`, `symlink`, or `multiple_links` | Use writable, dedicated directories and check the reported mount for symbolic links. Supply a regular singly linked `config.yaml`. The portal saves by creating a new file and renaming it in the directory. |

`mounts.prepared` records an expected and observed mode and ownership per target. Match `operation_id` and `revision` to diagnose the relevant attempt. [Portal key persistence](portal.md#client-keys)
