# Wuming Web

Web control plane for a Pi-based coding agent. The current vertical slice has a
React workbench, authenticated WebSocket gateway, durable SQLite orchestration,
and a pinned Pi `AgentSession` adapter. This directory is deliberately separate
from the upstream research clones in the workspace.

See:

- `docs/architecture.md` for service boundaries and ownership.
- `docs/protocol-v1.md` for ordering, replay, and command semantics.
- `docs/artifacts.md` for authenticated attachments and validation limits.
- `docs/workspace-inspection.md` for file browsing and Git inspection boundaries.
- `docs/terminal.md` for PTY execution modes and terminal protocol security.
- `packages/protocol` for the executable TypeBox contract.

## Run locally

Requires Node.js 22.19 or newer.

```sh
npm install --legacy-peer-deps
npm run dev
```

Open `http://127.0.0.1:5173/`. The zero-configuration development token is
`dev-token`; it is only suitable while the gateway is bound to loopback.

The default runtime is deterministic demo mode. It exercises the real browser,
WebSocket, event store, session worker, streaming, reconnect, and persistence
path without calling a paid model.
Send `/approval` in demo mode to exercise the real durable approval round trip;
the demo request performs no filesystem or process action. A pending preflight
approval survives a Gateway restart and resumes the exact approved tool-call
boundary after the user responds. Send `/long` to run
a long streaming response and exercise the Stop control. Send `/inject`, then
submit a steer or follow-up message to verify active-turn injection.
Send `/retry-once` to simulate one transient provider failure and exercise the
durable retry/backoff path without calling a paid model.
The composer accepts validated images and UTF-8 text/source attachments; the
same artifact path is used in demo and Pi modes.
The Run rail shows recent durable operations with queue/run status, attempt,
duration, stop requests, and failure details.
The Agents tab creates independent durable child sessions that inherit the
parent model, sandbox, and approval policy. Each child has its own transcript,
operation, approvals, and optional cost/token limits; it continues in the
background, can be cancelled, and publishes its terminal result and usage back
to the parent session exactly once. Nested subagents are not enabled in this
increment.
The Goals tab creates durable objectives without starting model work
immediately. Starting a goal runs one independent child session in the
background; its status, approvals, usage, result, and cancellation state remain
available after navigation or restart. Multi-step plans and scheduled triggers
are deferred beyond this increment.
Protocol clients can optionally provide `successCriteria` and a bounded
`maxRounds` value when creating a Goal. The backend then runs independent
reviewer sessions, records pass/fail feedback, and starts a corrected worker
round when required. Web controls for configuring and inspecting this review
loop are tracked as the next frontend increment.
Provider failures marked retryable use bounded retries (`WUMING_MAX_RETRIES` and
`WUMING_RETRY_BASE_DELAY_MS`). Set `WUMING_COST_BUDGET_USD` for a default
per-session budget, or send `costBudgetUsd` when creating a session; all model
usage, including failed attempts, counts toward that budget.
Sessions can also enforce a token budget and an adjustable warning threshold;
both limits can be changed from the Run rail while the session is idle.
The session sidebar supports server-backed name/ID search, inline rename, and a
recoverable archived-session view. Archived sessions remain readable but cannot
start or queue turns until restored.
When running Pi, the Settings dialog accepts a Base URL and API key, discovers
the endpoint's model catalog, and lets the user search, multi-select, and add
models. A model name is optional; protocol and model limits remain available in
the collapsed advanced section. Saved models have a separate one-token test
action, which may incur provider charges.
Official OpenAI endpoints default to Pi's Responses adapter, OpenAI-compatible
gateways default to Chat Completions, and Anthropic endpoints use Messages. A
gateway with unusual routing can override the detected protocol in Advanced.
Custom model credentials are encrypted and restored after gateway restarts. By
default, the gateway creates a local `custom-models.key` beside the encrypted
configuration in `WUMING_DATA_DIR`. Set `WUMING_MODEL_CONFIG_KEY` to a long
random value when the key should come from deployment secrets instead. Back up
that key with the encrypted configuration: losing it makes the saved API keys
unrecoverable. Use the API root as Base URL (`https://host/v1` for most
OpenAI-compatible services; `https://api.anthropic.com` for Anthropic).
The Files and Changes tabs provide authenticated workspace browsing, bounded
source previews, structured Git status, and working/staged unified diffs.
The Terminal tab uses a real PTY; set `WUMING_TERMINAL_MODE=host` for trusted
loopback development or `docker` with a digest-pinned image for isolated use.

### Multiple workspaces and models

`WUMING_WORKSPACE` and the `WUMING_MODEL_*` variables configure the default
single-workspace, single-model setup. To expose explicit catalogs in the
browser, provide non-empty JSON arrays instead:

```powershell
$env:WUMING_WORKSPACES_JSON = '[{"id":"app","name":"Application","path":"D:/code/app"},{"id":"docs","name":"Documentation","path":"D:/code/docs"}]'
$env:WUMING_MODELS_JSON = '[{"provider":"anthropic","id":"model-a","name":"Model A","reasoning":true,"input":["text","image"],"contextWindow":200000,"maxOutputTokens":32000,"authenticated":true}]'
npm run dev
```

Workspace paths remain server-side and may be absolute or relative to the
gateway working directory. Workspace and model IDs must be unique. A model with
`authenticated: false` is shown but cannot be selected. Workspace selection
controls the session list, files, changes, uploads, and terminal; model
selection applies when creating the next session and does not mutate existing
sessions.

## Run with Pi

Configure a server-side Pi agent directory and an authenticated model. The
browser never receives these credentials.

```powershell
$env:WUMING_RUNTIME = "pi"
$env:WUMING_AGENT_DIR = "C:\path\to\.pi\agent"
$env:WUMING_MODEL_PROVIDER = "anthropic"
$env:WUMING_MODEL_ID = "your-model-id"
$env:WUMING_WORKSPACE = "D:\path\to\workspace"
$env:WUMING_TOKEN = "replace-with-a-long-random-token"
npm run dev
```

Pi extensions and all Pi built-in host backends are disabled by the Web adapter.
Pi session auto-retry is disabled as well, making the durable Wuming
orchestrator the single authority for retry limits, backoff, history, and
failed-attempt usage.
Wuming exposes `read_file`, `write_file`, and multi-block `edit` while reusing
Pi's corresponding tool definitions and algorithms with workspace-scoped
Wuming file operations, durable approval, and authenticated artifact handling
underneath. To
enable process execution, configure a digest-pinned container image:

```powershell
$env:WUMING_DOCKER_IMAGE = "your-registry/wuming-runner@sha256:<digest>"
```

The `exec` and `run_python` tools have no host-process fallback. They use Docker with networking
disabled, a read-only container root, dropped Linux capabilities, bounded CPU,
memory, PIDs, output, and wall time. Docker must be installed on the gateway
host. See `docs/sandbox-and-approvals.md` for the exact boundary.

`web_fetch`, `web_search`, and `weather` are available in Pi mode without API
credentials. Web fetch accepts only
public HTTP(S) destinations on standard ports, validates every redirect and DNS
answer, pins the validated address for the connection, rejects binary content,
and bounds time and response size. HTTPS remains usable with transparent proxies
that synthesize addresses in `198.18.0.0/15` because TLS still authenticates the
original hostname; direct reserved-address URLs remain blocked. Search uses Bing
HTML by default. Configure Brave Search or a deployment-controlled SearXNG
instance when a contracted, higher-stability search backend is required:

```powershell
# Brave Search
$env:WUMING_WEB_SEARCH_PROVIDER = "brave"
$env:WUMING_WEB_SEARCH_API_KEY = "replace-with-a-server-side-key"

# Or a deployment-controlled SearXNG endpoint
$env:WUMING_WEB_SEARCH_PROVIDER = "searxng"
$env:WUMING_WEB_SEARCH_ENDPOINT = "https://search.example.com/search"
```

Search credentials remain server-side and are never exposed in tool arguments
or results. `WUMING_WEB_TIMEOUT_MS` and `WUMING_WEB_MAX_RESPONSE_BYTES` control
the shared network limits. `weather` resolves place names and retrieves current
conditions plus a 1-7 day forecast from the no-key Open-Meteo APIs.

### Configure MCP servers

The gateway discovers workspace-local stdio MCP servers from
`.wuming/mcp.json`. Each server must have a safe ID and command; tools are
listed in the Web MCP tab and exposed to Pi with the `mcp__<server>__<tool>`
name. Every call is routed through the durable approval broker. Mark a server
`readOnly: true` only when its tools are genuinely read-only; unmarked servers
use high-risk approval.

```json
{
  "servers": [
    {
      "id": "docs",
      "name": "Documentation MCP",
      "command": "node",
      "args": ["./tools/docs-mcp.cjs"],
      "readOnly": true
    }
  ]
}
```

Workspace configuration alone never authorizes a host process. The deployment
must separately trust each workspace/server pair before the Gateway will start
it. For the default workspace above:

```powershell
$env:WUMING_MCP_TRUSTED_SERVERS_JSON = '[{"workspaceId":"local-workspace","serverId":"docs"}]'
```

Untrusted entries remain visible in the MCP tab with zero tools, but discovery
does not execute their command. When `WUMING_WORKSPACES_JSON` is configured, use
the corresponding workspace ID in the trust entry.

The adapter keeps one initialized stdio connection per workspace/server and
reuses it across `tools/list` and `tools/call`. Requests have bounded output and
startup/request deadlines; cancelling a tool call terminates the server process
and the next request reconnects cleanly. For local safety, `.wuming` and
`.wuming/mcp.json` must not be symbolic links, and commands/arguments are
strictly validated. HTTP transport, OAuth, and remote server management are
deferred to a later production increment.

MCP child processes inherit only basic OS path, locale, home, and temporary
directory variables. Gateway/provider credentials are not inherited; explicit
MCP credential configuration is deferred until a dedicated secret store exists.

### Verify a real Pi provider

The provider smoke command performs one real, potentially billable model call.
It is deliberately excluded from `npm test` and never prints credentials:

```powershell
$env:WUMING_AGENT_DIR = "C:\path\to\.pi\agent"
$env:WUMING_MODEL_PROVIDER = "anthropic"
$env:WUMING_MODEL_ID = "your-model-id"
$env:WUMING_WORKSPACE = "D:\path\to\workspace"
npm run verify:pi-provider
```

Set `WUMING_PI_SMOKE_PROMPT` to replace the minimal default prompt. A successful
run prints the provider response and aggregate usage as JSON.

The tool acceptance gate runs real Pi sessions through the Gateway and verifies
each registered tool by name and observable output. It covers file read/write/edit,
web search, web fetch, and weather by default. When `WUMING_DOCKER_IMAGE` is set,
it also covers `exec` and `run_python` inside the configured container. This gate
can make multiple billable provider requests and is deliberately excluded from
`npm test`:

```powershell
$env:WUMING_AGENT_DIR = "C:\path\to\.pi\agent"
$env:WUMING_MODEL_PROVIDER = "anthropic"
$env:WUMING_MODEL_ID = "your-model-id"
npm run verify:pi-tools
```

Use `WUMING_PI_TOOL_CASES=weather,web_search` to rerun a comma-separated subset.
The gate uses disposable workspace and data directories and removes them after
the run. It never prints provider credentials.

The approval restart gate makes two real provider calls and exercises the full
gateway recovery path. It creates disposable data and workspace directories,
waits for a real `write_file` approval, restarts the gateway before approval, approves
after reconnecting, verifies the tool ran exactly once, and deletes the temporary
directories. To keep the gate deterministic across providers, it forces tool
selection only for the first provider request and restores automatic selection
for the post-approval continuation:

```powershell
$env:WUMING_AGENT_DIR = "C:\path\to\.pi\agent"
$env:WUMING_MODEL_PROVIDER = "anthropic"
$env:WUMING_MODEL_ID = "your-model-id"
npm run verify:pi-approval-restart
```

Both verification commands resolve credentials through the Pi agent directory;
credentials remain server-side and are never included in their JSON output.

## Verification

```sh
npm install
npm run check
npm test
npm run test:e2e:install
npm run test:e2e
npm run build
```

The Playwright suite launches isolated demo Gateway and Vite processes on
dynamic ports with a temporary workspace and SQLite directory. It covers turn
persistence across reload, approval, cancellation, completed/cancelled
subagents, and the mobile Agents layout. It never calls a paid provider and
does not reuse local development data.

Current implementation status is tracked in `docs/implementation-status.md`.
Structured JSONL operational logging and correlation fields are described in
`docs/observability.md`; set `WUMING_LOG_LEVEL=debug` when investigating a
specific turn or restart.
