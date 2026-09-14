---
name: verify-app
description: "Verify a changed application's real runtime behavior, interactions and negative paths. 验证实际功能、浏览器验收、交互回归。Use after behavior changes; not as a substitute for required tests."
---

# Verify observable behavior

Translate the requested change into observable acceptance criteria. Read affected
routes, callers and tests. Distinguish compilation, unit tests, integration checks
and real user behavior; none automatically proves the others.

Look for a matching project/package launch or verification recipe in available
skill summaries; load it with skill_load when applicable. Revalidate it against
the current source and environment rather than treating a recorded success as
current evidence. Use the recipe and available lifecycle tools. Confirm
the page/service belongs to this build before checking it. Exercise the primary
changed path, an appropriate negative path, and the affected adjacent workflow.
Avoid destructive checks or writes to production accounts.

For UI changes, inspect console/runtime errors, loading/error/empty states,
keyboard focus and narrow/wide layouts. Capture and inspect screenshots when
layout changed. Do not substitute a static screenshot for testing interactions.
For API or CLI changes, inspect status/exit code and response/output semantics.

Record evidence by criterion: action, observed result, pass/fail/blocked. If a
tool is unavailable, report the unverified criterion instead of fabricating it.
Failures should lead to a specific hypothesis and changed experiment, not to
weaker acceptance criteria. Recheck affected criteria after any fix.

Return a concise evidence summary and limitations. Do not claim all functionality
is correct based on one successful path. Clean up only resources owned by these
checks, unless the user requested that the application remain running.
