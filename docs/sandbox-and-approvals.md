# Sandbox and Approval Boundary

## Security model

Approval and sandbox policy are separate checks. Approval can consent to an
operation that is already inside policy; it cannot expand the sandbox. A
`read_only` session therefore rejects writes and processes even if a user would
approve them.

Pi extensions and the default host I/O backends are disabled. Wuming reuses Pi's
file tool definitions and read/write/edit behavior, while `@wuming/sandbox`
injects workspace-scoped file operations and the approval wrapper:

| Tool | Capability | Availability | Default risk |
| --- | --- | --- | --- |
| `read_file` | `filesystem.read` | every sandbox mode | low |
| `write_file` | `filesystem.write` | workspace-write and unrestricted | medium |
| `edit` | `filesystem.write` | workspace-write and unrestricted | medium |
| `exec` | `process.exec` | write-capable mode and configured Docker image | high |
| `run_python` | `process.exec` | write-capable mode and configured Docker image | high |
| `web_fetch` | `network.connect` | every sandbox mode | low |
| `web_search` | `network.connect`, optional `secret.use` | every sandbox mode; Bing default | low |

## Filesystem enforcement

The browser and model supply only workspace-relative paths. The path policy
rejects absolute paths, drive-qualified paths, UNC paths, NUL bytes, and parent
traversal. Existing targets and the nearest existing parent of new targets are
resolved with `realpath`; symlinks and Windows junctions cannot redirect access
outside the configured workspace. Reads and writes have independent byte limits.
Writes use a same-directory temporary file and atomic rename; edit uses Pi's
unique, non-overlapping multi-block contract, preserves BOM and line endings,
and rejects a write when the source hash changed while the edit was prepared.

These file operations execute in the gateway process, but their reachable path
surface is restricted to the configured workspace. They are not a substitute
for an OS account, container, or microVM boundary in a hostile multi-tenant
deployment.

## Process enforcement

There is deliberately no host-shell implementation. `exec` and `run_python` are absent unless
`WUMING_DOCKER_IMAGE` is set. By default the image reference must contain an
`@sha256:` digest. `docker/wuming-sandbox.Dockerfile` is the reference recipe;
because the container root is read-only, the toolchain has to be baked into the
image rather than installed per command. Each call starts a new Docker container
with:

- no network (`--network none`) unless the deployment sets
  `WUMING_DOCKER_NETWORK=bridge`; `host` requires the additional
  `WUMING_DOCKER_ALLOW_HOST_NETWORK=true`
- dropped Linux capabilities and `no-new-privileges`
- a read-only container root whose only writable paths are the workspace mount,
  a bounded `/tmp`, and a bounded `$HOME` (`--tmpfs`, `noexec,nosuid`), or a
  Docker volume at `$HOME` when `WUMING_DOCKER_CACHE_VOLUME` is set so package
  caches survive between commands
- CPU, memory, and PID limits, and `--init` so PID 1 reaps the command's children
  and forwards the kill signal
- a single workspace bind mount at `/workspace`
- bounded output and wall time
- forced container removal after timeout or abort
- `--label wuming.sandbox=1`, so an operator can find and remove strays

Every size and path option is shape-validated before it reaches the Docker
command line: these values interpolate into comma-separated mount-option strings,
where a size like `64m,exec` would otherwise silently undo `noexec`.

Opening the network is a real reduction in the boundary, not a convenience
setting: a command that can reach the network can send workspace contents out of
the host. It stays off unless a deployment asks for it.

The workspace mount is writable because write-capable sessions need to modify
the repository. On POSIX hosts the container runs as the gateway's own `uid:gid`
by default (override with `WUMING_DOCKER_USER`) so files the model creates stay
editable outside the container instead of landing root-owned. Production images
should contain only the required toolchain. `run_python` requires `python3` in
that pinned image.

## Web enforcement

Web access runs in a gateway-side HTTP client, not in the process container.
Only GET requests to HTTP(S) standard ports are supported. URL credentials,
localhost names, private/reserved IP ranges, nonstandard ports, excessive
redirects, compressed or binary responses, oversized bodies, and expired
deadlines are rejected. Every DNS answer must be public, except that HTTPS
hostnames may resolve to the `198.18.0.0/15` synthetic range used by transparent
proxies because TLS still authenticates the original public hostname. Plain HTTP
requires explicit deployment opt-in for that range. The connection uses the
exact validated address so a later DNS rebind cannot redirect the request.
Redirect destinations repeat the complete validation.

`web_fetch` converts HTML to readable text before returning it. `web_search`
uses structured Bing HTML results by default; DuckDuckGo HTML, Brave Search, and
a deployment-controlled SearXNG endpoint are selectable providers. Current
weather and forecast questions use the same search path. Provider keys stay in
the Gateway environment. Network and secret
capabilities remain subject to the durable approval policy, including in a
`read_only` session; that mode still forbids files writes and processes.

## MCP process trust

`.wuming/mcp.json` is repository-controlled input, not an authorization source.
The Gateway parses and displays every valid entry, but starts a stdio server only
when its `workspaceId` and `serverId` pair appears in
`WUMING_MCP_TRUSTED_SERVERS_JSON`. This deployment-controlled allowlist is
checked before `initialize`, `tools/list`, and Pi tool creation. Each later MCP
tool call still passes through durable approval using an `mcp.call` capability;
a `read_only` session permits only calls from servers declared `readOnly`.

## Approval lifecycle

Risky tool preflight persists `approval.requested` before waiting. The browser
receives the durable event and sends `approval.respond` with the session ID,
approval ID, decision, request ID, and idempotency key. The Gateway verifies the
principal owns the session workspace. Settlement is serialized per session and
atomically persists `approval.settled` with `decidedBy` and `decidedAt`.

Terminal statuses are `approved`, `denied`, `expired`, and `cancelled`. Timeout
and turn abort are system decisions. Reusing the same idempotency key and command
returns the original result; changing the decision under that key is rejected.

Approval execution has a separate durable state machine: `waiting`, `approved`,
`executing`, and `completed`, with `interrupted` and `cancelled` terminal states.
The transition to `executing` is the conservative side-effect boundary and is
claimed before the tool implementation starts.

After a Gateway restart, one pending preflight approval can remain waiting when
no tool execution has started. Approval resumes the original Pi tool call from
the persisted assistant message, revalidates its tool name and arguments, claims
the one-shot grant, appends the tool result, and continues the agent. It does not
send the original user prompt again. A turn is interrupted instead of replayed
when execution was already claimed or completed, the approval followed a failed
tool attempt, or multiple approval continuations were active. This intentionally
prefers an explicit user retry over duplicate filesystem or process side effects.

`always`, `on_risk`, and `never` have preflight behavior. `on_failure` runs
without preflight. Tool wrappers can request approval after an executor or
network failure when they can safely replay the exact request. A successfully
started command returning a nonzero exit code is returned with its output and
is not automatically replayed. Model turns are retried only for
provider failures classified as retryable, never for budget exhaustion or aborts.
