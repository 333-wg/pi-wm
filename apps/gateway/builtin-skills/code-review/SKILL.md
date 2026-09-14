---
name: code-review
description: "Review code, individual files/functions or diffs for concrete bugs, contract regressions, security failures and missing coverage. 代码审查、审查函数、检查变更、回归风险。Not an invitation to refactor or impose stylistic preferences."
---

# Review changed contracts

Honor the requested review scope. For a diff, identify its baseline and affected
files; for a named file or function, inspect that scope without inventing a diff
baseline. Read implementation, relevant
callers, schemas and tests. Trace user-visible behavior and data lifecycle, not
only changed lines. Respect existing uncommitted work.

Prioritize incorrect behavior, lost data, authorization bypass, compatibility
breakage, races and failed recovery. Check that tests exercise the changed
contract rather than echoing implementation details. Run focused non-destructive
checks when they can establish or disprove a suspected defect.

Each finding needs a file location, triggering condition, observable impact and
why existing code fails. Distinguish demonstrated defects from open questions.
Do not label style preferences as bugs or manufacture findings to fill a quota.
When context is missing, inspect callers or state the assumption explicitly.

Report actionable findings in severity order. If no issues are established, say
so and describe remaining verification gaps. Do not modify code unless the user
also requested fixes; a review request alone does not authorize a rewrite.
