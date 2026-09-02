# Implementation Status

## Working and verified

- Shared strict TypeBox client/server protocol.
- Workspace, model, session, turn, progress, approval, and artifact contracts.
- Append-only session events and authoritative snapshots in SQLite.
- Atomic idempotency result, event, snapshot, and operation commits.
- Per-session durable operation queue and fenced writer leases.
- Gateway restart reconciliation that interrupts an abandoned running turn,
  cancels its pending approvals, releases stale local leases, and resumes queued
  operations.
- Pinned Pi 0.84.3 adapter with extensions and built-in host tools disabled.
- Pi text, thinking, tool-call, tool-result, image, usage, and abort mapping.
- Authenticated JSON WebSocket gateway with Origin checks and payload limits.
- Global durable cursor, browser-persisted replay position, selected-session
  restore, attach filtering, and snapshot resync.
- React desktop/mobile workbench with transcript, live progress, and working
  workspace/model selectors backed by configurable server-side catalogs.
- Authorized per-session Run history backed by durable operations, including
  queue/start/finish timestamps, attempts, stop requests, duration, and bounded
  error details in the Web Run rail.
- Durable idle-session rename/archive/restore operations, indexed active and
  archived session collections, bounded literal name/ID search, archived
  read-only enforcement, and responsive sidebar management controls.
- Durable idle-session fork with transcript-prefix copying and fresh usage
  accounting, plus idle-session model and thinking-level mutation commands.
- Manual session compaction through the Pi runtime, durable summary transcript,
  accumulated compaction usage, and a Web compact control for idle sessions.
- Local demo composition root and real Pi configuration path.
- Pi-native file definitions exposed as `read_file`/`write_file`/`edit`, backed by Wuming
  workspace-relative operations, realpath enforcement, byte limits, atomic
  replacement, concurrent-edit hash checks, and symlink/junction escape rejection.
- Optional Docker-backed `exec` and `run_python` tools with no network, immutable-image enforcement,
  resource limits, output limits, timeout cleanup, and no host-shell fallback.
- Gateway-side `web_fetch` with DNS pinning, TLS-authenticated transparent-proxy
  support, per-redirect SSRF
  validation, standard-port enforcement, deadlines, body limits, content-type
  restrictions, and HTML-to-text conversion; default Bing HTML `web_search`,
  optional DuckDuckGo/Brave/SearXNG providers, and no-key Open-Meteo `weather`,
  all with durable network/secret approval capabilities.
- Durable approval requests and immutable settlements, per-session serialization,
  timeout/abort settlement, attributed decisions, and idempotent responses.
- Gateway approval authorization and a responsive Web approval panel.
- Restart-safe approval execution records with one-shot grants, exact Pi tool-call
  continuation for a single unstarted preflight approval, recovered approval
  timeout/abort handling, and conservative interruption for ambiguous or already
  started side effects.
- Durable active/queued turn abort requests, same-process immediate cancellation,
  cross-worker abort polling, Pi `abort()` propagation, and Web Stop control.
- Cross-worker active steer/follow-up delivery into Pi's live queues, with
  durable operation claim, settlement, and sequential fallback after races.
- Abort grace timeout and forced Pi session disposal/eviction when a provider
  ignores cooperative cancellation.
- Authenticated, workspace-scoped artifact upload/download with immutable
  SHA-256 object storage, deduplication, integrity checks, and strict filename,
  MIME, byte, UTF-8, image structure, dimension, and pixel validation.
- Image and text/source artifact delivery to Pi, prompt-reference tamper checks,
  and responsive Web attachment upload, removal, transcript, and download UI.
- Bounded inline tool previews with automatic file/process/web output spilling to
  authenticated artifacts, including live-stream capture beyond the process
  result window and explicit secondary-cap truncation metadata.
- Authenticated lazy file tree, bounded UTF-8 preview, binary detection,
  structured Git status, safe working/staged diff, and responsive Files and
  Changes workbench views.
- Real PTY/ConPTY terminal protocol and xterm workbench with ownership checks,
  minimal child environments, bounded replay, resize, reconnect, idle reaping,
  host mode, and digest-pinned Docker mode. Network reconnect uses the same
  terminal ID and replay cursor; a gateway restart creates a new PTY because
  persistent terminals remain deliberately deferred.
- Process-level recovery coverage that terminates a streaming Gateway process,
  restarts it on the same SQLite data directory, and verifies authoritative
  aborted transcript and interrupted Run settlement.
- Durable per-session USD cost budgets, including explicit create-time budgets,
  failed-attempt usage accounting, budget rejection, and Run-rail remaining
  budget display.
- Bounded orchestrator retries for explicitly retryable provider failures with
  persisted attempts and retry phase, plus Pi retry-event propagation.
- `on_failure` sandbox approval flow that requests approval after a failed write,
  edit, process executor, or web request and replays the exact operation once;
  ordinary nonzero command exits preserve output without an automatic replay.
- Per-request, per-turn, per-model, and per-tool usage attribution with durable
  budget-threshold warning events and Web Run-rail breakdowns.
- Workspace Skill discovery and read-only inspection, selected-Skill propagation
  through turn commands, bounded system-prompt injection into Pi, prompt restore,
  and per-turn Skill ID usage attribution.
- Workspace-local stdio MCP declarations from a no-symlink `.wuming/mcp.json`,
  deployment-controlled server trust before process startup, persistent
  initialized connections, abort/timeout process termination, strict launch
  validation, approval-gated Pi tool bridging with bounded output, and MCP
  server/tool/duration/outcome attribution in Usage and the Run rail.
- One-level durable subagents backed by independent child sessions and operations,
  inherited model/sandbox/approval policy, bounded child budgets, create/list/
  cancel commands, approval handling, restart-safe execution, idempotent result
  and usage propagation to the parent, and responsive Web queue/detail controls.
- Durable single-run goals with explicit pending/start semantics, atomic
  idempotent lifecycle commands, child-session-backed background execution,
  restart-safe status projection, approval/cancellation support, result and usage
  recovery, and a responsive Web Goals workbench.
- Optional backend Goal review loops with bounded success criteria, independent
  worker/reviewer child sessions, durable verdict history, feedback-driven retry
  rounds, aggregate usage, atomic run transitions, and restart continuation.
- Isolated Playwright browser coverage for persisted turns, approval, active-run
  cancellation, completed/cancelled subagents, durable goal restoration, refresh
  recovery, and mobile workbench layouts, using dynamic ports and disposable
  demo runtime data.
- Dependency-free structured JSONL gateway/orchestrator logging with bounded
  sensitive-field redaction, request/operation correlation, runtime retry and
  failure lifecycle events, and restart-recovery events.
- Web-configurable OpenAI-compatible and Anthropic-compatible Pi models, with
  server-side connection testing, dynamic provider registration, and optional
  AES-GCM encrypted credential persistence.

## Next production increments

1. Review-loop Web controls, scheduled/triggered jobs, multi-step goals, and nested/multi-agent coordination.
2. Organization identity, encrypted credential store, RBAC, quotas, and audit UI.
3. PostgreSQL/event transport, multi-node workers, deployment, and observability.

The application is a functional vertical slice, not yet a public multi-tenant
service. Docker execution is covered by argument-level unit tests in this
workspace; an actual Docker daemon was not available for integration testing in
the current development environment.
