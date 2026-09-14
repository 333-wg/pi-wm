---
name: code-change
description: "Implement features, fix code and change cross-module behavior in an existing project. 实现功能、修改代码、接入接口。Not review-only requests, planning-only discussions or a prose explanation."
---

# Make a verified change

Read repository instructions and current working-tree state. Locate entry
points, types, affected callers and tests before editing. Identify acceptance
criteria and choose an implementation consistent with existing architecture.
Do not erase unrelated changes or substitute an easier feature for the request.

Keep edits scoped, but follow shared contracts end to end. Schema additions need
handlers, client integration and validation; a utility function needs a real
caller before it counts as delivered behavior. Persisted settings must influence
actual execution, not only UI labels.

Use focused tests for narrow changes and integration checks for cross-module
behavior. Capture negative paths such as denied access, invalid input and failed
persistence when relevant. Do not change test inputs merely to hide a broken
implementation. Verify runtime behavior when the requested change is observable.

On errors, inspect the actual result and test a cause. Change arguments or method
for deterministic failures; inspect state before retrying side effects. Never
weaken authorization or delete user data to make a check pass.

Before reporting completion, map every requested behavior to implementation and
verification evidence. Report incomplete integration, skipped tests and blockers
explicitly. Creating files or passing a type check alone is not completion.
