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
