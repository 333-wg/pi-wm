# Milestone 1: Local Vertical Slice

## Outcome

A user can open a browser, choose an isolated workspace and configured model,
send a prompt, inspect streaming text/thinking/tool activity, approve a risky
operation, disconnect, reconnect, and recover the authoritative completed state.

## Repository shape

```text
apps/web                 React browser application
apps/gateway             HTTP/WebSocket API and composition root
packages/protocol        Shared executable wire contract (started)
packages/domain          Framework-independent state and policy
packages/orchestrator    Session actor, persistence, replay, snapshots
packages/pi-adapter      Pinned Pi integration and event normalization
packages/executor        Sandbox interface and local container implementation
```

The MVP may deploy gateway, orchestrator, adapter, and executor in one Node.js
process, but their interfaces must not rely on that deployment choice.

## Build order

1. Protocol validators, compatibility fixtures, and generated API documentation.
2. Domain reducer that materializes a session snapshot from durable events.
3. SQLite event store, idempotency store, snapshot store, and writer lease.
4. Fake Pi adapter for deterministic orchestrator and reconnect tests.
5. Real `AgentSessionRuntime` adapter with text streaming and usage.
6. Sandbox tool bridge for workspace files, isolated command/Python execution, and controlled web access.
7. Approval broker and immutable approval audit records.
8. WebSocket gateway with auth, attach/detach, replay, resync, and backpressure.
9. Browser transcript, composer, tool cards, approval dialog, and connection state.
10. End-to-end recovery tests with a killed browser and restarted gateway.

## Acceptance criteria

- Unknown protocol fields and unsupported versions are rejected.
- Retrying a prompt with the same idempotency key starts only one turn.
- A second writer cannot mutate an already leased session.
- A dropped progress message does not corrupt the final transcript.
- A revision gap triggers snapshot resynchronization.
- Browser disconnect does not lose or duplicate a settled tool result.
- Abort reaches a terminal state even when a provider ignores cancellation.
- Tool output is bounded and complete output is available as an artifact.
- Host paths and provider credentials never appear in browser messages.
- Workspace writes cannot escape the sandbox mount.
- Approval cannot exceed sandbox capability and cannot be settled twice.
- Session resume works after gateway restart.

## Deliberately deferred

- Multi-node scheduling and PostgreSQL.
- Shared organization workspaces and advanced RBAC.
- Persistent interactive terminals.
- Git worktree orchestration and pull request workflows.
- Plugins, MCP administration, skills marketplace, and subagents.
- Goals, review loops, scheduled/background automation, and mobile layouts.

These features are deferred because they consume the same session, capability,
and event contracts. They should be added only after those contracts survive the
vertical slice without special cases.
