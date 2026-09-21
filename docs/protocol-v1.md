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
The server hello also includes `executionEnvironment`: `placement` identifies a
user-device host or server, while `processMode`, `terminalMode`,
`previewEnabled`, `platform`, and `shell` describe where code will actually run.
Clients must display this server-provided value and must not infer local
execution from the browser URL.

## Commands

### Context Occupancy

Snapshots may include `contextUsage: { model, tokens, basis }`, independently of
cumulative `usage` and per-request billing. `basis` is `request` (last successful
model request's input, cache and output occupancy estimate), `compaction` (the
retained-content estimate after compaction), or `unknown`. `tokens: null` means
the current size is unknown; it must not fall back to a pre-compaction count or
be displayed as zero. The denominator comes from the selected model metadata.

The durable `session.context.updated` event carries `sessionId`, `revision` and
`contextUsage`. Runtime updates commit immediately under the session writer
lease, including when a later provider request fails. Manual compaction updates
occupancy in the same mutation as its summary and usage. Model changes invalidate
the old occupancy. Snapshots/event replay preserve these observations across
reloads. Clients with older snapshots may estimate from a single matching-model
request but must not sum whole-turn tool-loop usage as context occupancy.

These are observations, not exact live tokenization of a streaming request:
tool output/new input may grow between observations, and the compacted-content
estimate may exclude request scaffolding. Summary-generation usage remains
billable consumption and must not replace the compacted context count.

### Request Envelopes

Every command envelope contains:

- `requestId`: correlates exactly one response.
- `idempotencyKey`: deduplicates state-changing retries for the authenticated user.
- `command`: a strict tagged union with no unknown fields.

The server stores successful state-changing results by idempotency key for a
bounded retention period. Reusing a key with a different command is an error.
Acceptance of a prompt means it was durably queued, not that the turn completed.

`mcp.configure`, `mcp.trust`, and `mcp.untrust` are state-changing commands
for a local-device Gateway. All retain a workspace context for authorization.
`mcp.configure` accepts optional `scope` (`workspace` by default, or `global`)
and `previousScope` for an explicit move. Moving rejects destination ID conflicts
and revokes prior trust. Global files live under the application data directory;
workspace files remain in the project. Lists merge both, with workspace IDs
overriding global IDs. Summaries expose optional `scope`; legacy clients may
treat its absence as `workspace`. Get, trust, enable, untrust, and remove operate
on the effective entry's original store. `mcp.configure` validates
and writes one server entry into `.wuming/mcp.json` and clears any local trust
for that server; it returns `mcp.updated` with the untrusted server summary.
`mcp.trust` records trust in `.wuming/mcp-permissions.json`, verifies the server
configuration digest, starts discovery, and returns the updated server summary.
`mcp.untrust` removes local trust, closes any initialized connection, and returns
the server as untrusted. Server-mode Gateways may reject these commands as not
implemented. Read-only principals may use `mcp.list` and `mcp.get`, but not MCP
management commands.

`session.run.list` returns recent durable operation metadata for an authorized
session. It never returns prompt content. Each entry identifies the input mode,
status, attempt count, abort request, error, queue timestamp, latest update, and
optional start/finish timestamps. The default limit is 20 and the protocol caps
it at 100. Existing rows created before start/finish tracking may omit those two
timestamps. Runs resolved by a capability-aware runtime also include a bounded
capability-plan summary with its SHA-256 digest, capability count, model-visible
tool names, and prompt-fragment references. Full tool schemas and Skill bodies
are not exposed by this command.
Context-aware runs include a bounded context-plan summary: the full-plan digest,
stable cache-prefix digest, estimated/available system-token budget, selected
and omitted counts, and per-fragment ID, kind, source, rendered token count,
cache scope, and truncation flag. Fragment bodies, metadata, and relevance
scores remain server-side.
Runs that executed planned operation hooks also include up to 100 ordered hook
audit summaries: hook ID/version, lifecycle point, enforcement mode, outcome,
timestamps, duration, and optional machine-readable code. Internal hook reasons
and annotations remain server-side.
New runs include a compact trajectory summary with the event count, verified
head digest, chain-integrity result, and deterministic `structural-v1`
evaluation. The evaluation explicitly sets semantic correctness to
`not_evaluated`.

`session.run.trajectory.get` returns the complete bounded trajectory report for
one run after checking both session authorization and run ownership. The replay
contains at most 2,000 hash-chained, body-free events plus the structural
evaluation. It never returns prompts, tool inputs/outputs, Hook annotations,
credentials, or raw retry errors. Those remain in their existing authorized
stores and can be correlated through stable IDs and digests.

The `evaluation` capability adds workspace-scoped regression specifications and
terminal-run checks. `evaluation.dataset.list`, `.create`, and `.delete` require
authorization to the opaque workspace ID. A dataset contains 1-20 strict graders:
trajectory integrity/score thresholds, artifact existence, SHA-256, text, or
JSON Pointer assertions, and isolated command exit/output assertions.

`session.run.evaluate` requires authorization to the session and verifies that
the run belongs to it and is terminal. The request must select exactly one saved
dataset or provide a non-empty inline grader array; this cross-field invariant is
enforced by the Gateway. Artifact graders can read only immutable artifacts from
the run's workspace and recheck their stored content digest. Command graders are
disabled for read-only sessions and when no deployment-configured process sandbox
exists. They never fall back to a host shell. Evaluation records contain bounded
evidence and SHA-256 output digests rather than raw command stdout or stderr.
`session.run.evaluation.list` returns up to 20 persisted results for the
authorized run.

`session.run.attestation.create` signs the canonical evaluation identity,
evaluation digest, session/run IDs, trajectory head, and issue time with the
Gateway's durable Ed25519 key. The result includes its public key, `keyId`,
payload digest, and signature so the export can be verified independently. A
self-contained public key proves internal integrity, not who operated the
Gateway; production verifiers must pin the expected `keyId` or public key through
a trusted deployment channel. Dataset create/delete, run evaluation, and
attestation creation use the normal idempotency-key contract.

`session.memory.list` returns up to 20 active, digest-verified compaction memory
records for one authorized session, retained records first and then newest first.
Each immutable body identifies whether compaction was manual, threshold-triggered,
or overflow-triggered; includes bounded summary text, token estimates, optional
summarization usage, and cites the source snapshot revision plus first/last
transcript item IDs.

`session.memory.search` accepts a 500-character query and returns at most 10
deterministically ranked active matches with matched terms and source citations.
It excludes superseded and forgotten records. The model-facing `memory_search`
tool is stricter than the client command: its host closure binds the current
session, so its schema contains no session identifier.

`session.memory.manage` is an idempotent idle-session mutation with `promote`,
`release`, and `forget` actions. Promotion protects a memory from automatic
supersession; release reapplies the coverage rule. Forget physically deletes the
summary and returns only status metadata. A body-free tombstone preserves its ID,
digest, operation, source revision, and lifecycle audit. Run summaries count both
live memories and tombstones so historical creation counts remain stable.
Memories are never listed or searched across session boundaries by the model.

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

Both `goal.create` and `automation.create` accept an optional `plan`:

- `steps` contains 1–20 entries with stable `id`, `title`, `objective`,
  and `dependsOn` step IDs. Duplicate IDs, unknown dependencies, and cycles
  are rejected before persistence; input order need not be topological.
- `maxParallel` is 1–4 (default 2). `failurePolicy` is `fail_fast`
  (default) or `continue_independent`.
- Optional step `successCriteria` enables the existing independent review
  loop with `maxRounds` 1–5 (default 3). A plan cannot also specify a
  top-level review loop.
- Goal and automation-run summaries expose `plan` with per-step status,
  dependency IDs, usage, approvals, linked run IDs, results, and skip reasons.
  Internal step Goals are excluded from the ordinary Goal list.
- Ready steps share the workspace and receive bounded completed dependency
  results. Parallel filesystem writes are not isolated; use dependencies for
  steps that edit overlapping files. Active steps retain budget reservations
  until settlement. This is a dispatch budget, not a provider-side spending cap.

The `automations` capability schedules that Goal lifecycle without accepting a
raw prompt at trigger time:

- `automation.create` accepts an absolute one-time timestamp or an absolute
  interval start plus `everyMinutes`, together with the Goal objective and
  optional bounded review policy.
- `automation.set_enabled` pauses or resumes an interval or an unconsumed
  one-time plan. A consumed one-time plan is complete and cannot be re-enabled.
- `automation.trigger` creates a manual run without consuming or shifting the
  scheduled slot. Command idempotency maps a retried trigger to the same run.
- `automation.list` and `automation.run.list` return authorized plan and run
  summaries. A run begins as `dispatching`, then projects the linked Goal status,
  usage, result, and bounded error.

The durable trigger record snapshots the title, objective, success criteria, and
round limit before dispatch. A unique automation/trigger key plus an atomic
schedule advance prevents two workers from claiming the same slot. After
downtime, an interval emits one catch-up run and advances to its first future
slot; it does not replay every missed interval. Plans belonging to archived
sessions remain inspectable but are excluded from scheduled claims.

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
