# Goal plan verification

Verified on 2026-09-05 against the current working tree. This record covers the
local durable-plan increment, not completion of the wider production roadmap.

## Gates

- `npm run check`: 12 workspaces, including test sources; light 76/76 and
  dark 71/71 contrast pairs passed.
- `npm test`: 472 tests passed, including 79 orchestrator tests.
- `npm run test:e2e`: production build and 48 browser tests passed.

## Evidence map

| Requirement                            | Evidence                                                                                                     |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Dependency ordering and parallel roots | Orchestrator barrier-controlled runtime tests, including out-of-order plan definitions                       |
| Fail-fast and independent continuation | Active sibling cancellation and downstream skip/continue tests                                               |
| Review/retry preserves prerequisites   | Two-round review test checks dependency evidence in each prompt and final downstream result                  |
| Durable attachment and cancellation    | Real SQLite close/reopen tests at committed intermediate states                                              |
| Corrupt graphs fail before execution   | Dependency-cycle injection in Goal, automation and run-spec storage                                          |
| Child ownership integrity              | Missing, duplicate, swapped and cross-session child reference injection                                      |
| Consistent plan projections            | Independent connection commits between parent and child reads; savepoint snapshot keeps a consistent version |
| Bounded dependency coverage            | Nineteen long-ID prerequisites with long results remain represented in execution, review and retry prompts   |
| Driver failure cleanup                 | Publication-error injection cancels a blocked sibling while preserving the originating error                 |
| Budget reservation integrity           | Shared-session allocation tests and independent-connection competition before transactional recheck          |
| Approval persistence and resumption    | Browser tests for allow/deny after page reload and abrupt gateway process restart                            |
| Goal and automation controls           | Browser creation, triggering, persistence, step navigation and review-evidence assertions                    |
| Responsive plan views                  | Desktop/mobile screenshots and viewport overflow assertions                                                  |

Test sources: `packages/orchestrator/test/orchestrator.test.ts`,
`e2e/goal-plan.spec.ts` and `e2e/automation.spec.ts`. Other suite tests
provide regression coverage for existing tools, capabilities, memory, evaluation,
approvals, sessions and UI behavior.

## Boundaries

- Browser tests use the demo runtime and real local gateway/SQLite/approval
  components. They do not establish real-model task quality.
- Two database connections cover a deterministic reservation race; full
  multi-process worker deployment is not proven by that test.
- Steps share the workspace. Dependencies must serialize conflicting file edits.
- Reservation accounting covers plan steps. It is not a provider-side spending
  cap or a complete quota system for all independent session activity.
- The scheduler now refills available slots after individual branches settle.
  A controlled runtime test makes a slow root wait for the fast root's descendant
  to start, proving that unrelated roots do not impose a whole-batch barrier.
  Twenty-step pipelines at concurrency 1, 2, and 4 check dependency order,
  exactly-once step entry, peak concurrency, usage totals, and zero active work
  at completion.
- Real Docker integration and public multi-tenant deployment remain separate
  verification requirements in the implementation roadmap.
