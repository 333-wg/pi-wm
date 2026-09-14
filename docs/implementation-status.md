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
- A saved-config real-provider smoke returned the exact expected sentinel on
  2026-09-05 with no tools; see docs/real-provider-smoke-2026-09-05.json.
  The smoke exposed and led to removal of a self-recursive context-usage adapter
  override. Real-session factory coverage now calls the native method directly.
  Model identity, real tool/DAG execution, and actual billing remain unverified.
- Pi-native file definitions exposed as `read_file`/`write_file`/`edit`, backed by Wuming
  workspace-relative operations, realpath enforcement, byte limits, atomic
  replacement, concurrent-edit hash checks, and symlink/junction escape rejection.
- Optional Docker-backed `exec` and `run_python` tools with no network, immutable-image enforcement,
  resource limits, output limits, timeout cleanup, and no host-shell fallback.
- Gateway-side `web_fetch` with DNS pinning, TLS-authenticated transparent-proxy
  support, per-redirect SSRF
  validation, standard-port enforcement, deadlines, body limits, content-type
  restrictions, and HTML-to-text conversion; default Bing HTML `web_search`,
  optional DuckDuckGo/Brave/SearXNG providers, and weather retrieval through
  search, all with durable network/secret approval capabilities.
- Per-agent persistent Playwright Chromium contexts with public/loopback navigation,
  semantic accessibility snapshots and stable element references, page interaction,
  responsive viewport control, PNG evidence artifacts, console/page/network
  diagnostics, multi-tab and popup discovery/switching, private-network request
  blocking, idle eviction, and shutdown cleanup.
- Explicitly enabled per-session host preview servers with workspace-relative
  working directories, loopback readiness probes, bounded logs, idle eviction,
  and process-tree cleanup, allowing a dev server to survive across browser tool calls.
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
- Authenticated inline rendering of browser screenshot artifacts in tool cards,
  with bounded display dimensions and object-URL cleanup.
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
  through turn commands, bounded context assembly into Pi, prompt restore,
  stream-safe queued injection, and per-turn Skill ID usage attribution.
  Skill reads are bounded to 200 KiB plus one truncation-detection byte instead
  of reading the entire file; metadata uses the installed Pi YAML parser with
  exact delimiter checks, BOM and LF/CRLF/CR compatibility, quoted values, and
  folded/literal multiline descriptions. Original body whitespace is preserved.
  Invalid mappings or non-string name/description fields fail lookup and are
  omitted from discovery; errors do not echo raw YAML. Extra metadata such as
  allowed-tools is not interpreted as an authorization grant.
  UTF-8 truncation preserves complete characters.
  Discovery and lookup reject static symlinks/junctions at `.wuming`, `skills`,
  the skill directory, and `SKILL.md`. These path checks are not an atomic
  defense against hostile concurrent filesystem replacement or a host sandbox.
  Gateway resolution preserves the catalog truncation flag. Pi capability
  planning, context planning, execution, and streaming injection all reject
  truncated/missing skills, duplicate or unrequested resolver results, and
  selected skills without a configured resolver before sending a model prompt.
  Skill previews remain available; oversized instructions must be shortened
  before selection for execution. Complete skills still require sufficient
  context budget and are not silently truncated by context assembly.
  Web previews and the composer explicitly warn about truncated skills, offer
  deselection, and block sending before creating a session so the draft is
  preserved. Desktop/mobile browser tests verify no turn request is sent on
  rejection, deselection restores sending, and complete skills remain attached
  to outgoing requests. The wire schema accepts the full 200 KiB preview.
  Skill selection/list responses are guarded by request revisions and workspace
  identity; cancelling, refreshing, reselecting, or switching workspaces
  invalidates older selections. Sending also rejects a skill from a different
  session workspace. Controlled WebSocket-delay browser tests cover cancelled,
  refreshed, and superseded skill reads, including the actual outgoing turn.
- Builtin Skill packages and authorized local package management are shared by
  runtime discovery and the workbench. Model-driven skill_list/skill_load tools
  enforce disabled/manual-only policy and support bounded reference reads.
  Pi's before_agent_start hook preserves the assembled context on the actual
  provider request. Tool failures expose diagnostic feedback and bounded repeat
  guards; returned failure/retry items preserve observed tool and Skill evidence.
  Dynamic Skill attribution does not mutate explicit selections on retries.
  See skill-management.md for installation boundaries and
  skill-evaluation-status.md for real-model results and unverified behaviors.
- Workspace-local MCP declarations from a no-symlink `.wuming/mcp.json`,
  compatibility parsing for `servers` and `mcpServers`/`mcp_servers` maps,
  stdio, Streamable HTTP, and legacy SSE transports, local-device server trust
  in `.wuming/mcp-permissions.json` bound to a normalized configuration digest
  before connection startup, persistent initialized connections, discovery
  caching with tools/list-changed invalidation, abort/timeout termination,
  strict launch/URL validation, enabled/disabled tool filters,
  approval-gated Pi tool bridging with bounded output, model-facing
  `mcp_configure`/`mcp_trust`/`mcp_untrust` management tools, matching
  `mcp.configure`/`mcp.trust`/`mcp.untrust` RPC commands, and MCP
  server/tool/duration/outcome attribution in Usage and the Run rail.
  Existing tool closures revalidate server trust and normalized configuration
  before approval, after approval before connecting, and after initialization
  before dispatch. Removed, modified, malformed, or revoked declarations fail
  closed, release an acquired approval permit, and invalidate the connection.
  These checks do not sandbox trusted host processes or revoke calls already
  dispatched; executable contents are not pinned by this configuration check.
  The stdio receiver rejects invalid JSON, non-object envelopes, incompatible
  response versions, and matching replies with missing/ambiguous results or
  malformed errors. Such failures terminate the connection and allow later
  reconnection; valid remote errors preserve it. Notifications/server requests
  cannot settle a client request with a colliding ID. Non-protocol stdout logs
  now fail explicitly; MCP servers must send diagnostics to stderr. This is
  response-envelope hardening, not full server-request/capability support.
  Both stdout and stderr use streaming UTF-8 decoding. Byte-at-a-time child
  process tests cover Chinese, emoji, and accented characters in tool results
  and exit diagnostics; the result test reproduced corruption before the fix.
  Tool discovery follows opaque pagination cursors, including empty intermediate
  pages, on one initialized connection. A discovery has a shared timeout and
  limits of 20 pages, 100 tools, and 4,000 characters per cursor; exact limits
  are accepted. Repeated cursors, malformed pages/tools, and duplicate exposed
  names reject the catalog rather than exposing a partial result. Trust and
  configuration are rechecked before every page request. Larger catalogs must
  be reduced at the server; automatic tool subsetting is not implemented.
  MCP summaries expose an optional discovery status
  (ready/failed/untrusted/disabled),
  separating a successful empty catalog from discovery failure. The Web panel
  shows a generic failure/retry message without rendering raw server errors,
  clears old detail content during lookup, and updates the list after recovery.
  Desktop/mobile tests exercise actual failing/recovered fixture processes and
  confirm a private stderr canary is absent from the rendered page.
- Depth-bounded durable subagents backed by independent child sessions and operations,
  inherited model/sandbox/approval policy, bounded child budgets, create/list/
  cancel commands, approval handling, restart-safe execution, idempotent result
  and usage propagation to the parent, responsive searchable/status-filtered Web
  queue/detail controls, reusable task configuration, Markdown result rendering,
  direct child-conversation inspection with parent navigation, model-driven
  recursive delegation up to three levels, and descendant-first cascade cancellation.
- Durable single-run goals with explicit pending/start semantics, atomic
  idempotent lifecycle commands, child-session-backed background execution,
  restart-safe status projection, approval/cancellation support, result and usage
  recovery, and a responsive Web Goals workbench.
- Optional Goal review loops with bounded success criteria, independent
  worker/reviewer child sessions, schema-checked per-criterion evidence, grounded
  reviewer tool traces, feedback-driven retry rounds, aggregate usage, atomic run
  transitions, restart continuation, and responsive Web history controls.
- Durable one-time and fixed-interval Goal automations with atomic due claims,
  retry-idempotent manual triggers, immutable run-spec snapshots, missed-interval
  coalescing, archived-parent suppression, startup recovery, pause/resume,
  existing budget/approval/review-loop reuse, bounded run history, child-session
  inspection, and responsive desktop/mobile Web controls.
- Isolated Playwright browser coverage for persisted turns, approval, active-run
  cancellation, completed/cancelled subagents, durable goal and automation
  execution, refresh recovery, and mobile workbench layouts, using dynamic ports
  and disposable demo runtime data.
- Dependency-free structured JSONL gateway/orchestrator logging with bounded
  sensitive-field redaction, request/operation correlation, runtime retry and
  failure lifecycle events, and restart-recovery events.
- Web-configurable OpenAI-compatible and Anthropic-compatible Pi models, with
  server-side connection testing, dynamic provider registration, and optional
  AES-GCM encrypted credential persistence.
- Versioned capability manifests with deterministic dependency/conflict
  resolution, scoped reversible overrides, immutable SHA-256 plans, pre-runtime
  SQLite persistence, restart verification, Pi tool/Skill discovery, drift
  rejection before model requests, and bounded Run-history summaries.
- Plan-bound operation hooks with immutable inputs, deterministic sequential
  execution, enforce/observe modes, timeout and full-manifest drift handling,
  before/after/error lifecycle integration for normal and injected turns,
  deployment-provided Pi manifests, append-only SQLite audit records, and
  redacted Run-history summaries.
- Deterministic context assembly with explicit model/system/output budgets,
  live Pi context occupancy, relevance-ranked optional workspace sources,
  required-fragment fail-closed behavior, explicit head/tail truncation,
  stable/session/turn cache scopes, content-addressed provenance, pre-execution
  SQLite persistence and drift rejection. The Gateway disables Pi's implicit
  context-file loading and admits only bounded `AGENTS.md`,
  `.wuming/context.md`, and `README.md`; the Run rail exposes a body-free summary.
- Body-free per-operation trajectories covering acceptance, attempts,
  capability/context plans, Hooks, model usage, tool summaries, approvals,
  retries, and settlement; atomic SQLite capture, SHA-256 chain verification,
  restart-stable replay, authorized full-report queries, bounded Run summaries,
  and a deterministic five-part structural evaluation that explicitly leaves
  semantic correctness unevaluated.
- Pi-native automatic threshold/overflow compaction enabled by default, with
  adapter capture of successful summaries and summarization usage; automatic
  and manual results become digest-verified, session-scoped SQLite memories with
  transcript source citations, trajectory evidence, bounded authorized listing,
  restart persistence, and per-run memory counts.
- Deterministic same-session memory retrieval through authorized protocol and a
  Pi `memory_search` tool whose closure has no cross-session parameter; retained
  memory promotion, revision-based automatic supersession, release re-evaluation,
  physical forget with body-free audit tombstones, stable historical counts,
  Chinese-aware lexical matching, and responsive Run-rail controls.
- Workspace-scoped reusable evaluation datasets with trajectory, immutable
  artifact, JSON Pointer, text, SHA-256, and isolated command graders; authorized
  terminal-run evaluation, bounded digest-only command evidence, persistent
  histories, Ed25519-signed exportable attestations, independent signature tests,
  and responsive desktop/mobile Run-rail controls. Command graders fail closed
  without the configured Docker process sandbox and never use a host fallback.

## Next production increments

Acceptance checkpoint (2026-09-05): all 550 workspace tests and 30 auxiliary
acceptance tests pass, together with the full typecheck/contrast gate. The new
loopback provider-wire tests exercise real Pi SDK serialization/stream parsing,
durable orchestration, and real file tools, including corrupt-output rejection.
This is local protocol evidence, not external-model acceptance. The saved-model
no-tool smoke passed, but the real file round-trip still has an unresolved
content mismatch and a subsequent pre-tool provider timeout; real DAG and
Docker acceptance are not established. See docs/real-plan-acceptance.md for
commands and explicit boundaries. Browser tests were not rerun for this
test-only increment.

1. Complete hardening of multi-step goals and cross-branch coordination. The
   durable DAG, dependency result handoff, budget reservations, cancellation,
   restart continuation, and Goal/Automation editors are implemented. Focused
   tests cover parallel roots, aggregation, immediate fail-fast sibling
   cancellation, continued independent branches, exhausted budgets, parent
   cancellation, and browser persistence. Stored dependency-cycle injection is
   rejected for Goals, automations, and run snapshots before execution. SQLite
   reopen tests cover committed step attachment and committed parent cancellation;
   same-session plans share reservation accounting. Browser tests cover approval
   waiting across page reload, approval-triggered dependency continuation, and
   denial-triggered downstream skipping from automation history, including
   abrupt gateway termination and restart against the same SQLite database.
   Budget reservations are rechecked inside the SQLite writer transaction;
   a deterministic two-connection test covers competing reservations between
   initial calculation and commit. Full multi-process worker deployment remains
   outside the verified scope.
2. Organization identity, encrypted credential store, RBAC, quotas, and audit UI.
3. PostgreSQL/event transport, multi-node workers, deployment, and observability.

The application is a functional vertical slice, not yet a public multi-tenant
service. Docker execution is covered by argument-level unit tests in this
workspace; an actual Docker daemon was not available for integration testing in
the current development environment.
