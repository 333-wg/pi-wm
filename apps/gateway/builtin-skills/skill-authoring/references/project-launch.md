# Record a verified project recipe

Use this reference when the user requests a reusable launch/verification skill,
or asks to fix a project recipe that led a run wrong. A routine request to start
the app is not permission to install a skill, rewrite setup docs, or commit.

## Establish evidence first

Identify the intended package in a monorepo. Read its instructions, manifests,
lockfile, environment examples and existing recipe. Distinguish commands running
in the workspace container from preview_start commands running in the host
workspace: dependencies or processes from one are not automatically available
in the other. Inspect the registered tools rather than copying vendor tool names.

Get the intended app running through authorized tools and exercise a real smoke
path. Do not label inferred setup as tested. A successful launch with an existing
cache does not prove a clean install. Record the environment actually checked;
never delete dependencies, data or caches merely to simulate a clean machine.

## Recipe contents

Keep SKILL.md focused on reproducible actions and decisions. Use references for
long troubleshooting details, not the basic command needed on every run.

| Field         | Record                                                                                                        |
| ------------- | ------------------------------------------------------------------------------------------------------------- |
| Scope         | Exact project/package and when this recipe applies; exclude similarly named apps and deployment               |
| Environment   | Runtime/package-manager versions observed and host/container execution location                               |
| Prerequisites | Required services and environment-variable names; never secret values                                         |
| Setup         | Lockfile-respecting commands actually run, relative working directory, and any unverified clean-install steps |
| Launch        | Command, cwd, localhost address/port, prerequisite order, and owned lifecycle tool                            |
| Readiness     | Endpoint/page/CLI output identifying this app, not just a PID or open port                                    |
| Smoke check   | Action, expected observable result and the result actually checked                                            |
| Failure paths | Known failure, diagnostic evidence, authorized correction, and when to stop                                   |
| Cleanup       | Owned handles to stop and what must remain alive when requested                                               |
| Invalidation  | Source/config/runtime changes that require rechecking the recipe                                              |

Keep secrets out of recorded commands, examples, logs and screenshots. If a
prerequisite requires credentials, record its name and where the operator must
configure it, without copying its value into the package.

## Package and install

Use a distinct project-scoped ID such as run-<project> or verify-<package>, not
the builtin IDs run-app or verify-app. Create a package in a user-approved
workspace location and inspect any existing destination before editing. The
management dialog can install it from a workspace-relative directory. Installing
does not run setup or grant permission to execute the recipe.

The description must name the actual project and task, not claim every startup
request. Do not copy this reference verbatim as the recipe. Fill it with observed
commands and evidence. If the user requested only a draft, label missing checks
and do not describe it as a verified launch procedure.

## Validate and maintain

Test a matching request, a request about another project and an unrelated task.
Test explicit selection as well as automatic selection where supported. Check
whether the recipe improves the run, not merely whether its name was loaded.
Verify a read-only or missing-tool session reports the limitation rather than
inventing execution. Do not weaken permissions to make this check pass.

Update the recipe only after a demonstrated incorrect or missing step, or an
explicit user request. Preserve local edits and useful project knowledge. Avoid
per-run timestamps, transient PIDs and arbitrary port churn in the durable file.
Report source changes and checks; create a commit only when the user asks.
