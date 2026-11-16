# Agent Verification Workflow

Wuming's default coding-agent instructions treat implementation and verification
as one task. This is a behavior policy, not a guarantee of model compliance.

## Required Workflow

1. Inspect the relevant code and existing tests; identify a focused acceptance check.
2. Implement the change without disturbing unrelated user edits.
3. Review the diff for correctness, regressions, error paths, and unintended changes.
4. Follow explicit repository checks and select tests for the affected behavior. For executable logic, run relevant tests and an applicable typecheck or build; do not run both for equivalent evidence. Add a regression test only when existing coverage does not protect the behavior. Prose and formatting changes normally need only diff or formatting review.
5. Use a browser for changed rendering or interactions with missing coverage or a concrete browser-specific concern. Nonvisual frontend logic does not automatically require one. Default to desktop (1440x900); add mobile only when the task or affected product behavior requires it. Reuse valid automated interaction evidence instead of replaying it manually.
6. For visual changes, inspect the affected rendered images for clipping, overlap, text fit, scrolling, missing assets, and blank or misframed canvas/3D content. For a known interaction workflow, default to one supported batch with an explicit result wait and final evidence. Fix relevant defects and rerun only invalidated checks, including new screenshots after relevant visual edits.
7. Finish immediately when required checks pass and no relevant concern remains. Report the checked behavior and material gaps concisely, retaining final screenshots and test reports. Do not expand into another review, browser route or full suite merely for reassurance.

Reuse healthy matching previews and passing evidence while relevant source, tests,
dependencies, configuration and environment remain unchanged. An unrelated prose
edit or a commit does not require repeating successful checks. Unknown impact,
authentication, permissions, migrations, installers, updates and shared dependencies
require broader risk-based checks. A selection with zero tests is not a pass.

Routine browser verification targets about 60 seconds. After about 90 seconds,
stop adding optional checks; report pending required checks as unverified. These
are planning limits, not an automatic timeout or permission to ignore regressions.
See [verification efficiency](verification-efficiency.md) for tool budgets and scope.

Review-only requests produce severity-ordered findings with file/line references,
not unsolicited edits. Missing browser support, model image support, dependencies,
or a test runner must be reported rather than described as successful verification.

## Screenshot Delivery

`browser_screenshot` returns a PNG image content block directly to the runtime,
alongside a persisted artifact when artifact storage is available. Its tool
guidance and response explicitly distinguish capture from visual review. Saving
a path, obtaining a DOM snapshot, or calling the screenshot tool does not establish
that a model inspected the pixels or correctly evaluated the layout.

## Runtime Evidence Check

The orchestrator uses completed tool transcript entries from the current runtime
result, not only aggregated tool names. After a `write_file` or `edit` call, a
recognized check must occur after the final change to avoid a
`session.verification.missing` warning. Warnings remain durable session data;
they neither block completion nor launch an additional model turn. Their Run rail
display is still a separate, unimplemented proposal.

Recognized evidence includes successful browser inspection/actions/screenshots/
diagnostics and common build/test/lint/typecheck commands through `exec` or its
`shell` alias. Tool errors, incomplete calls, and the sandbox's nonzero/terminated
exit-code output marker do not qualify. Starting a preview server, reading its
status, opening a browser page, or running arbitrary commands does not qualify.

This is a conservative heuristic for missing evidence, not a test-result parser
or a quality score. Custom scripts and unusual command wrappers may produce a
warning despite legitimate verification. Changes made through arbitrary shell
commands are not yet classified. A recognized browser call does not prove that
all visual checks ran; in particular, screenshot review remains model behavior
guided by the system prompt, not a programmatically proven fact.

## Activation And Tests

The policy is built by `packages/pi-adapter/src/system-prompt.ts` and included in
new runtime sessions using the default Wuming system prompt. Custom deployments
that replace that prompt must opt into equivalent guidance. Restart the gateway
and create a new conversation to avoid using an already cached runtime prompt;
do not interrupt active user work solely to load the change.

Regression coverage includes prompt instructions, PNG image delivery, stale checks
before the final edit, failed checks, and false verification from preview startup.
These tests validate implementation contracts, not real-provider adherence. A
real-model acceptance sample should distinguish prose, nonvisual logic, local style,
interaction and high-risk changes. Check the trace for appropriately selected
checks, batching of known workflows, necessary visual inspection, repairs and an
honest final report. Include both viewports only in a sample that requires them.

Completed runtime logs now include numeric browser/preview counters under
`verification`, alongside existing request and tool timing. They describe observed
tool families, not verified correctness or a precise verification phase; see
[observability](observability.md). No new model call, completion-blocking hook,
database schema or cross-turn verification cache is introduced.
