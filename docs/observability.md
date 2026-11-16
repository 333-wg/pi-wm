# Observability

The gateway emits one JSON object per line to stderr for operational events.
This is intentionally dependency-free so it works in local development,
process-recovery tests, and container logs without a collector.

Set `WUMING_LOG_LEVEL` to `debug`, `info` (default), `warn`, or `error`.
The logger never records prompts, tool arguments/results, attachment content,
tokens, credentials, or authorization headers. String fields are bounded.

Useful event families:

- `gateway.request.*`: authenticated WebSocket command lifecycle, with
  `traceId`, `requestId`, `connectionId`, `sessionId`, and duration.
- `orchestrator.operation.claimed`: durable queue claim, including operation,
  session, mode, and attempt.
- `orchestrator.runtime.*`: runtime start, retry, completion, failure, abort,
  and exception, correlated by `operationId` and `sessionId`.
- `orchestrator.operations.recovered`: operations reconciled after a gateway
  restart.
- `gateway.*.recovery_failed`: asynchronous recovery failures that cannot be
  returned to a WebSocket request.

`operationId` and `sessionId` are the durable correlation keys across gateway
restarts. `traceId` is request-scoped and is useful for connecting the browser
request to the operation acceptance log.

Custom model API keys are excluded from all structured logs. They are only
returned to the Pi runtime registration callback and are never included in the
`model.list` response.

## Verification efficiency counters

`orchestrator.runtime.completed` includes a numeric `verification` object for
the returned runtime attempt:

- `browserCallCount`: observed calls to open, act, snapshot, screenshot, diagnostics
  and tabs tools, including failed calls. Research use of those tools also counts.
- `browserBatchCallCount`: those action calls whose structured action is `batch`.
- `browserObservationCallCount`: separate snapshot, screenshot and diagnostics calls.
  Final evidence included in a batch does not add another call.
- `previewStartCallCount`: preview-start calls, not proven process launches.
- `postEditToolCallCount`: calls after the last observed `edit` or `write_file`;
  omitted if neither is present. This includes work other than verification and
  cannot detect edits performed through shell commands.
- `browserToolDurationMs`: summed browser tool durations when timing is available
  for all observed browser tool names; otherwise omitted. Parallel tool time is
  not wall-clock time, and existing tool timing may include approval waits.

The counters export no commands, paths, tool arguments/results or page content.
They do not infer duplicate work, semantic correctness or external-browser actions
inside `exec`, and do not change completion or verification-warning behavior.
Use them with existing request/operation timing and browser batch action/evidence
timing. Only completed runtime attempts emit this object; failures and interruptions
still use their existing logs. Missing counters in older logs are unknown, not zero.
