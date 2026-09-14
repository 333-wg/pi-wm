# Architecture Decision: Pi-Based Web Agent

Status: accepted for MVP foundation

## Product boundary

Wuming is local-first. The process that owns a workspace must run on the user's
device when Wuming is expected to use that user's files, Shell, PATH, developer
tools, terminal, browser preview, or credentials. Pi owns model and agent
execution. Wuming owns workspace lifecycle, durable orchestration, approval,
sandboxing, artifacts, and the client protocol.

```text
Browser or desktop shell
  | loopback WebSocket
Local device host (Gateway/app-server role)
  | authenticated commands, events, and approvals
Session orchestrator (one serialized writer per session)
  | Pi adapter
Pi AgentSession / AgentHarness
  | capability-scoped tool calls
User workspace executor
  | local Shell by default; optional Docker sandbox
User device
```

A cloud control plane may broker identity, model access, or synchronization, but
it is not the execution host for a user's local project. Remote execution needs
an explicit device host connection; there is no fallback to the cloud server's
Shell.

## Service responsibilities

### Browser

- Renders authoritative session snapshots and ephemeral progress.
- Sends commands with a unique request ID and idempotency key.
- Tracks the last durable cursor and session revision.
- Requests a new snapshot after a revision gap.
- Never holds provider credentials or decides whether an operation is allowed.

### Local device host

- Runs on the same device as the selected workspace and binds loopback by default.
- Authenticates the connection and derives user and organization identity.
- Authorizes access to workspace, session, artifact, and approval resources.
- Enforces quotas, request size, rate limits, and protocol versions.
- Resolves opaque workspace IDs to paths on that device; it never accepts an
  arbitrary browser-supplied host path.
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

| Entity              | Owner              | Important invariants                                                                                                                 |
| ------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| Organization/User   | Gateway            | Identity comes from authentication, never message payloads                                                                           |
| Workspace           | Gateway + executor | Opaque ID maps to exactly one isolated filesystem                                                                                    |
| Session             | Orchestrator       | At most one live writer; many read subscribers                                                                                       |
| Subagent            | Orchestrator       | Child session bounded to three levels; isolated operation/transcript; cascade cancellation; terminal result published once to parent |
| Turn                | Orchestrator       | One active turn per session in MVP                                                                                                   |
| Transcript item     | Orchestrator       | Append-only identity; later status updates preserve item ID                                                                          |
| Tool call           | Pi adapter         | Every call reaches exactly one terminal settlement                                                                                   |
| Approval            | Gateway            | Terminal decision is immutable and attributed                                                                                        |
| Artifact            | Artifact service   | Immutable content, bounded metadata, authorized reads                                                                                |
| Provider credential | Secret store       | Server-side only; model catalog exposes metadata only                                                                                |

## Persistence model

The authoritative record is an append-only session event stream plus periodic
snapshots. A snapshot contains the fully materialized state at revision `N`.
Durable events advance both the session revision and replay cursor atomically.

## Capability resolution

Before a capable runtime sends the first model request for an operation, it
describes its effective tools, Skills, MCP surfaces, and prompt fragments as
versioned manifests. The capability kernel resolves dependencies, scope
overrides, denials, and conflicts into one immutable `CapabilityPlan` whose
digest covers the complete JSON representation and session policy context.

The orchestrator persists that plan on the durable operation before calling the
runtime. Retries and recovered operations reuse it. The Pi adapter recomputes
the current plan immediately before execution and fails closed if a tool schema
or selected Skill changed after resolution. This keeps the recorded plan and
the model-visible request aligned without moving sandbox or approval policy
into the Pi adapter.

Clients receive only a bounded plan summary in Run history: digest, capability
count, model-visible tool names, and prompt-fragment references. Full schemas
and Skill content remain on the Gateway side; in the normal local-device setup
that means the user's computer, not a Wuming cloud service.

### Operation hook pipeline

Hook handlers are trusted server-side code paired with versioned `hook`
capability manifests. The orchestrator executes planned hooks sequentially at
`operation.before_execute`, `operation.after_execute`, and
`operation.on_error`. Handler inputs are immutable and results cannot mutate
prompts, tool arguments, the capability plan, sandbox policy, or approvals.
They can continue, deny, or attach bounded JSON annotations.

Enforcing hooks fail closed on denial, timeout, invalid output, missing handler,
or full-manifest drift. Observing hooks fail open so telemetry outages do not
stop work. Each outcome is appended to a dedicated SQLite audit table; the Run
API exposes only bounded metadata and omits internal reasons and annotations.
The Pi adapter accepts deployment-provided manifests so policy hooks participate
in the same resolution and pre-request drift checks as tools and Skills.

## Context assembly

Before execution, a context-aware runtime resolves the base system prompt,
selected Skills, policy files, and workspace references into a bounded,
immutable `ContextPlan`. Every fragment has a version, source, content hash,
priority, cache scope, and explicit truncation policy. Required fragments fail
closed when they cannot fit; optional fragments are relevance-ranked against the
turn query and may be omitted or truncated only when their manifest permits it.

The Gateway currently admits only `AGENTS.md`, `.wuming/context.md`, and
`README.md` through workspace-relative, realpath-checked reads. Pi's implicit
project-context loading is disabled so these files cannot bypass budgeting or
provenance. Model metadata determines the context window and output reserve;
Pi's live context usage accounts for conversation occupancy. The durable plan
stores hashes and decisions, never file or Skill bodies.

The orchestrator persists the plan before hooks and runtime execution. The Pi
adapter reassembles it immediately before a provider request and rejects digest
drift. Normal turns receive the bounded assembly as the active system prompt;
steer/follow-up turns carry their selected context in the queued message so a
temporary prompt restore cannot drop it. Run history exposes only a bounded
summary, while `cachePrefixDigest` identifies the stable prefix independently
from session- and turn-scoped fragments.

Conversation-history compaction remains owned by Pi. Its mature threshold and
overflow checks stay enabled by default instead of being duplicated in the
orchestrator. The adapter captures successful automatic compaction results and
their model usage; manual `/compact` uses the same durable representation.

Each result becomes a session-scoped, digest-verified compaction memory with the
source snapshot revision and first/last Wuming transcript item IDs. Automatic
memories are committed atomically with operation settlement and referenced by a
`compaction.completed` trajectory event. Manual memories are committed with the
compacted session snapshot.

The immutable memory body and source citation remain digest-bound while a
separate lifecycle state controls retrieval. A newer cumulative compaction
supersedes active automatic memories whose source revision it covers. A user can
promote at most 20 memories to retained state; retained memories survive newer
compactions, and releasing one immediately reapplies the supersession rule.
Forgetting is irreversible: the summary and its state row are physically deleted,
while a body-free tombstone preserves the memory ID, digest, operation, source
revision, and lifecycle audit without retaining the text.

The authorized `session.memory.list` command returns at most 20 active records,
with retained records first. `session.memory.search` returns at most 10
deterministically ranked active matches and never returns superseded or forgotten
content. Pi receives the same retrieval through `memory_search`; its tool closure
binds the current session and its input schema deliberately has no `sessionId`.
Memory is neither injected nor retrievable across sessions by the model: sharing
summaries within a workspace without an explicit policy would violate session
isolation.

## Goal automation scheduling

An automation is a durable definition owned by one parent session. Its schedule
is either one absolute timestamp or a fixed minute interval with an absolute
start. SQLite stores definitions separately from immutable trigger records. Each
trigger record snapshots the Goal specification, so later plan changes cannot
alter the meaning of an already claimed run.

The due scanner first lists active definitions whose parents are not archived.
Claiming then runs inside `BEGIN IMMEDIATE`, rechecks the parent and expected
`nextRunAt`, inserts a run under a unique `(automationId, triggerKey)`, and
advances the definition before model work begins. A one-time plan is consumed;
an interval advances to the first future slot. This produces one compensating
run after downtime without a replay storm. A manual trigger has its own stable
idempotency key and never changes the scheduled slot.

Dispatch reuses the existing Goal create/start/drive path rather than introducing
a second execution engine. Budgets, sandbox policy, approvals, retries, reviewer
rounds, child sessions, and result projection therefore keep the same semantics.
The Gateway resumes nonterminal automation runs on startup and scans due plans on
`WUMING_AUTOMATION_POLL_MS`; shutdown waits for the active scan before closing
SQLite. The atomic claim supports multiple SQLite connections on one host, while
multi-node scheduling still requires the planned PostgreSQL/event transport.

## Operation trajectories and structural evaluation

Every new operation owns a body-free, append-only trajectory in SQLite. The
orchestrator writes lifecycle evidence in the same transaction as the state it
describes: acceptance, attempt start, capability/context resolution, Hook
outcomes, model request usage, tool summaries, approval transitions, retry
scheduling, and terminal settlement. Prompt bodies, tool arguments/results,
Hook annotations, credentials, and raw errors are not copied into this table;
the retry event keeps only an error digest.

Each event commits to its canonical contents and the previous event with
SHA-256. Replay verifies the operation ID, contiguous sequence, previous digest,
and event digest, so storage drift is localized to the first invalid sequence.
The chain is tamper-evident rather than cryptographically signed: an actor with
database write access could rebuild it, so signed external attestations remain
a separate deployment concern.

`structural-v1` deterministically scores chain integrity, terminal completion,
retry/tool reliability, Hook/approval policy signals, and evidence coverage.
It always reports semantic correctness as `not_evaluated`; a structurally clean
run is not proof that the answer is factually or functionally correct.

## Artifact-aware evaluation and attestations

The evaluation subsystem consumes an authorized terminal replay together with a
saved workspace dataset or inline grader specification. It deliberately layers
task-specific evidence on top of `structural-v1` instead of changing the meaning
of the structural score. A grader can require trajectory integrity/score, assert
against an immutable artifact after SHA-256 verification, or execute a bounded
command in the deployment-configured process sandbox.

Evaluation datasets, results, signatures, and idempotency rows live in a separate
SQLite store behind `GatewayEvaluationManager`. The Gateway verifies workspace,
session, run, and artifact ownership before calling the pure grader package. It
rejects non-terminal runs, read-only command graders, and command graders when no
process sandbox is configured. There is no host-process fallback. Raw command
stdout/stderr is reduced to pass/fail evidence and a digest before persistence.

A durable Gateway Ed25519 key signs a canonical attestation that binds the
evaluation digest to the run and trajectory head. Exports include the public key
so offline consumers can detect modification. This is an integrity mechanism,
not an identity PKI: a production deployment must publish or pin the expected
`keyId` independently. Rotating keys and organization-managed trust distribution
remain deployment concerns.

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

Milestone 1 is local, one user, one device host, multiple workspaces. It must
still implement authentication boundaries, sandbox enforcement, durable sessions,
and approval correctly so multi-tenancy does not require a security rewrite.
