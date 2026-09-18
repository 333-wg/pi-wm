# Task Observability: First Batch

## Request Diagnostics

The Run rail now identifies model waiting/output, tool execution, approval,
compaction, retry, stopping, failure, and interrupted states. The most recent
10 model requests show status, time to first content, and total duration.

The Pi adapter publishes a pending request at assistant-message start, updates
it on the first nonempty text/thinking/tool-argument delta, and replaces it with
the final usage/status at message end. Existing request IDs and durable request
usage events are reused; these updates do not independently charge usage.
Timing measures the adapter's message lifecycle, not an HTTP handshake or a
provider-certified time-to-first-token metric. Older requests display unknown
timing. A process killed before a final observation can leave a request without
an end marker; the UI does not invent its duration or treat it as still running
when the session is no longer executing.

Diagnostic JSON export uses a metadata allowlist: phases, bounded run/request
timing, attempts, failure categories, and token counts. It excludes transcript,
tool input/output, raw errors, names, paths, provider configuration, and IDs.
This is not a full request/response capture facility.

## Chat Content Search

`session.search` accepts an authorized workspace ID, a literal query of 1-200
characters, an archive flag, and a result limit of 1-50. Results contain message
IDs, roles, bounded snippets and highlight offsets. The sidebar requests 30
matches and navigates to the selected original message without following the
transcript tail. Search supports Chinese and ASCII-insensitive matching;
non-ASCII case folding is intentionally not performed so offsets remain stable.

Only user/settled assistant text is indexed. Tool output, thinking, attachment
bodies, and in-progress assistant text are excluded. Child sessions are excluded
from the root conversation search. Archived and active collections remain
separate, and workspace authorization is checked before querying.

Two additive SQLite tables hold a rebuildable text projection and its revision.
Projection updates share the authoritative mutation transaction. Startup repairs
missing/mismatched revisions, including older data written without the projection.
Substring matching scans projected text rather than parsing transcript JSON on
every keystroke; it does not introduce an FTS tokenizer or claim indexed substring
query complexity. A future large-history optimization can replace this read model.

## Desktop Notifications

Clients opting into `task.notifications` receive live, body-free completion,
failure, and approval notifications for authorized root sessions, even when not
attached to that session. Historical replay does not emit notifications. Child
sessions are excluded to avoid duplicate notifications; standalone goal/automation
completion outside a root operation is not covered by this first batch.

Electron validates the main-frame IPC sender and notification schema, suppresses
notifications while the window is focused, deduplicates event IDs, and bounds
active notifications. OS text is generic and contains no project/chat name or
result body. Clicking focuses the app and opens the task through normal session
authorization. Settings > General includes a persisted background-notification
switch. No browser notification permission or IM connector is introduced.

Native notification behavior is covered with a fake Electron Notification class;
Windows notification-center delivery remains dependent on OS settings and is not
claimed as a live automated test result.

## Verification

```sh
npm run build
npx vitest run packages/orchestrator/test/session-search.test.ts packages/protocol/test/task-observability.test.ts packages/pi-adapter/test/pi-agent-runtime.test.ts apps/web/test/run-diagnostics.test.ts apps/gateway/test/server.test.ts
node --test apps/desktop/tests/notifications.test.mjs
npx playwright test e2e/task-observability.spec.ts --output test-results/task-observability
```

Worktree task isolation, per-turn code rollback, and impact-selected quality gates
remain separate follow-up batches. Existing unrelated workspace edits are preserved.
