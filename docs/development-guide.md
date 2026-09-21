# Pi-Wm Development Guide

This document preserves the detailed engineering notes from the original README.
Start with the [project overview](../README.md) for the Chinese introduction and
quick start. Commands and inline repository paths below are relative to the
repository root; feature-specific documents take precedence where behavior has
changed.

Pi-Wm is the desktop product name. Internal `@wuming/*` packages, protocol names,
and existing Wuming data directories remain unchanged for compatibility.

Local-first coding agent built around Pi. The React workbench connects to a
loopback Wuming host on the user's computer; that local host owns the workspace,
Shell, terminal, previews, environment detection, approvals, and durable SQLite
state. A separately deployed server may provide accounts or model access, but it
must not silently substitute its own host Shell for the user's computer.

See:

- `docs/architecture.md` for service boundaries and ownership.
- `docs/task-observability.md` for request diagnostics, chat content search, and desktop notifications.
- `docs/protocol-v1.md` for ordering, replay, and command semantics.
- `docs/artifacts.md` for authenticated attachments and validation limits.
- `docs/media-generation.md` for default image/video models, official/relay compatibility, and inline media.
- `docs/workspace-inspection.md` for file browsing and Git inspection boundaries.
- `docs/terminal.md` for PTY execution modes and terminal protocol security.
- `docs/skill-management.md` for builtin skills, local installation and invocation controls.
- `docs/skill-system-research.md` and `docs/skill-evaluation-status.md` for source research and acceptance evidence.
- `packages/protocol` for the executable TypeBox contract.

## Run locally

For the Windows desktop app and installer, see `docs/desktop.md`.
Developers can run `npm run desktop`; `npm run desktop:dist` creates the
self-contained Windows x64 internal-test installer. Desktop mode does not
require the user to start a server or enter the development password.

Requires Node.js 22.19 or newer.

```sh
npm install --legacy-peer-deps
npm run local
```

This starts the UI and local host on loopback and opens `http://127.0.0.1:5173/`.
The zero-configuration development password is `wuming`; it is only suitable
while the Gateway is bound to loopback. The browser remembers it after the first
successful connection. Use `npm run dev` when automatic browser opening is not
wanted.

`npm run local` explicitly starts `WUMING_DEPLOYMENT_MODE=local_device`: process
tools default to the user's Shell, the terminal defaults to the host PTY, and
previews default to the user's workspace. Every unmarked Gateway is treated as
`server`, even when it binds loopback, because a reverse proxy may expose a
loopback server publicly. Server mode disables host process execution, host
terminal, and host preview by default. Explicit attempts to combine server mode
with `WUMING_PROCESS_MODE=local`, `WUMING_TERMINAL_MODE=host`, or host previews
fail at startup instead of executing on the server by mistake.

The default runtime is Pi. On the first successful connection, configure a real
model service in the setup dialog; its API key is encrypted on the local Gateway
and never returned to the browser. By default Wuming stores durable state in the
current OS user's application-data directory (`%LOCALAPPDATA%\Wuming` on
Windows, `~/Library/Application Support/Wuming` on macOS, and
`~/.local/share/Wuming` on Linux). Set `WUMING_DATA_DIR` only when a deployment
or portable build needs an explicit location.
The composer accepts validated images and UTF-8 text/source attachments; the
same artifact path is used in demo and Pi modes.
The Run rail shows recent durable operations with queue/run status, attempt,
duration, stop requests, failure details, and the bounded context plan used for
each model request. In Pi mode, Wuming assembles `AGENTS.md`,
`.wuming/context.md`, `README.md`, and selected Skills under the configured model
budget; Pi's parallel implicit context-file loading is disabled.
Each new run also records a body-free SHA-256-chained execution trajectory. The
Run rail exposes its integrity and structural score, while an authorized
`session.run.trajectory.get` request returns the bounded replay report. This
score covers execution evidence and policy signals only; semantic correctness
is deliberately reported as unevaluated.
Terminal runs can also be evaluated from the Run rail with an immediate
trajectory check or a reusable workspace-scoped regression dataset. Datasets
combine trajectory thresholds, integrity-checked artifact assertions, and
optional command graders. Command graders use the configured Docker process
sandbox and have no host fallback; they are unavailable for read-only sessions
or deployments without that executor. Results persist only bounded evidence and
content digests, never raw command output. A passing result can be exported with
an Ed25519 attestation over the evaluation and trajectory head. The export is
self-verifying, but deployment identity is established only when a verifier pins
the Gateway's `keyId` or public key out of band.
Pi threshold and overflow compaction is enabled by default. Wuming captures each
successful automatic or manual compaction as a digest-verified, session-scoped
memory with source item citations and accounts for the summarization request's
usage. `session.memory.list` returns at most 20 active authorized memories; the
Pi-only `memory_search` tool performs bounded lexical retrieval inside its
current session and accepts no session ID. The Run rail can pin a memory against
automatic supersession, release it, or forget it. Forgetting physically removes
the summary and leaves only a body-free audit tombstone; Run history still shows
how many memories an operation created. Set
`WUMING_PI_AUTO_COMPACTION=false` only when another layer owns compaction.
Prompt caching uses deterministic context rendering and canonical tool/schema
ordering while retaining live workspace updates and provider-native cache controls.
Leave `WUMING_PI_CACHE_RETENTION` unset to retain Pi/provider defaults, or explicitly
choose `short`, `long`, or `none`. Long retention requires compatible model/provider
settings and can increase cache-write costs; `none` removes SDK cache directives
but cannot guarantee that a provider disables automatic caching. See
[prompt cache optimization](prompt-cache-optimization.md) for scope and verification.
Delegated tasks run in independent durable child sessions that inherit the
parent model, sandbox, and approval policy. Each child has its own transcript,
model context, and the same automatic context compaction as a primary session.
Use the top-right child-conversation switcher to inspect task status and open a
child conversation, switch between siblings, or return to its parent. Subagent
tool rows also open the full conversation, including failed or running tasks;
the separate details button retains access to raw tool output.
The model-facing delegation tool inherits user-configured budgets and cannot
invent a small cumulative token cap. Explicit budgets remain supported by the
delegation protocol; compaction reduces context occupancy, not cumulative billed usage.
New custom model entries default to a 258,000-token context window. Configure
this to match the actual upstream limit; existing saved model limits are retained.
Each child also has its own operation, approvals, and optional cost/token limits; it continues in the
background, can be cancelled, and publishes its terminal result and usage back
to the parent session exactly once. The conversation switcher shows task
summaries and live status, allows stopping active children, and opens each
child's full conversation for inspection or follow-up. Reloading restores the
selected child conversation. Delegation can continue recursively to a hard limit of three agent
levels; cancelling an ancestor first cancels its active descendants.
The Agent Teams tab (or `/teams`) runs persistent collaboration: give the lead
an objective, and it can create retained teammates, assign shared tasks and
exchange durable peer messages. Idle, activated members claim further eligible
tasks in their existing sessions. The workbench shows real members, dependency
lanes, mail delivery, task results and explicit lead acceptance. SQLite-backed
history survives reloads and gateway restarts. The earlier subagent/goal view
remains available under Subtasks. Autonomous planning requires the Pi runtime;
the Demo runtime does not simulate model decisions.
See [Agent Teams](agent-teams.md) for scope, upstream attribution and tests.
Goals can optionally include `successCriteria` and a bounded `maxRounds` value.
The backend then runs independent reviewer sessions, records per-criterion
pass/fail evidence and the reviewer's actual tool trace, and starts a corrected
worker round when required. The Web Goals view configures the loop and exposes
its durable evidence history.
The Automations tab schedules the same durable Goal workflow for one absolute
time or a fixed interval. Plans can be paused, resumed, or triggered immediately;
each trigger snapshots its objective and review policy into an immutable run
record before creating the Goal. Scheduled claims are atomic and idempotent
across restarts. A missed fixed interval creates one catch-up run and advances to
the first future slot instead of replaying an unbounded backlog. Archived parent
sessions retain their plans but do not trigger until restored. Run history links
to the child conversation for approvals and tool-level inspection. Configure the
single-node scan cadence with `WUMING_AUTOMATION_POLL_MS` (default 30000ms).
Provider failures marked retryable use bounded retries (`WUMING_MAX_RETRIES` and
`WUMING_RETRY_BASE_DELAY_MS`). Set `WUMING_COST_BUDGET_USD` for a default
per-session budget, or send `costBudgetUsd` when creating a session; all model
usage, including failed attempts, counts toward that budget.
Sessions can also enforce a token budget and an adjustable warning threshold;
both limits can be changed from the Run rail while the session is idle.
The session sidebar supports server-backed name/ID search, inline rename, and a
recoverable archived-session view. Archived sessions remain readable but cannot
start or queue turns until restored.
The Settings dialog accepts a Base URL and API key, discovers
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

Workspace paths belong to the machine running the connected Gateway. In the
recommended local-device setup that is the user's computer, not a Wuming server.
Workspace and model IDs must be unique. A model with
`authenticated: false` is shown but cannot be selected. Workspace selection
controls the session list, files, changes, uploads, and terminal; model
selection applies when creating the next session and does not mutate existing
sessions.

The **Open project** control can add a file or directory while the gateway runs.
On a loopback deployment, the gateway opens the operating system picker and
stores a reference to the selected local path in
`WUMING_DATA_DIR/projects/projects.json`; project contents are not copied or
uploaded. Selecting a file uses its parent directory as the session workspace.
When the browser connects to a remote Gateway, uploaded projects belong to that
remote workspace and host Shell execution stays disabled. To work on files and
tools already installed on a user's computer, run the local-device host there.

## Skills

Every workspace has bundled workflows including code-change, code-review, debug,
research, run-app, verify-app, skill-authoring and team. Explicitly requesting the
team skill starts persistent Agent Teams in the current project; the Teams view
lists project teams independently of the selected conversation. The model receives bounded
descriptions and can load applicable instructions or references on demand with
skill_load, including after a tool failure. Selection is model-driven, not a
guarantee that every model will choose the expected procedure.

The Skills workbench's management dialog installs packages from a directory
inside the workspace, previews content, toggles enabled state and uninstalls
user packages. User-installed and user-authored skills live on the user's
machine under that workspace; only bundled system skills ship with Wuming. A
package needs SKILL.md with name/description YAML metadata; optional references,
scripts and assets are copied but never executed at install time. Remote
repository and ZIP installers are not implemented. Manual-only invocation policy
from Claude/Codex formats is supported without granting tools or permissions.
See `docs/skill-management.md` for limits and supported fields.

Run history records successful skill loads and observed recovery evidence.
Ordinary skill source inspection is not activation. Disabled/manual-only loads
are rejected, and source-data notices discourage indirect invocation; these
notices are not a general prompt-injection sandbox. Consult the retained
real-model reports before treating a behavior as fully accepted.

## Configure Pi from the environment

Configure a server-side Pi agent directory and an authenticated model. The
browser never receives these credentials.

```powershell
$env:WUMING_AGENT_DIR = "C:\path\to\.pi\agent"
$env:WUMING_MODEL_PROVIDER = "anthropic"
$env:WUMING_MODEL_ID = "your-model-id"
$env:WUMING_WORKSPACE = "D:\path\to\workspace"
$env:WUMING_TOKEN = "wuming"
npm run dev
```

Pi extensions and all Pi built-in host backends are disabled by the Web adapter.
Pi session auto-retry is disabled as well, making the durable Wuming
orchestrator the single authority for retry limits, backoff, history, and
failed-attempt usage.
Wuming exposes `read_file`, `write_file`, and multi-block `edit` while reusing
Pi's corresponding tool definitions and algorithms with workspace-scoped
Wuming file operations, durable approval, and authenticated artifact handling
underneath. Process execution uses the user's local environment by default only
in `local_device` mode. Docker is not required. To explicitly use the optional
Docker backend, build the reference image and configure it by digest:

```powershell
docker build -f docker/wuming-sandbox.Dockerfile -t wuming-runner:local .
$env:WUMING_DOCKER_IMAGE = "your-registry/wuming-runner@sha256:<digest>"
$env:WUMING_PROCESS_MODE = "docker"
```

The default `exec` and `run_python` backend in `local_device` mode uses the
user's existing local environment. Docker is optional and is enabled only with
`WUMING_PROCESS_MODE=docker`.
The Docker backend uses a read-only container root, dropped Linux capabilities, no new privileges,
networking disabled, and bounded CPU, memory, PIDs, output, and wall time. The
workspace bind mount, `/tmp`, and `$HOME` are the only writable paths, so the
toolchain has to be present in the image rather than installed per command.
Docker is required only when `WUMING_PROCESS_MODE=docker`.

The defaults suit a real build (2 CPUs, 2 GiB, a 5-minute default and 30-minute
maximum per command) and every limit is tunable: `WUMING_DOCKER_CPUS`,
`WUMING_DOCKER_MEMORY`, `WUMING_DOCKER_PIDS_LIMIT`,
`WUMING_DOCKER_TMPFS_SIZE`, `WUMING_DOCKER_HOME_SIZE`,
`WUMING_DOCKER_TIMEOUT_MS`, `WUMING_DOCKER_MAX_TIMEOUT_MS`, and
`WUMING_DOCKER_MAX_OUTPUT_BYTES`. `WUMING_DOCKER_CACHE_VOLUME` mounts a Docker
volume at `$HOME` so package caches survive between commands, and
`WUMING_DOCKER_NETWORK=bridge` opts a deployment into dependency installation —
which also lets a command send workspace contents out, so it stays off unless
asked for. See `docs/sandbox-and-approvals.md` for the exact boundary.

`web_fetch` and `web_search` are available in Pi mode without API credentials.
Weather and forecast questions use `web_search` instead of a separate tool. Web fetch accepts only
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
the shared network limits.

### Browser-driven verification

In Pi mode, Wuming registers a persistent Playwright Chromium session for each
agent conversation. The agent can open a public page or a loopback development
server, read an accessibility snapshot with element references, click and type
through a workflow, capture PNG evidence, and inspect console errors, uncaught
exceptions, failed requests, and HTTP 4xx/5xx responses. Frontend work can
therefore run an implementation-to-browser verification loop instead of treating
a successful build as proof that the interface works.

Run `npm run test:e2e:install` once to install bundled Chromium. Browser automation
is enabled and headless by default. Set `WUMING_BROWSER_HEADLESS=false` to show the
controlled browser window, `WUMING_BROWSER_ENABLED=false` to disable the tools, or
configure `WUMING_BROWSER_CHANNEL=chrome` / `WUMING_BROWSER_EXECUTABLE` to use a
system installation. Browser contexts are isolated from personal profiles and from
each other, expire when idle, allow public destinations and `localhost`, and reject
other private-network destinations. Browser sessions track tabs and popups with
stable IDs; the agent can list, switch, create, and close them without losing the
other pages' cookies or diagnostics.

For a complete edit-to-browser loop, preview management is enabled by default;
set `WUMING_PREVIEW_ENABLED=false` to disable it. This adds
`preview_start`, `preview_status`, and `preview_stop`: the agent can launch a
long-lived dev server in a workspace-relative directory, wait for an explicit
`localhost` readiness URL, inspect bounded logs, and clean up the process tree
after verification. Preview commands run in the user's local workspace and use
the same session permission policy as other process operations.

### Configure MCP servers

In local-device mode, open the **MCP** tab and use **+** to add a server.
新增服务默认选择全局，也可选择仅当前工作区。编辑已有服务可切换范围；
切换后需要重新授权，不会自动扩大原授权范围。全局服务在所有项目、每日
工作区和新对话中可用，同名工作区配置优先（包括已停用的配置）。
全局配置和授权分别保存在应用数据目录（`WUMING_DATA_DIR` 或默认数据目录）
下的 `.wuming/mcp.json` 与 `.wuming/mcp-permissions.json`。全局启停、
编辑、撤销授权和删除影响所有工作区；不同范围已有同名服务时拒绝迁移，
不会覆盖目标配置。通过界面保存的全局本地进程保留保存时的工作目录，
跨工作区使用时不会改变相对参数的解析位置。
The dialog accepts manual fields or a JSON configuration; for a multi-server
JSON document, select the server to import. Saving does not grant local trust.
Select the saved server, choose **Authorize and connect**, and confirm before
its process starts or its remote endpoint is contacted. The toolbar also offers
editing, revoking local trust, and deletion with confirmation. Failed services
remain editable. Managed pre-trusted servers are disabled when stopped locally.

An agent can still configure/trust a server through its approval-gated tools.
Configuration or trust changes reload the tool set before the next message in
the same conversation, without requiring a new chat. A running turn retains its
tool set; stale or revoked MCP tools are rejected at execution time.

Environment variables and HTTP header values are password inputs. Reading a
configuration for editing returns null placeholders, never the stored values;
unchanged placeholders preserve credentials, removing a key deletes it, and a
new string replaces it. These values are still stored in the selected scope's JSON
file, not an encrypted credential store. Do not commit that file with secrets
or paste secret values into a conversation. OAuth/keychain integration remains
outside this implementation.

The gateway merges the workspace-local `.wuming/mcp.json` with the application
data directory's global `.wuming/mcp.json`. It accepts the original `servers` array and the
`mcpServers`/`mcp_servers` map used by common MCP clients. `stdio` and modern
`streamable-http` transports are supported. Tools are listed in the Web MCP
tab and exposed to Pi with a stable `mcp__<server>__<tool>` name; names that
need normalization or truncation receive an identity hash so they cannot
silently collide. Legacy `sse` endpoints are accepted for compatibility, while
new deployments should prefer Streamable HTTP. Every call is routed through
the durable approval broker.
Mark a server `readOnly: true` only when its tools are genuinely read-only;
unmarked servers use high-risk approval.

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

The map form can also express lifecycle and exposure policy. The camelCase and
snake_case spellings below are both accepted for compatibility with existing
client configuration:

```json
{
	"mcpServers": {
		"docs": {
			"type": "stdio",
			"command": "node",
			"args": ["./tools/docs-mcp.cjs"],
			"cwd": ".",
			"env": { "DOCS_MODE": "workspace" },
			"enabled_tools": ["search"],
			"disabled_tools": ["delete_index"],
			"request_timeout_ms": 30000,
			"readOnly": true
		},
		"remote": {
			"type": "streamable-http",
			"url": "https://mcp.example.com/mcp",
			"headers": { "X-Workspace": "local-workspace" },
			"enabled": false
		}
	}
}
```

Workspace configuration alone never authorizes a host process. In
`local_device` mode, a user can ask Wuming to configure or trust an MCP server;
after explicit approval (or automatically in a full-access session unless the
policy is always-ask) the Gateway writes `.wuming/mcp.json` and records local
trust in `.wuming/mcp-permissions.json`. Trust is bound to the normalized server
configuration digest, so editing the command, args, URL, env, headers, or tool
filters makes the server untrusted again until the user re-approves it. Server
mode does not expose user MCP configuration or management tools.

Untrusted entries remain visible in the MCP tab with zero tools, but discovery
does not execute their command or connect to their URL. Entries with
`enabled: false` are also visible but never start or connect. The deployment
variable `WUMING_MCP_TRUSTED_SERVERS_JSON` remains available only for managed
single-tenant deployments that intentionally pre-trust a workspace/server pair;
it is not needed for normal local-device use.

The adapter keeps one initialized connection per workspace/server and reuses it
across `tools/list` and `tools/call`. Tool-list notifications invalidate the
cache, configuration changes close old connections, and failed calls reconnect
on the next request. Requests have bounded output and per-server
startup/request deadlines; cancelling a stdio tool call terminates the server
process. For local safety, `.wuming`, `.wuming/mcp.json`, and
`.wuming/mcp-permissions.json` must not be symbolic links, commands/arguments
are strictly validated, remote URLs must use HTTPS or loopback HTTP, and URL
credentials are rejected. Rich MCP results are converted to bounded text with
structured-content diagnostics; raw binary media is not copied into the
transcript.

MCP child processes inherit only basic OS path, locale, home, and temporary
directory variables. Gateway/provider credentials are not inherited. Explicit
MCP `env` and HTTP `headers` are workspace configuration and must be treated as
secrets by operators; OAuth and automatic secret-store lookup are not part of
this increment.

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
web search, and web fetch by default. When `WUMING_DOCKER_IMAGE` is set,
it also covers `exec` and `run_python` inside the configured container. This gate
can make multiple billable provider requests and is deliberately excluded from
`npm test`:

```powershell
$env:WUMING_AGENT_DIR = "C:\path\to\.pi\agent"
$env:WUMING_MODEL_PROVIDER = "anthropic"
$env:WUMING_MODEL_ID = "your-model-id"
npm run verify:pi-tools
```

Use `WUMING_PI_TOOL_CASES=web_search,web_fetch` to rerun a comma-separated subset.
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

Desktop update behavior, GitHub release configuration and the publishing checklist
are documented in [Desktop Updates](desktop-updates.md). Run
`npm run verify:desktop:updates` for the native desktop update checks.

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
subagents, and the desktop/mobile child-conversation switcher. It never calls a paid provider and
does not reuse local development data.

Current implementation status is tracked in `docs/implementation-status.md`.
Structured JSONL operational logging and correlation fields are described in
`docs/observability.md`; set `WUMING_LOG_LEVEL=debug` when investigating a
specific turn or restart.
