# Agent Teams: Upstream Analysis and Port

Source: `NanmiCoder/cc-haha`, fetched September 17, 2026. Inspected revision:
`f2bfaab50f3be908f548245a74fdaa3ca2c71a95`. The existing local reference checkout
was `0676c194e84b2da77c94d3992eadbf6e5eb9d7cb`; the inspected TeamCreate,
team command, service and workbench paths had no diff between those revisions.

## What the Source Actually Does

This is a persistent multi-agent runtime plus an observation workbench, not a
conversation visualization and not a series of one-shot subagent tool calls.

| Layer                    | Upstream source                                                                | Important behavior                                                                                                                                                        |
| ------------------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Explicit launch          | `src/commands/team.ts`                                                         | `/team <goal>` is a builtin prompt command, enabled by the swarm feature gate. No goal means ask for an objective, not create an empty team.                              |
| Identity and generation  | `src/tools/TeamCreateTool/TeamCreateTool.ts`                                   | Reserve a team name under the task-list lifecycle lock; persist a config with lead identity, leadSessionId, members, model and cwd; create/reset its shared task list.    |
| Persistent member loop   | `src/utils/swarm/inProcessRunner.ts`                                           | Run a retained agent, send idle notifications, wait for mail or work, and resume the same member. First work needs explicit assignment before automatic follow-up claims. |
| Shared tasks             | `src/utils/tasks.ts`, `src/tools/TaskUpdateTool/TaskUpdateTool.ts`             | Durable task state, owners, dependencies and coordinated task claims.                                                                                                     |
| Peer communication       | `src/utils/teammateMailbox.ts`, `src/tools/SendMessageTool/SendMessageTool.ts` | Real recipient mailboxes, not normal assistant text. Direct/broadcast routing plus structured shutdown/plan-approval protocols.                                           |
| Observation and recovery | `src/server/services/teamService.ts`, `src/server/services/teamWatcher.ts`     | Read team/task/mailbox/transcript data and expose workbench state, lifecycle identity and historical evidence.                                                            |
| Workbench                | `desktop/src/components/agentTeams/AgentTeamsWorkbench.tsx`                    | Member/task canvas, communication, history frames, playback and live mode.                                                                                                |
| Member inspection        | `desktop/src/components/agentTeams/AgentTeamsMemberInspector.tsx`              | Per-member work/task history and communication, not just an avatar and final string.                                                                                      |
| Client state             | `desktop/src/stores/teamStore.ts`                                              | Retain timelines and reject stale updates across team lifecycles.                                                                                                         |

Important distinction: upstream still records `leadSessionId`, sets the leader's
team context, restricts a leader to one active team and registers session cleanup.
It is inaccurate to claim its implementation has zero session coupling. The
requested product boundary here is deliberately stricter: the chat launches a
team, but owns neither its runtime nor its lifetime.

## Local Execution Path

1. A user selects the builtin `team` skill and submits a task, or sends `/team <goal>`.
2. A durable host launch action calls the existing team service directly, without
   depending on a source-model decision. Natural-language requests without this
   explicit UI/command invocation still use the model's `TeamCreate` tool.
3. `AgentTeamService.start` deduplicates the launch, copies the workspace/model/
   sandbox/approval/budget configuration into a new private lead execution context,
   and persists an independent team plus the initial pending message.
4. The source chat persists a `team_start` receipt with the actual team ID and an
   Open team action. It never becomes a member. Context and attachment references
   are copied into the lead inbox; an operation ID deduplicates repeated launches.
5. The scheduler delivers the objective to the lead; team policy tells that lead
   to use Agent, TaskCreate/Update and SendMessage to delegate and integrate work.
6. Each member runs serially; distinct members can run concurrently. Idle members
   have no model polling loop. Durable mail or dependency-ready assignments wake them.
7. The lead verifies outputs and calls TeamFinish, or the user stops the team in
   the workbench. Neither action requires opening or selecting the launch chat.

## Storage and Authorization

- `agent-teams.db`: independent team identity, workspaceId, sourceSessionId for
  provenance only, dedicated lead sessionId, board, inbox, deduplication and history.
- `wuming.db`: existing execution contexts, durable operations, approvals and usage.
- Team-ID RPCs authorize against the team's workspace, including historical reads.
  A sourceSessionId is not a member credential. Tools derive identity from the
  actual executing session and reject impersonation.
- One chat may launch multiple teams. Repeated delivery of the same launch ID
  returns the existing team. Distinct launch calls are distinct resources.
- Old chat-owned records migrate once before queued operations resume. Historical
  snapshots remain immutable and the old transcript remains available.

## Ported Surface and Deliberate Differences

The local implementation includes retained member sessions, concurrent execution,
first-assignment gating, task dependencies, declared write-scope serialization,
peer/broadcast mailboxes, failure/retry, explicit acceptance, stop/restart fencing,
project-wide selection, member inspection, dependency lanes, live communication
and stored-revision playback. The previous subagent/goal UI remains labelled as
Subtasks, not as the persistent runtime.

Settings > Agents additionally provides reusable user/project definitions and
builtin overrides. Membership is still assembled dynamically through Agent;
templates are not a fixed roster. Member configuration is frozen at creation and
the tool policy filters actual Pi registrations. See `agent-templates.md` for
precedence, permissions, runtime behavior and the upstream file-format differences.

This is a behavior-level port to Pi/Node/SQLite, not a drop-in copy of Bun/Claude
globals or an exact pixel clone. The following upstream surfaces remain different:

- In-process retained sessions only; no tmux/iTerm/bridge/UDS backend matrix.
- Existing Wuming approval controls instead of peer permission/plan negotiation.
- Explicit whole-team stop instead of individual negotiated shutdown handshakes.
- Retained historical records instead of the upstream TeamDelete/archive API.
- Fixed-rate revision replay rather than upstream wall-clock interval playback.
- No shared atomic spending cap or filesystem isolation; write-scope arbitration
  is within one team, not across independent teams using the same directory.

The five upstream avatar PNGs retain the MIT notice in
`apps/web/public/third-party/cc-haha-LICENSE.txt`. No upstream runtime dependency
or copied global configuration is required.

## Regression Evidence

`apps/gateway/test/agent-teams.test.ts` covers launch isolation, same-chat multiple
teams, launch replay, archived source chats, migration, private member identity,
workspace/viewer authorization, shared claims, concurrent turns, durable messaging,
failure/retry, terminal fencing and acceptance using real tools with a scripted runtime.

`e2e/persistent-agent-teams.spec.ts` covers source-independent project selection,
archived launch chats, reload/restart, history, member details, playback, visual
assets, mobile layout and real fixture-generated records. No paid model is used;
Demo mode is not evidence of autonomous model planning quality.
