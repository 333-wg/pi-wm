# Agent Teams

The Teams tab and `/teams` command open the collaboration workbench in both
the web client and the Electron renderer. **Team collaboration** now uses a
persistent team runtime. The previous subagent/goal projection is retained
in a separate **Subtasks** tab; it is not embedded in Agent Teams and is not the
team scheduler or a peer mailbox.

## Running a Team

Selecting the `team` skill and submitting a concrete objective, or submitting
`/team <objective>`, is an explicit launch action. The host executes it through
the existing durable turn queue and team service without asking the source model
to decide whether to create a team. A `team_start` receipt records the actual team
ID and the chat shows an Open team action. The selection is consumed after the
request is accepted, so ordinary follow-up chat does not create another team.
An empty objective, disabled skill or unavailable service fails visibly; it never
falls back to solo coding. Stop an active source task before requesting a team.

The launch copies prior user/assistant text and attachment references into the
private lead's durable inbox. Current requirements take precedence over quoted
history. Oversized context fails instead of silently dropping requirements.
Operation IDs deduplicate launch retries, and the receipt survives reload.

Select the project's working directory and explicitly ask in chat to use the
`team` skill for a concrete task. The skill loads the persistent collaboration
workflow; the chat calls `TeamCreate`, which creates a dedicated lead execution
context and durably queues the objective. That lead creates teammates and shared
tasks asynchronously. The chat reports the launch result and returns to the user;
it is not a team member and does not poll or coordinate the work.
The Teams page is a project-level monitor, not a per-conversation creation form.
Opening it or creating an ordinary conversation does not create a team.
The Pi runtime, configured provider
and tool-capable model are required for autonomous planning. The standard Demo
runtime only echoes prompts; it does not pretend to plan or execute a team.

Natural-language requests are interpreted by the model, not a keyword launch
rule. Clear intent to use team collaboration calls TeamCreate; mentions in
quotes, negations and questions do not. Ambiguous intent requires clarification.
The launch objective preserves user-assigned members, roles and roster limits.

The lead assesses required capabilities and inspects effective AgentTemplates
(user overrides project overrides builtin; shadowed candidates are omitted).
Saved configurations are optional candidates, not automatic project members.
Suitable templates are reused; missing roles are created with Agent(name, role)
without templateName, both at startup and later. Explicit user assignments win
over suitability selection; an exclusive roster forbids extra members. Missing
named templates or incompatible tool permissions are blockers, not permission
to silently replace a member or bypass restrictions.

New launches must assign real, executable teammate work. If the lead finishes
without doing so, the scheduler sends one durable corrective reminder. Continued
failure marks the lead as needing attention with a retry action; it does not
poll indefinitely or fabricate workers. The reminder survives gateway restarts.
Explicit retry resets that bounded attempt. Worker task activation ends the
startup check; provider failures still follow the existing manual retry flow.

The built-in skill excludes questions about the feature, quoted mentions, and
ordinary solo work. Team creation follows explicit task intent, not keyword
matching. Teams have their own IDs, workspace ownership and lifetimes. The same
chat can launch several teams; changing, finishing or archiving it affects none
of them. The launch objective must include the relevant requirements, constraints
and file paths because the private lead does not inherit the source transcript.
Members use separate, persistent execution contexts in the same workspace, not
successive one-shot subagent sessions. These records are available from the team
workbench but excluded from normal chat lists and chat search before pagination.

## Runtime and Protocol

- `TeamCreate`: launch an independent team with a private lead and pending objective.
  Tool-call IDs deduplicate retries and concurrent replays, not different requests
  from the same chat. Members cannot create nested teams.
- `AgentTemplates`: inspect reusable user/project/builtin member configurations.
- `Agent`: create a retained teammate session; return immediately, without waiting
  for its final answer. Optional template/model/effort settings resolve before
  creation; sandbox policy, approval policy and per-session budgets inherit from
  the lead. See `agent-templates.md` for configuration and runtime tool restrictions.
- `TaskCreate`, `TaskGet`, `TaskList`, `TaskUpdate`: shared tasks with owners,
  dependencies, declared write scopes, explicit completion/failure and results.
- `SendMessage`: authenticated sender identity comes from the executing session.
  Direct messages and broadcasts enter durable recipient mailboxes. Plain
  assistant text is not a peer message.
- `TeamFinish`: only the lead can accept the work. Every task must be completed,
  teammates idle and mail delivered; acceptance evidence is required. This is
  an explicit model decision, not an independently certified verification.
  At least one activated non-lead member must have completed delegated work;
  a lead-only plan cannot be accepted as team collaboration.

The lead explicitly assigns each teammate's first task. Once activated, idle
members can claim unowned, dependency-ready work in the same session. Claims
are atomic SQLite transactions. A member cannot hold two active tasks or finish
another member's task. Cyclic dependencies and unknown/cross-team IDs are rejected.

Each member has a serial execution loop; different members run concurrently.
An idle member consumes no model calls. Pending mail wakes idle members and
waits for an active member's next turn. Failed turns require explicit retry;
they do not silently complete tasks or enter automatic model retry loops beyond
the existing orchestrator's bounded transport retry policy.

Members share the working directory. Overlapping declared file/directory write
scopes serialize task claims. This is coordination, not filesystem isolation or
an automatic Git merge system. Undeclared edits remain the model's responsibility.

Limits: 8 members including the lead, 100 tasks, 5,000 messages, and 100 automatic
mail deliveries per member. Each member has its own inherited session budget;
there is **no shared atomic team-wide spending cap**. The displayed cost sums
member execution usage, excluding the launching chat's unrelated usage. Write
scope scheduling is within one team, not a cross-team workspace lock.

## Persistence and Recovery

`agent-teams.db` stores current teams, tool/RPC deduplication results and compressed
historical snapshots. Task changes, inbox writes and their history frame commit
together. Runtime turns and conversation data remain in `wuming.db` and Pi's
existing session storage.

A delivery marker is checked against durable orchestrator operations, not only
the RPC idempotency cache or compactable transcript. A crash after accepting a
turn but before acknowledging the inbox does not append the same delivery again.
This does not promise exactly-once external tool side effects: existing approval,
operation recovery and tool idempotency rules still apply.

Stopping persists a terminal state first, cancels pending mail and aborts member
turns. Late model actions are rejected. Startup fences stopped-team operations
before resuming the global queue. Archiving the launching chat does not stop the
team. Dedicated member execution records cannot be archived through chat RPCs.
Failed/interrupted active work remains visible rather than being labelled complete.

On startup, legacy chat-owned teams receive dedicated lead contexts. The team ID,
tasks, member sessions, mail and historical revisions remain intact. A running
team's replacement lead receives a continuation message and the existing shared
board, not a fresh duplicate assignment. The old lead transcript stays in the
original chat. Migration is durable and repeatable; completed/stopped teams are
not reactivated. Optional protocol ownership fields allow reading old history.

## Workbench

The workbench uses workspace-authorized `team.list` and Team-ID-addressed
`team.get/message/retry/stop` RPCs, even when no chat is selected. Switching chats within the project
does not replace the team with a blank creation form. Historical records remain
visible. The selected team persists per project across reloads. Legacy lead-session
RPC addressing is still accepted for compatibility, but the current UI never uses
it. The workbench displays real member sessions, the shared task board, dependency
lanes, task results, sender/recipient messages and delivery status. User messages
can target one member or all members. Conversation navigation opens the member's
normal conversation, including approval controls. Failed members have a retry
action; the team can be stopped directly from its independent workbench. Selecting
a member shows its role, state, tokens, cost, assigned tasks and filtered messages.
Template-backed members also show their frozen template revision, model, effort
and domain-tool policy. Settings > Agents manages the reusable definitions without
creating a team or binding them to a conversation.

The history slider, previous/next controls and 0.5x/1x/2x/4x playback read stored
revisions and are read-only. Playback uses a fixed 720 ms per revision at 1x, not
wall-clock timing. Refreshing the page
or restarting the gateway does not erase team history. Live snapshots are polled
over authenticated Gateway WebSocket RPC once per second. Viewer accounts may
read snapshots/history but cannot start, message, retry or stop teams.

## Upstream Reference

The behavior is adapted from NanmiCoder/cc-haha at commit
`f2bfaab50f3be908f548245a74fdaa3ca2c71a95` (fetched September 17, 2026), especially `inProcessRunner.ts`,
`tasks.ts`, `teammateMailbox.ts`, `TeamCreateTool`, `TaskUpdateTool`,
`SendMessageTool`, and `teamService.ts`. The first-assignment gate, continuous
member lifecycle, peer inbox semantics and lead acceptance informed this
implementation. Bun/Claude globals and filesystem locks were not copied into
the Pi/SQLite runtime.

Five upstream avatar PNGs are reused under MIT. The upstream license is preserved
in `apps/web/public/third-party/cc-haha-LICENSE.txt` and shipped in the built client.
The local implementation is a behavior-level adaptation, not a claim of full
protocol or pixel-for-pixel parity. Upstream permission negotiation, independent
member shutdown handshakes and full archive management are not replicated here.
See `agent-teams-upstream-analysis.md` for the source map and explicit differences.

## Verification

```sh
npm run build
npx vitest run apps/gateway/test/agent-teams.test.ts apps/gateway/test/agency.test.ts apps/gateway/test/tools.test.ts
npm run test --workspace @wuming/web
npx playwright test e2e/persistent-agent-teams.spec.ts e2e/agent-teams.spec.ts
```

Tests use isolated databases and scripted/Demo runtimes, with no paid provider
calls. Backend tests exercise actual model-facing tools, concurrent member turns,
peer messaging, member reuse, dependency/scope gating, sender authorization,
deduplication, failure/retry, stopping, recovery and lead acceptance. Browser
tests cover team commands, persistent history, recorded scripted team output,
desktop/mobile layout, and legacy subagent/goal workflows. The scripted fixture
is explicitly labelled as test data and is not used by the production runtime.
