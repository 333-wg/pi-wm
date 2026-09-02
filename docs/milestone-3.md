# Milestone 3: Bounded Goal Review Backend

## Outcome

Protocol clients can attach explicit success criteria to a durable Goal. The
orchestrator runs the Goal, asks an independent child session to review the
candidate result, and either accepts it or starts a corrected round with the
review feedback. Every transition is durable and the number of rounds is
strictly bounded.

## Backend vertical slice

- `goal.create` accepts optional `successCriteria` and `maxRounds` fields.
- Review-enabled Goals default to three rounds and allow at most five.
- Worker and reviewer runs use independent durable child sessions.
- A reviewer must return a JSON object with a `pass` or `fail` verdict and
  bounded feedback; malformed output fails closed.
- Failed verdict feedback is injected into the next worker round.
- Goal review phase, run associations, verdict history, and failure reason are
  stored in SQLite and validated when loaded.
- Creating a worker or reviewer session and moving the Goal pointer occur in
  one transaction, so a failed transition cannot leave an orphan child.
- Startup recovery resumes review-enabled Goals after queued session recovery.
- Approval completion can continue the Goal whose active run requested it.
- Usage aggregates all worker and reviewer sessions, while the final result is
  always the latest worker result rather than the reviewer JSON.
- Goals without success criteria retain the Milestone 2 single-run behavior.

## Acceptance criteria

- A failed review can create one corrected round and a later pass completes the
  Goal with the corrected worker result.
- Reaching `maxRounds` settles the Goal as failed with reviewer feedback.
- A completed worker awaiting review is reported as running, not completed.
- Recreating the orchestrator or reopening SQLite preserves review progress.
- Cancelling an active reviewed Goal remains idempotent while its driver is
  running.
- Budget exhaustion fails the review loop with a durable bounded reason.
- More than five rounds are rejected by the wire contract.

## Deliberately deferred

- Web controls for success criteria, maximum rounds, and review history.
- Manual pass/fail overrides and restarting a settled Goal.
- Separate worker and reviewer model selection.
- Scheduled or externally triggered Goal starts.
- Multi-step plans, checkpoints, and multi-agent coordination graphs.
