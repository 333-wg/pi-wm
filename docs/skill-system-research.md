# Skill System Research

Reviewed: 2026-09-06. This distinguishes public observations from Wuming design
decisions; it does not claim access to hidden vendor prompts.

## Sources

Fetched official pages over HTTP after web search returned no usable content:

- O1: https://developers.openai.com/codex/skills (returned canonical page:
  https://learn.chatgpt.com/docs/build-skills).
- A1: https://code.claude.com/docs/en/skills.md
- A2: https://code.claude.com/docs/en/how-claude-code-works.md
- L1: local Codex `.system/skill-creator/SKILL.md`.
- L2: local Codex `.system/skill-installer/SKILL.md`.

O1: Codex supports explicit and model-selected invocation. Descriptions precede
full instructions. Supporting files are optional. Invocation policy can disable
implicit use while keeping explicit use. Disabling need not delete files.
Local authoring and plugin distribution are distinct concerns.

A1: Claude Code also supports description-based and explicit selection. Bundled
skills are prompt workflows, unlike commands implemented as fixed program logic.
Examples include debug, code review, batch and doctor. Not every bundled skill
is automatically invoked. Run/verify workflows exercise the actual application;
launch recipes can be recorded. Sources have precedence; plugins use namespacing.

A2: The agent gathers context, acts and verifies. Tool results inform subsequent
decisions. Strategy changes belong to this feedback loop; installing a skill
file alone does not implement autonomous recovery.

L1: Include guidance that changes decisions, not generic prose. Match specificity
to risk, keep discovery precise and load conditional detail as needed.
L2: Installation refuses existing destinations. Download failure can lead to
another retrieval method. This is a concrete fallback, not a universal retry rule.

## Reusable Launch Recipes

A1 was fetched again on 2026-09-06 for the run/verify workflow. Its public
run-skill-generator documentation describes recording a proven project launch
as a project skill. It also recommends updating recorded recipes when a step
is wrong, rather than rewriting them after every run.

Wuming adapts this through run-app and verify-app discovering project-scoped
recipes, plus skill-authoring/references/project-launch.md loaded only for a
requested reusable recipe. The reference requires execution location, cwd,
prerequisites without secret values, readiness identity, a real smoke check,
failure handling, cleanup and invalidation conditions. Host preview tools and
container command tools are distinct in Wuming and must not be conflated.
Unlike the vendor example's commit step, Wuming commits only on user request.
Recording a recipe is not permission to execute it or install dependencies.

## Wuming Design Requirements

These are product decisions, not vendor implementation claims:

1. Ship system skills with the app, available in every workspace. Keep user
   installations separate; expose source, version, enabled and invocation policy.
2. Show conflicts explicitly. Do not silently overwrite builtin files.
3. Give the model bounded descriptions and a skill-load tool usable mid-task.
   Record skill ID, content digest and invocation mode in run trajectories.
4. Apply enabled-state and permission checks to both explicit and implicit use.
   Skill loading never grants tools, permissions or script execution.
5. Treat keyword overlap as optional discovery assistance, not semantic selection.
   Whole-string Chinese tokens are inadequate for conversational Chinese tasks.
6. Require explicit installation intent and workspace authorization. Do not
   accept unrestricted remote-client host paths. Validate metadata, size/count,
   relative paths, symlinks/junctions, special files and reserved device names.
7. Refuse collisions by default. Stage before publication; preserve old skills
   on failure. Serialize mutations and persist state atomically. Corrupt state
   is an error, not an empty catalog. Never execute package install scripts.
8. Distinguish provider retries, tool failures and incorrect application behavior.
   Record failure evidence and possible side effects before choosing a retry.
9. Bound transient retries. Change hypothesis/input/method for deterministic
   errors. Replan when attempts add no evidence; never bypass denied approval.
10. Record checks passed, failed, skipped and limitations. A build does not prove
    runtime behavior; a generic verifier cannot prove arbitrary task correctness.

## Adaptation Priorities

| Workflow           | Useful mechanism                       | Evidence required              |
| ------------------ | -------------------------------------- | ------------------------------ |
| debug              | Reproduce, classify, test hypotheses   | Original failure rechecked     |
| run-app            | Launch recipe and process lifecycle    | Readiness and working endpoint |
| verify-app         | Exercise changed behavior              | Runtime observations           |
| code-review        | Trace changed contracts and callers    | Location, trigger, impact      |
| research           | Primary sources, distinguish inference | Supported conclusions          |
| skill-authoring    | Precise triggers, conditional detail   | Positive/negative cases        |
| skill-install      | Validate, stage, publish               | Old files preserved on failure |
| document/pdf/sheet | Generate, render, inspect              | Actual artifact inspection     |

Adapt to available Wuming tools; do not copy foreign tool names or advertise
planned workflows as already shipped and tested.

## Baseline Audit (Before Management Integration)

The following findings describe the starting state. See `skill-management.md`
for the subsequently implemented catalog, safety, RPC and browser workflows.

- `apps/gateway/src/skills.ts`: workspace-only catalog; no enabled-state check.
- `apps/gateway/src/skill-manager.ts`: not connected to runtime; deletes the
  destination before copying, swallows corrupt state and lacks comprehensive
  package validation. Remediate before exposing it through RPC.
- `apps/gateway/src/skill-router.ts`: token overlap; recovery helper unused by loop.
- `packages/pi-adapter/src/pi-agent-runtime.ts`: reuse existing explicit skill
  resolution and digest-backed context fragments.
- Partial management protocol schemas do not prove working handlers.
- Existing workspace skill files are prototypes, not a global builtin catalog.

## Full-System Acceptance Gates

Management and provider-wire tests provide evidence for parts of these gates.
A two-case real-model smoke confirmed review loading and explicit use, but
semantic selection and recovery are not fully accepted. See
`skill-evaluation-status.md` for retained failures and the lifecycle repair.

1. Empty workspace sees builtins; disabled skills cannot load.
2. Authenticated RPC and UI support installation/list/inspect/toggle/uninstall,
   including error/loading states and stale selected-skill clearing.
3. Restart preserves state and source precedence.
4. Collision, traversal, symlink, corrupt-state and interrupted-install tests
   preserve files and cannot escape authorized storage.
5. Chinese/English positive and negative cases exercise real model skill loading.
6. Mid-turn failures produce observed strategy changes without permission bypass.
7. Verification captures evidence for the task and reports gaps.
8. Desktop/mobile inspection and end-to-end tests prove management changes affect
   both explicit and implicit execution.
