# Local Device Execution

Status: adopted on September 7, 2026

## Product decision

Wuming is a local-first coding tool. When a user opens a project from their
computer, every filesystem operation, command, terminal session, environment
check, and preview process must run through a Wuming local device host on that
same computer. A Wuming cloud service may provide identity, model routing,
billing, synchronization, or policy, but it must never silently run the command
on the cloud server instead.

Docker is optional. It is an explicit isolation backend for users or operators
who want it, not a prerequisite for `exec`, `run_python`, terminal, or preview.

## Patterns adopted from Codex and Claude Code

Codex separates the client UI from a local app-server execution process. The
client sends requests and approval decisions while the app-server streams
events. Sandbox policy limits what can happen; approval policy decides when a
human must confirm it. Local environments use the tools and environment on the
machine where the app-server runs.

Claude Code follows the same important boundary: the coding process runs on the
developer machine, starts with bounded permissions, and asks before sensitive
edits or commands unless an allow rule or broader mode applies. Its remote
control UI still connects to a Claude Code process running locally; cloud
execution is a separate, explicitly isolated product mode.

Primary references:

- https://learn.chatgpt.com/codex/app-server
- https://learn.chatgpt.com/codex/environments/local-environment
- https://learn.chatgpt.com/codex/agent-approvals-security
- https://code.claude.com/docs/en/security
- https://code.claude.com/docs/en/cli-usage

## Wuming runtime boundary

```text
Web/Desktop UI
  -> loopback authenticated WebSocket
Wuming local device host
  -> workspace filesystem
  -> workspace-owned user skills and MCP configuration
  -> user Shell and PATH
  -> terminal PTY
  -> preview processes and browser verification
  -> environment diagnostics
  -> model provider or optional cloud model gateway
```

The local device host must be visible in the handshake. The UI must show the
actual placement and backend instead of inferring it from the page URL.

`local_device` is explicit and may bind only to loopback. An unmarked Gateway is
always treated as `server`, including a loopback-bound Gateway behind a reverse
proxy. Server mode disables host process execution, host terminal, and host
preview by default and rejects configurations that would expose them.

User-authored skills and user MCP servers follow the same boundary. Builtin
skills may ship with Wuming, but extra skills live under the user's workspace
`.wuming/skills` directory. MCP declarations live in `.wuming/mcp.json`, and
local trust lives in `.wuming/mcp-permissions.json`. Global MCP entries use the
same filenames under the local application data directory and are merged into
every workspace, with workspace entries taking precedence. In server mode these
user-owned capability stores are not discovered or mutated, and model-facing
management tools are not exposed. A cloud service may synchronize policy or
model access, but it should not become the place where each user's tool servers,
skill packages, workspace secrets, or local approval records are maintained.

## Permission behavior

Permission and execution placement are independent:

- Read-only: inspect the workspace; do not edit files or execute processes.
- Agent: write inside the workspace and ask for risky operations according to
  policy.
- Full access: use the user device environment directly without repeatedly
  asking for ordinary tool calls; explicitly sensitive inspections may still
  require confirmation.

Approval never changes a server into a user device and never expands a sandbox
boundary. A prompt cannot authorize use of the Wuming server's host Shell.

## Missing tools and environment setup

Before repeating a failed command, Wuming should detect the current project
type and local executables. When a required tool is missing it should report:

- the missing executable;
- which requested action needs it;
- an operating-system-appropriate installation suggestion;
- PATH or restart guidance;
- project setup markers such as package manager, `node_modules`, virtual
  environment, `.env.example`, and `.env` presence without reading secrets.

Installing system software is a separate side effect. Wuming may explain or,
with sufficient permission and approval, execute the installation command, but
must not silently install tools or switch to the server's environment.

## Delivery path

The source-tree command `npm run local` is the current one-step launcher. It
starts the local device host and Web UI on loopback, enables the user Shell,
terminal, and preview defaults, and opens the browser.

The production packaging target is a signed desktop/native host with automatic
updates and a loopback app-server. The Web UI can be embedded or served locally.
Cloud accounts and model gateways remain optional services behind that local
execution boundary.
