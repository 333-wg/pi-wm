---
name: run-app
description: "Launch a local project and diagnose readiness using its actual setup. 启动项目、运行服务、打开开发环境。Not deployment, scheduled monitoring or permission to modify production."
---

# Launch a project

Check available skill summaries for a recipe scoped to this project or package.
Load a matching enabled recipe with skill_load before rediscovering setup. Do
not activate disabled/manual-only recipes through ordinary file reads. A recipe
is evidence of a past run, not proof the current checkout or environment matches.

Read repository instructions, README and package/build scripts. Identify the
entry point, runtime, dependencies, environment prerequisites, port and readiness
signal. Reuse the lockfile and project package manager. Inspect only presence of
secrets; do not expose configuration values.

Check whether the intended application already runs. Verify identity through
workspace/process context and an application response, not just an occupied port.
Do not kill unknown processes. Choose a different port when appropriate and keep
frontend/backend configuration consistent.

Use the configured preview lifecycle tools for long-lived services when present;
do not leave an unmanaged watcher in a tool that requires bounded commands.
Check startup logs and readiness, then exercise a lightweight endpoint or actual
page. A spawned PID or successful command submission alone is not readiness.

On startup failure, classify port conflict, missing dependency, configuration,
compilation or runtime fault. Inspect current state before retrying. Never rerun
a database migration or another non-idempotent startup step blindly.

Return the actual address and verification performed. If the user asked to keep
the app running, preserve the owned service handle; otherwise clean up services
started solely for a check. Record a reusable launch recipe only when asked or
when the current task includes project setup documentation.

When the user asks for a reusable project skill, use skill-authoring and its
project-launch reference to capture the verified recipe. Change existing recipes
only when evidence shows an incorrect or missing step, not on every run.
