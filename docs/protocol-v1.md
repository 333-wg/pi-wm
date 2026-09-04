# Wuming Wire Protocol v1

The TypeBox source in `packages/protocol/src/index.ts` is normative. This document
defines behavior that cannot be expressed by schemas alone.

## Transport

The MVP uses JSON messages over WebSocket. Large uploads, downloads, and artifact
content use authenticated HTTP endpoints; WebSocket messages carry artifact IDs.
The contract is transport-neutral enough to add CBOR later without changing its
domain semantics.

The first client message is `hello`. The server replies with `hello` or
`hello_error`. Hello negotiates a numeric protocol version and named capabilities.

## Commands

Every command envelope contains:

- `requestId`: correlates exactly one response.
- `idempotencyKey`: deduplicates state-changing retries for the authenticated user.
- `command`: a strict tagged union with no unknown fields.

The server stores successful state-changing results by idempotency key for a
bounded retention period. Reusing a key with a different command is an error.
Acceptance of a prompt means it was durably queued, not that the turn completed.

`session.run.list` returns recent durable operation metadata for an authorized
session. It never returns prompt content. Each entry identifies the input mode,
status, attempt count, abort request, error, queue timestamp, latest update, and
optional start/finish timestamps. The default limit is 20 and the protocol caps
it at 100. Existing rows created before start/finish tracking may omit those two
timestamps.

`session.list` defaults to active sessions and accepts a bounded literal
substring query over session name and ID. Archived sessions are a separate
collection selected with `archived: true`. `session.rename` and
`session.archive` are durable, idempotent mutations restricted to idle sessions.
Archived sessions remain attachable for inspection but reject new turns until
restored.

The `subagents` capability enables a depth-bounded durable child-session workflow:

- `subagent.create` accepts a parent session, task, optional name, and optional
  cost/token limits. It returns after the child operation is durably queued;
  `wait: true` waits for its terminal summary.
- `subagent.list` returns bounded child summaries plus the current depth and
  whether another level may be created for one authorized parent.
- `subagent.cancel` durably requests cancellation and propagates abort to a live
  runtime or recovered pending approval.

A child inherits the parent workspace, model, thinking, sandbox, approval
policy, and remaining budget ceiling. Child sessions are omitted from the
normal session list and can recursively delegate up to three agent levels. Cancelling
an ancestor cancels active descendants before settling the ancestor. On terminal settlement,
the orchestrator writes one stable `subagent:<childSessionId>` tool result to
the parent transcript and aggregates the child's usage once. The stable item ID
makes recovery and repeated publication idempotent.

The `goals` capability provides durable pending objectives with explicit start
and cancel commands. A goal may include success criteria and a bounded review
round count. After each worker result, an independent reviewer returns a strict
JSON verdict with one or more criterion checks. An overall pass is accepted only
when every check passes. Durable review history keeps model-provided evidence
separate from the tool names observed in the reviewer session; a failed review
starts a fresh worker session with the feedback until the round limit is reached.

Prompt behavior is explicit:

- `turn.prompt` starts a turn only when the session is idle.
- `turn.steer` joins the current run after its active tool batch settles.
- `turn.follow_up` queues input for after the current run would otherwise stop.
- `turn.abort` requests cancellation and remains idempotent.

The worker holding the session writer lease claims queued steer/follow-up
operations while the primary runtime call is active and injects them into the
provider session. If the runtime stops before delivery, the operation is
requeued and executes through the normal durable worker loop. Abort first uses
cooperative cancellation, then force-terminates and evicts the runtime session
after a bounded grace period.

## Ordering and recovery

Each durable session mutation increases `revision` by one. Durable event envelopes
also have a monotonically increasing opaque `cursor`. A cursor is scoped to the
authenticated event feed and must only be compared for equality/continuation.

Progress messages have a `streamSeq` scoped to one item. They do not change the
session revision and are never required for recovery.

On connection loss:

1. The client reconnects with its last durable cursor.
2. The server replays retained durable events in order.
3. If the cursor is unavailable, the server emits `resync_required`.
4. The client requests `session.snapshot.get` for attached sessions.
5. The client discards local optimistic state newer than the returned revision.

On any session revision gap, the client stops applying durable events for that
session and requests a snapshot. Stale snapshots and events are ignored.

## Snapshot authority

`session.snapshot` is the complete browser-facing state for a session revision.
It includes settled transcript items, the current phase, model configuration,
queued input count, pending approvals, and cumulative usage.

The browser may render progress optimistically on top of a snapshot. Optimistic
state is keyed by stable item/tool-call IDs and is replaced by authoritative state
when a snapshot or durable item update arrives.

## Approvals

An `approval.requested` event is durable. Only an authorized `approval.respond`
command may settle it. The server validates that the approval is still pending,
has not expired, belongs to the same organization and workspace, and that its
capabilities match the pending tool operation.

Approval decisions never carry shell scripts or replacement tool arguments. A
decision approves or denies the immutable request that was displayed.

The server durably binds an approval to its Run and tool-call ID. On restart it
may preserve a single pre-execution approval and resume that exact persisted tool
call after approval. It must not automatically replay a tool whose durable state
is `executing`, `completed`, ambiguous, or a retry after an earlier tool failure.

## Artifacts and limits

Images, uploaded files, patches, complete logs, and generated assets are artifacts.
Content parts reference artifact IDs and MIME types. Servers must validate size,
MIME type, ownership, retention, and optional malware status before model use.

Transcript previews and progress deltas are bounded. Truncation returns an artifact
reference to the complete output rather than silently losing it.

## Evolution

Adding an optional field is backward compatible only when old clients can safely
ignore it. New commands, event variants, required fields, or changed semantics
require capability negotiation or a new protocol version. Shared schemas are
published from one package; browser and server must not mirror them manually.
