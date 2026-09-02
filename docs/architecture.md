# Architecture Decision: Pi-Based Web Agent

Status: accepted for MVP foundation

## Product boundary

Wuming Web is a Web control plane around Pi, not a browser wrapper around the
Pi CLI. Pi owns model and agent execution. Wuming owns identity, tenancy,
workspace lifecycle, durable orchestration, approval, sandboxing, artifacts,
and the browser protocol.

```text
Browser
  | HTTPS + WebSocket
Gateway
  | authenticated commands and events
Session orchestrator (one serialized writer per session)
  | Pi adapter
Pi AgentSession / AgentHarness
  | capability-scoped tool calls
Sandbox executor
  | mounted workspace, filtered network, injected secrets
Container or microVM
```

## Service responsibilities

### Browser

- Renders authoritative session snapshots and ephemeral progress.
- Sends commands with a unique request ID and idempotency key.
- Tracks the last durable cursor and session revision.
- Requests a new snapshot after a revision gap.
- Never holds provider credentials or decides whether an operation is allowed.

### Gateway

- Authenticates the connection and derives user and organization identity.
- Authorizes access to workspace, session, artifact, and approval resources.
- Enforces quotas, request size, rate limits, and protocol versions.
- Resolves opaque workspace IDs; it never accepts a browser-supplied host path.
- Brokers approval responses and records the acting principal.

### Session orchestrator

- Serializes state-changing commands through one actor or writer lease per session.
- Owns command idempotency, durable event ordering, snapshots, and reconnect replay.
- Persists every model-visible input and settled external effect.
- Runs turns after the browser disconnects unless the session policy says otherwise.
- Publishes progress separately from authoritative durable state.

### Pi adapter

- Translates Wuming commands into `AgentSession` or `AgentHarness` operations.
- Normalizes Pi events into transcript items, progress, usage, and artifacts.
- Pins a tested Pi version behind this boundary.
- Converts Pi tool requests into sandbox capabilities; it does not expose the
  default host filesystem or shell tools to a remote user.

### Sandbox executor

- Enforces filesystem, process, network, secret, CPU, memory, and wall-time policy.
- Uses a per-workspace or per-run isolation unit with an explicit lifecycle.
- Treats approval as an additional decision, not as the security boundary itself.
- Spills large command output to artifact storage and returns a bounded preview.

## Domain ownership

| Entity | Owner | Important invariants |
| --- | --- | --- |
| Organization/User | Gateway | Identity comes from authentication, never message payloads |
| Workspace | Gateway + executor | Opaque ID maps to exactly one isolated filesystem |
| Session | Orchestrator | At most one live writer; many read subscribers |
| Subagent | Orchestrator | One-level child session; isolated operation/transcript; terminal result published once to parent |
| Turn | Orchestrator | One active turn per session in MVP |
| Transcript item | Orchestrator | Append-only identity; later status updates preserve item ID |
| Tool call | Pi adapter | Every call reaches exactly one terminal settlement |
| Approval | Gateway | Terminal decision is immutable and attributed |
| Artifact | Artifact service | Immutable content, bounded metadata, authorized reads |
| Provider credential | Secret store | Server-side only; model catalog exposes metadata only |

## Persistence model

The authoritative record is an append-only session event stream plus periodic
snapshots. A snapshot contains the fully materialized state at revision `N`.
Durable events advance both the session revision and replay cursor atomically.

Token, thinking, tool-progress, and terminal deltas are ephemeral. They may be
dropped under backpressure. A completed or failed item is always persisted and
will appear in the next authoritative snapshot.

For the first local/single-tenant build, SQLite and Pi's writer-lease backend are
appropriate. The storage interface must remain replaceable by PostgreSQL plus an
event transport when multi-node deployment begins.

## Execution and approval policy

Sandbox policy and approval policy are independent dimensions:

- Sandbox: `read_only`, `workspace_write`, or `unrestricted`.
- Approval: `always`, `on_risk`, `on_failure`, or `never`.

An approval request identifies concrete capabilities such as paths, executable,
arguments, network hosts, or secret names. Approval cannot grant capabilities
that the sandbox policy prohibits. Decisions transition exactly once from
`pending` to `approved`, `denied`, `expired`, or `cancelled`.

## Pi reuse decision

- Reuse `@earendil-works/pi-ai` for provider normalization.
- Start the MVP adapter with `@earendil-works/pi-coding-agent` `AgentSessionRuntime`.
- Replace or wrap coding tools before any remote execution.
- Evaluate `AgentHarness` and the SQLite backend for durable recovery behind the
  same adapter interface.
- Do not expose Pi RPC directly as the public protocol.
- Use Pi protocol snapshot/progress semantics as an input, not as the final API.

## Initial deployability target

Milestone 1 is local, one user, one server, multiple isolated workspaces. It must
still implement authentication boundaries, sandbox enforcement, durable sessions,
and approval correctly so multi-tenancy does not require a security rewrite.
