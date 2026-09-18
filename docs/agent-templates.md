# Agent Templates

Settings > Agents manages reusable team-member configurations. Templates are not
team members: the team lead still chooses the actual membership for each task.
Chat remains a launch entry point, not the owner of the team or its templates.

## Configuration

Create, edit, duplicate and delete user/project templates with a name, description,
system prompt, optional model and thinking effort, domain-tool policy and color.
Names are lowercase identifiers (letters, digits, `_`, `-`, starting with a letter).
The catalog includes `general-purpose`, `explore` and `reviewer` builtins. Builtin
definitions are immutable; their model/effort can be overridden by saving a
same-name user/project record. Duplicate a builtin to customize all of its fields.

Resolution follows the inspected upstream order: **user > project > builtin**.
The settings list marks shadowed definitions. Deleting an override reveals the
next definition. A project record is only visible within its authorized workspace.
User scope means all projects in this local installation, not a private record
per authenticated principal. Only owners/admins can change user records; workspace
writers can change project records; viewers can only read the catalog.

Templates use the existing `agent-teams.db` SQLite database, not upstream
`.claude/agents/*.md` files. There is no automatic import/export or external-file
watcher. Each scope allows at most 100 templates. Saves/deletes use revision checks
to reject stale edits. Refresh reloads the selected configuration after a conflict.

## Runtime

The lead uses `AgentTemplates` to inspect the catalog, then `Agent` with
`templateName`. It can also create a task-specific member without a template.
An explicit `model`/`thinkingLevel` on `Agent` overrides the template value;
otherwise the template value overrides the lead's value. The selected model must
be configured and authenticated. Effort is clamped to that model's capabilities.
Sandbox, approval policy and per-session budgets remain inherited from the lead.

The selected template and its revision, plus the actual model and effort, are
copied into the member record. Prompt and tool policy are read from this frozen
snapshot, including after restart. Editing or deleting a template affects future
members only. Member inspection shows the frozen configuration and actual model.

Domain-tool policies apply to the tools registered in the actual Pi session:

- `all`: all tools otherwise available to the member.
- `none`: no domain tools.
- `custom`: exact tool-name allowlist, including explicit MCP tool names.

`TaskList`, `TaskGet`, `TaskUpdate` and `SendMessage` remain available under every
policy so members can participate in the team. Restricted policies cannot enable
delegation or tool-configuration mutations to regain removed tools. Unknown names
grant nothing. Shell-pattern rules such as `Bash(git *)` are not supported.

This is a tool-registration policy, **not a process/filesystem security sandbox**.
Allowing `exec`, Python, or a similarly general-purpose MCP tool gives that tool's
existing capabilities; it does not create command-level isolation. Normal gateway
authorization, sandbox and approval checks still apply.

## Upstream Mapping

The source is the inspected cc-haha revision
`f2bfaab50f3be908f548245a74fdaa3ca2c71a95`. This ports its distinction between
reusable Agent definitions and dynamically assembled team members, along with
scope, model, effort, prompt, tool and color configuration. The builtin catalog is
a Wuming-specific subset, not every upstream builtin. Storage, RPCs, tool names
and runtime integration follow Wuming's existing Pi/SQLite implementation.

## Verification

```sh
npm run check
npx vitest run apps/gateway/test/agent-templates.test.ts apps/gateway/test/agent-teams.test.ts
npx playwright test e2e/agent-templates.spec.ts
```

Tests cover scope precedence/isolation, write permissions, stale revisions,
model/effort resolution, frozen configuration after deletion/restart and actual Pi
tool registration. Browser tests cover desktop/mobile creation, edits, copies,
deletion, builtin overrides and member inspection. No paid inference is performed.
