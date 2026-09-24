# Interrupted conversation recovery

Stopping execution does not rewind conversation history or undo side effects.
The gateway reconciles the Pi log before context budgeting and before sending
the next idle turn. It never executes a tool as part of reconciliation.

## Sources of truth

- SQLite operations retain the original accepted input, internal runtime input,
  attachment references, terminal status, and structured failure reason.
- Pi's active append-only branch retains raw model messages and tool results.
  Recovery searches the full branch so compacted inputs are not reintroduced.
- The UI transcript is used only for tool IDs and execution status. Display
  previews are not converted into fabricated assistant messages or tool results.

Inputs sent through the adapter receive an operation ID and content digest in
non-model-visible Pi metadata. Legacy inputs are matched by original content and
execution time. A missing input is restored as explicitly historical context,
using the original artifact resolver for images and files. Missing artifacts
fail recovery rather than silently omitting the attachment.

Each model-visible recovery record carries its operation receipt in the same
append. Receipts survive restart and compaction and prevent repeated injection.
When there is no Pi log yet, the original requests remain recoverable from SQLite
even if the process exits repeatedly before producing its first assistant reply.

## Safety boundaries

- Active or queued work is not imported as completed history. The current turn
  is excluded, and a pending/resuming tool approval is left untouched.
- Recovery preserves completed raw results. Missing results are not successes;
  failed results may also have partial side effects. The model is instructed to
  inspect current state before repeating an uncertain operation.
- Pi's provider serialization supplies error results for unresolved calls and
  omits incomplete assistant responses. Recovery does not replay these calls.
- An intact completed conversation is unchanged in model-visible content.
- A missing Pi log cannot reconstruct full assistant replies or tool outputs
  from UI previews. Recovery states this limitation explicitly.
- This is not an exactly-once execution guarantee for arbitrary external tools,
  a filesystem rollback, or protection against corruption/deletion of both stores.

## Editing and explicit forks

Editing a user message sends `turn.prompt` with an `edit` anchor and the revision
captured when the editor was opened. It keeps the current session ID. The
orchestrator stages a separate Pi history file, then atomically commits its
`runtimeHistoryId`, the retained transcript prefix, and the replacement operation
in SQLite. Stale edits, active work, queued work and pending approvals are
rejected. A staging failure leaves the original conversation untouched.

An explicit `session.fork` also stages the actual Pi branch, including raw tool
results, attachment contents and the applicable compaction entries. UI previews
are never substituted for raw messages. The new history pointer survives restart
and selects a separate directory, so reopening a session cannot select an older
branch by file modification time. A missing selected history fails closed.

Old operations and history files remain available for auditing. Recovery excludes
operations whose user messages were removed from the active transcript. Both
editing and forking add a model-visible notice that external effects were not
undone and uncertain actions require checking the current state before retrying.
Legacy display-only forks with missing source history are rejected rather than
silently treated as valid empty conversations; reopen the original conversation.

Regression coverage includes `edit-history.test.ts`, `session-history.test.ts`,
`history-branch-wire.test.ts`, and the edit/fork browser test in `wuming.spec.ts`.

## Verification

Run from the repository root:

```sh
npx tsc -b --pretty false
npx vitest run packages/pi-adapter/test/session-recovery.test.ts packages/pi-adapter/test/interrupted-context.test.ts packages/pi-adapter/test/crash-recovery.test.ts packages/pi-adapter/test/pi-agent-runtime.test.ts packages/orchestrator/test/recovery-operations.test.ts
node scripts/check-tests.mjs --only pi-adapter,orchestrator,gateway
```

The crash test kills a real child process without graceful cancellation, reopens
its SQLite database, invokes orchestrator restart recovery, and resumes through
the real Pi adapter. A local mock server inspects provider requests for Chat
Completions, Responses, and Anthropic Messages. It tests three crash boundaries:

1. Before the first assistant response, when no Pi session log exists yet.
2. After a file write has happened but before its tool result is returned.
3. After the tool result was persisted, while the next provider request waits.

Assertions cover the original request, structured restart reason, retained or
missing tool evidence, inspection after an uncertain write, and no automatic
replay of the original write. The mock validates transport and orchestration,
not a guarantee about the decisions of every remote model.
