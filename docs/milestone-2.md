# Milestone 2: Durable Background Goals

## Outcome

A user can create a goal from a primary session, start it explicitly, leave the
Goals view, and later recover its authoritative status and result. Goal runs use
independent child sessions so they can execute, request approval, and be
cancelled without blocking the parent conversation.

## First vertical slice

- Goals are durable records scoped to one primary session.
- A new goal starts in `pending` and performs no model work until started.
- Starting a goal creates exactly one durable child session and queued turn.
- Status, approvals, usage, errors, and results are projected from the child
  session and its durable operation instead of copied into a second state log.
- Pending and active goals can be cancelled.
- Gateway restart recovery reuses the existing queued-operation and child-result
  reconciliation paths.
- The Web Goals workbench supports create, start, inspect, approve, cancel, and
  refresh workflows on desktop and mobile.

## Acceptance criteria

- Retrying `goal.create`, `goal.start`, or `goal.cancel` with the same
  idempotency key does not duplicate state or model work.
- A goal cannot be started twice or after cancellation.
- Goal records and their run association survive process restart.
- Completed, failed, and cancelled runs remain queryable with bounded results.
- The parent session receives the child result and usage exactly once.
- An archived or child session cannot create a goal.

## Deliberately deferred

- Multi-step goal plans and checkpoints.
- Periodic, scheduled, and externally triggered jobs.
- Automatic review loops and success-criteria evaluation.
- Goal retries that intentionally create a new run.
- Nested subagents and multi-agent coordination graphs.
