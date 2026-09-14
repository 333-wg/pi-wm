# Agent Verification Workflow

Wuming's default coding-agent instructions treat implementation and verification
as one task. This is a behavior policy, not a guarantee of model compliance.

## Required Workflow

1. Inspect the relevant code and existing tests; identify a focused acceptance check.
2. Implement the change without disturbing unrelated user edits.
3. Review the diff for correctness, regressions, error paths, and unintended changes.
4. Discover and run the project's own typecheck/build and affected tests. Add a regression test for a bug fix.
5. For visual work, open the actual page at desktop (1440x900) and mobile (390x844) sizes, exercise the affected states, inspect diagnostics, and capture screenshots.
6. Inspect the returned images for clipping, overlap, text fit, scrolling, missing assets, and blank or misframed canvas/3D content. Fix defects and rerun affected checks, including fresh screenshots after the last edit.
7. Report what changed, which checks actually ran, their results, and remaining gaps. Retain final screenshots and relevant test reports.

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
real-model acceptance run should request a small responsive UI change, then check
the tool trace for tests, both viewport screenshots, concrete visual observations,
repairs where needed, and an honest final report.
