# Skill Management

## Available Workflows

The gateway ships original Wuming skill packages in
`apps/gateway/builtin-skills`: code-change, code-review, debug, research, run-app,
verify-app, skill-authoring and team. The team skill is for explicitly requested
persistent Agent Teams, not ordinary chats or questions about the feature.
They are available in every workspace, including
empty workspaces. These are adaptations of public workflow patterns, not copies
of hidden vendor prompts. See `skill-system-research.md` for evidence and goals.

Open the Skills workbench and choose its management icon. The dialog lists
system and user skills with enabled state and version. It supports inspection,
installation, toggling and confirmed user-skill removal. Disabled skills can be
previewed there but cannot be selected or loaded for execution.

## Local Ownership

Builtin skills are packaged with Wuming and are available wherever the Gateway
runs. User-created or user-installed skills are different: they are owned by the
workspace on the user's machine and are stored under `.wuming/skills` with
metadata in `.wuming/skills.json`. They are not uploaded to a Wuming service and
are not global account data.

User skill discovery and management are enabled only when the Gateway is running
as `local_device`. Server mode exposes bundled skills, but it does not discover
workspace user skills, install packages, toggle them, uninstall them, or expose
model-facing management tools. A user can still ask the agent to install or
disable a skill in chat, but the resulting `skill_install`, `skill_set_enabled`,
or `skill_uninstall` tool call runs on the user's local device host after an
explicit approval.

## Installing a Package

### Selecting From the Composer

- Type `/` to browse commands and skills together; type a name or description
  fragment to narrow the list. `/skills` still opens the Skills workbench.
- Type `$` at the beginning of a word to search only skills, including inside
  an existing draft. Names/IDs rank before description matches.
- Ctrl+K (Cmd+K on macOS) also searches skills through the command palette.
- Use arrow keys to move, Enter/Tab to select, and Escape to dismiss. Selection
  preserves the rest of the draft and does not send a turn. The selected badge
  can be removed with its close button; sending carries the explicit skill ID.
- Only enabled skills are listed. Manual-only skills are explicitly selectable
  and labeled accordingly. Source is System or Workspace, not an inferred
  global personal scope. Oversized skills retain the existing execution guard.

### Package Directory

Place a package inside the authorized workspace, for example:

```text
packages/my-skill/
  SKILL.md
  references/  (optional)
  scripts/     (optional; never run during installation)
  assets/      (optional)
```

Enter `packages/my-skill` in the install form. The skill ID defaults to the
directory name or can be supplied explicitly. Successful installation copies a
validated snapshot into `.wuming/skills/<id>`; the source is not modified.
SKILL.md must be UTF-8 with YAML metadata and nonempty instructions/description.
The current form installs version 1.0.0; RPC callers can supply a version.

No remote repository download or ZIP-upload installer is implemented yet.
Absolute host paths and relative paths escaping the workspace are rejected by
the installation RPC. Local API installation still accepts an explicitly chosen
directory, but is not the remote interface.

## Sources and State

New installs never overwrite an existing skill or collide with a builtin ID.
Manually placed workspace skills remain compatible with the existing catalog;
when such a file already has a builtin ID, the workspace version wins and is
identified as a user skill. Removing it reveals the unchanged builtin again.
Builtin files cannot be uninstalled through the manager.

`.wuming/skills.json` stores version/install metadata and enabled-state overrides.
Disabled entries are excluded from `skill.list`, automatic candidate discovery
and runtime `get`, not merely hidden by the UI. A separate preview path does not
activate the skill. Management mutations clear the browser's prior selection.
Enabling/disabling applies to subsequent resolution, not instructions already
read into a running model conversation.

## RPC

- `skill.installed.list`: all discovered skills, including disabled entries.
- `skill.preview`: read content without enabling or selecting it.
- `skill.install`: workspace-relative sourcePath, optional skillId and version.
- `skill.set_enabled`: skillId and boolean enabled.
- `skill.uninstall`: user skillId only.
- Existing `skill.list`/`skill.get`: enabled execution catalog.

The Pi runtime also exposes local-device management tools with the same mutation
semantics: `skill_install`, `skill_set_enabled`, and `skill_uninstall`. These
tools are absent in server mode and request `skill.manage` approval before any
workspace state is changed.

All commands require workspace access. Viewers may list/preview but cannot
install, toggle or uninstall. Installation validates all package entries before
publication: regular files only, no links/junctions, bounded paths, depth, entry
count and bytes. Limits are 200 KiB for SKILL.md, 2 MiB per supporting file,
8 MiB total, 256 package entries and 12 directory levels. Installation refuses
to exceed 100 entries in the workspace skill directory, matching discovery limits.

## Failure Handling

Mutations acquire `.wuming/skills.lock` and atomically replace state. An existing
lock produces a conflict rather than starting concurrent mutations. A lock left
by a crashed process requires operator inspection; it is not automatically stolen.
Malformed state fails closed and is never silently reset.

Packages are validated and staged before publication. A failed publish restores
prior metadata; failed uninstall persistence restores the original directory.
These rollback cases have fault-injection tests. Hard process termination and
hostile concurrent filesystem mutation are not claimed to be fully transactional:
operators should inspect residual `.skill-stage-*` directories after a crash.
Do not manually remove recovery data without checking its ownership and contents.

## Discovery and Invocation

The gateway disables legacy keyword auto-routing by default. The model sees
bounded descriptions, not all instruction bodies. `skill_list` browses summaries;
`skill_load` reads instructions or a supporting UTF-8 file in references/,
scripts/ or assets/. Reading scripts never executes them. Supporting reads are
limited to 64 KiB; instruction loading refuses truncation or over 64,000 chars.

Both `disable-model-invocation: true` in SKILL.md and
`policy.allow_implicit_invocation: false` in agents/openai.yaml mean manual-only.
A false policy wins if both formats are supplied. These skills remain explicitly
selectable but are absent from automatic discovery and rejected by skill_load.
The management dialog labels them as manual invocation. This is a portable
subset, not full Claude/Codex runtime compatibility: foreign tool names, hooks,
permission grants and fork-execution semantics are not added by installation.
Ordinary filesystem reads do not count as activation.

Successful loads carry SHA-256 and invocation mode in tool details, and
ID/resource/digest in the tool transcript. Turn usage records up to 128 distinct
skill IDs; explicit user selections retain the existing eight-skill limit.
Explicit instruction context is rebuilt on each fresh turn. Earlier tool
results can remain in conversation history.

Runtime skill observations are stored separately from the user's explicit
selection. Retries do not promote automatically loaded skills into explicit
inputs or change the original capability/context plan. Turn attribution merges
up to 128 observed IDs across attempts. Returned runtime failures and retry
results now retain their tool transcript items, including loaded-skill digests
and recovery observations, instead of replacing them with only an error notice.
An abort/timeout that yields no RuntimeTurnResult can still lack partial items.

The gateway now enables protectSkillSources on its sandbox tools. Reading or
editing SKILL.md requires explicit human approval, including under on_risk;
never/on_failure sessions refuse these calls before filesystem IO. This covers
enabled, disabled, manual-only and uninstalled source packages alike, without
trusting a model-supplied declaration of intent. Approved reads retain the
source-data marker and never count as activation. Human management preview is
unchanged. To inspect/edit source with the agent, use always/on_risk and approve
the specific operation. Loading an enabled skill remains available normally.

Search content and context lines from SKILL.md are withheld before inline,
streamed or artifact output; path/count discovery stays available. These are
dedicated read/search/edit tool boundaries, not general filesystem isolation:
arbitrary exec, external MCP tools, renamed copies, supporting files and earlier
conversation contents are not covered by this guard. Do not present it as a
general prompt-injection sandbox. Loader disabled/manual-only checks remain
independent, and approval to inspect does not enable a skill.

The load tool also carries bounded eligible summaries in its provider-visible
description. That session snapshot can become stale after management changes;
skill_list and skill_load recheck live policy. Selection remains model-driven,
not keyword-triggered, and incorrect or unnecessary selection is still possible.

Assembled context is supplied through Pi's before_agent_start hook. Assigning
agent.state.systemPrompt alone is insufficient because Pi resets it during
preflight. Provider-wire tests check the actual request and next-turn cleanup.

## Tool Recovery

The session monitor annotates observed failures with diagnostic guidance. After
two identical observed failures, unchanged execution is blocked until a new
turn or a successful state-changing tool provides new evidence. Discovery alone
does not clear the guard. Changed input/tool success is an observation, not
proof that the original task is solved. Permission/approval/cancellation errors
are preserved exactly. The monitor never executes an alternative or retries
on its own; the model must choose and verify an authorized next action.

## Project Recipes

run-app and verify-app look for project-scoped recipes in the enabled catalog.
skill-authoring includes an on-demand references/project-launch.md guide for
recording tested setup, execution location, readiness and smoke evidence. Normal
startup does not silently create a skill or commit files. Only demonstrated
incorrect/missing steps or explicit requests justify updating a saved recipe.

## Verification and Remaining Work

Unit/integration coverage includes disabled runtime loads, restart persistence,
builtin protection, collision preservation, unsafe IDs, links, corrupt state,
held locks, failed publication, failed uninstall and authenticated RPC boundaries.
Browser tests cover installation through removal at 1365px and 390px, stale
selection clearing, disabled preview and escaping-source rejection.

Local tests also cover discovery, invocation policy, supporting resources,
failure feedback and real SDK/provider-wire transport. On 2026-09-06,
`npm run check`, the full `npm run test` suite (including 172 gateway and four
provider-wire tests), and nine skill Playwright tests passed. Browser coverage
includes imported manual-only policy remaining explicitly selectable.

Remote-model acceptance is NOT complete. See skill-evaluation-status.md for
retained results and outstanding gates. Skill text and passing transport tests
do not guarantee model compliance or establish parity with other products.
