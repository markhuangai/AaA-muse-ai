# AaA-muse-ai

AaA-muse-ai is a self-hosted broker for using Muse from model clients. Workers connect to the broker over outbound HTTPS. Muse proposes answers and tool calls. The calling client runs its tools under its own permissions and returns the results.

- Use the OpenAI Chat Completions and Responses subsets for text and function tools, with JSON or buffered SSE. The model alias is `muse-ai`. [API and client setup](docs/history-api.md#openai-chat-completions)
- Create client keys, enroll workers, and inspect requests in the control portal. [Portal guide](docs/portal.md)
- Ask Muse a question or generate WAV and MP4 files from an MCP client. [MCP tools and media API](docs/media-api.md#mcp-tools)

## Quick start

Use Docker Compose on Linux and a verified paired-release image that supports `prepare-mounts`. The broker keeps SQLite state on one host. If you already run the service, match its existing volume names and identity before changing Compose files. [Deployment and upgrades](docs/deployment.md) · [Paired releases](docs/releases.md)

From the directory containing `compose.yaml` and `config.example.yaml`, create the host directories and supply your configuration.

```sh
umask 077
mkdir -p config sqlite media
cp -n config.example.yaml config/config.yaml
stat -c '%u:%g' config/config.yaml
```

In a private `.env`, set `MUSE_SERVICE_IMAGE` to the verified image digest, `MUSE_SERVICE_USER` to the YAML creator’s numeric `UID:GID`, and distinct `MUSE_MANAGEMENT_KEY` and `MUSE_PORTAL_PASSWORD` values. Compose prepares the directory permissions before starting the broker. [Configuration and readiness](docs/deployment.md#fresh-install)

```sh
docker compose up -d service
```

Serve the portal and API through your HTTPS reverse proxy. Sign in to the portal, open **Workers**, and paste the generated enrollment prompt into Muse as one message. Create a model-client key under **Settings → Client keys**. Point your client at the broker’s HTTPS `/v1` base URL. [Worker setup](worker/README.md) · [Portal enrollment](docs/portal.md#worker-management)

## Qualification

The formal live qualification verdict remains inconclusive. The qualification record binds observations to the tested artifacts and distinguishes live trials from controlled software validation. [Qualification record](docs/releases.md#live-qualification-evidence) · [Project history](docs/project-history.md)

## Remote development

In **Actions → Remote development**, `Z-M-Huang` can dispatch a run from `main`. Select `codex` (the default) or `claude` in **runner**. The workflow passes the selected provider's credentials, `REMOTE_DEV_PAT`, and the optional `MCP_CONFIG_JSON` Actions secret to the runner. Use raw JSON with an `mcpServers` object for the shared MCP configuration. [Workflow](.github/workflows/remote-dev.yml) · [Upstream setup](https://github.com/markhuangai/agent-remote-dev/blob/4834e85a8b4416500fdde73bf09306c70942d4fd/docs/setup.md)

```sh
gh workflow run remote-dev.yml --repo markhuangai/AaA-muse-ai --ref main -f runner=claude -F plan=@plan.md
gh run download RUN_ID --repo markhuangai/AaA-muse-ai --pattern 'remote-dev-result-*'
gh workflow run remote-dev.yml --repo markhuangai/AaA-muse-ai --ref main -f runner=claude -f resume-run-id=RUN_ID -F plan=@context.md
```

Use public-safe prompts and fixtures because this repository stores conversation and result artifacts. Inspect the result artifact for the task outcome. Resume with the original runner and compatible version to restore the recorded published source revision. Include `$sdlc-plan-implementation` in the prompt when the task calls for an audited PR. Each execution can run for five hours, with up to three automatic continuations after timeouts. Cancel a run with `gh run cancel RUN_ID --repo markhuangai/AaA-muse-ai`. Check `gh run list --repo markhuangai/AaA-muse-ai --workflow remote-dev.yml` and cancel any already-queued continuation by its own run ID. [Project settings](.remote-dev.yml) · [Timeout decision](docs/project-history.md#remote-development)

[Contributor instructions](AGENTS.md) · [Apache-2.0 license](LICENSE)
