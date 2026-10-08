# Interrupted conversation recovery

Stopping execution does not rewind conversation history or undo side effects.
The gateway reconciles the Pi log before context budgeting and before sending
the next idle turn. It never executes a tool as part of reconciliation.

## 长任务中的自动上下文压缩

自动压缩开启时，Pi 适配器会在一批工具全部完成后、下一次模型请求前检查预算，
不再只等待整个 Agent 任务结束。检查使用最近有效的模型用量加新增工具结果估算，
预留 `max(Pi reserveTokens, min(model.maxTokens, 8192))`，再加模型窗口的 5% 安全余量。
这不是界面 75% 提示所代表的固定触发点，也不是累计计费 Token 上限。

压缩复用 Pi 的摘要、会话日志和 `compaction_start/end` 事件。最新工具调用与整批结果
完整保留，当前参考快照会恢复；随后继续同一任务，不重放已经执行的工具。
界面继续使用现有的压缩中、完成、失败及取消状态。摘要失败或压缩后仍超预算时，
停止本轮后续推理并返回错误，不在同一轮里反复压缩；可检查原因后重新发起请求。
显式关闭自动压缩时，不启用这项工具循环检查。

`packages/pi-adapter/src/loop-compaction.ts` 是针对固定 Pi 0.84.3 版本的小型兼容层：
使用公开的 `prepareNextTurnWithContext` 安全边界，以及 SDK 内部的非中止式自动摘要入口。
不修改 `node_modules`，不在循环里调用会中止任务的手动 `compact()`。
升级 Pi 时必须重新验证该兼容层。回归测试使用真实 SDK 和本地模拟模型服务，覆盖
并行工具、大结果、排队指令、失败、取消和压缩后仍超预算，不调用付费模型。

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
