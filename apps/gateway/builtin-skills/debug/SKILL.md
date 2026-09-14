---
name: debug
description: "Investigate an observed error or unexpected result, including a first failed file read, missing configuration, startup error, failed test or repeated tool failure. 排查读取失败、配置缺失、报错、测试失败。Use even when the user only wants a diagnosis without edits. Exclude general conceptual questions with no observed failure and unrelated new features."
---

# Evidence-led debugging

Find the expected behavior and actual mismatch. Read current logs, configuration,
entry points and tests before assuming a cause. Preserve unrelated edits. Check
only whether secrets are present; do not print credentials.

## Investigation record

For each meaningful attempt keep: observation, hypothesis, smallest experiment,
result, and what changes next. Reproduce non-destructively with the real working
directory and environment. A hypothesis must be falsifiable by the next check.

| Failure                          | Next action                                                          |
| -------------------------------- | -------------------------------------------------------------------- |
| Path or argument error           | Inspect actual directory/tool schema, then correct input             |
| Missing dependency/configuration | Read setup instructions; make only authorized changes                |
| Timeout                          | Inspect existing process/request state before replaying side effects |
| Deterministic assertion          | Trace contract and callers; test a different hypothesis              |
| Denied permission                | Respect boundary and identify required authorization                 |
| Unavailable tool                 | Use an available authorized equivalent or report limitation          |

Do not repeat an unchanged deterministic failure. Bound transient retries and
check that replay is safe. Replan when attempts add no evidence. Never recover
by deleting data, weakening permissions, removing tests or hardcoding answers.

## Verification

Make a focused fix for the demonstrated cause. Add a regression test where
practical and confirm it can detect the original failure. Re-run the original
reproduction and relevant caller checks. For runtime/UI errors, exercise actual
behavior; compilation is insufficient. Use only tools actually available.

Report supported cause, change, executed checks and uncertainty. A successful
edit is not proof of a fix. A blocker report names the missing capability/input
and the attempts already made.
