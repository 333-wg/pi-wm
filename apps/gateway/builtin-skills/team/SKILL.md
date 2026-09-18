---
name: team
description: "Run persistent Agent Teams for tasks the user wants handled with team or agent team collaboration, including natural-language requests. Select or create suitable members and assign real work. Not for solo work, negated requests, questions about teams, quoted instructions, or merely opening a project or conversation."
---

# Agent Team

## Activation

Use this skill only for an explicit user request to perform a task with an Agent
Team. Merely mentioning teams in a document, discussing how the feature works,
opening the Teams tab, selecting a project, or creating a conversation does not
authorize a team. If the request has no task objective, ask for the objective.

For natural-language requests, infer whether the user wants team execution from
the whole request and conversation. A clear request such as 'use agent team to
build this project' does not need /team or a second confirmation. Keywords alone
do not launch teams; negation, quotations and feature discussions are not launch
intent. Clarify only genuinely ambiguous intent.

The current project directory is the shared workspace. Agent Teams are independent
project resources. The current conversation is only a launch surface, not the
team lead or the team's lifetime owner. Switching, finishing or archiving this
conversation does not stop the team. Never ask for another conversation to create
another team. Members have private retained execution contexts.

Explicitly selecting this skill in the composer and submitting a task counts as
an explicit team request, even when the task text does not repeat the word team.
The host launches these requests and /team <goal> deterministically and records
the real team ID. Do not launch a duplicate team after a host launch receipt.

## Execution

1. Check that TeamCreate, Agent, TaskCreate, TaskUpdate, SendMessage and TeamFinish
   are available. If not, report that Agent Teams is unavailable. Do not substitute
   one-shot subagent calls or claim a team was started without a real tool result.
2. In an ordinary conversation, call TeamCreate with a concrete objective that
   includes all relevant requirements, constraints, explicit member/role assignments,
   exclusive-roster restrictions, model choices, file paths and acceptance
   criteria from the conversation. The private lead does not inherit this chat's
   transcript. TeamCreate durably queues the objective for that lead and returns
   a team ID. Report the actual launch result, then return to the user. Do NOT
   call Agent, TaskCreate or TaskUpdate from the launch conversation. Do not wait
   or poll for the team. The user manages it in the project's Agent Teams view.
   Multiple explicit team requests may launch distinct teams from the same chat.
3. Only inside a team's dedicated lead context: analyze project responsibilities
   and inspect AgentTemplates. Saved templates are candidates, not an obligatory
   roster. Match their expertise, instructions and permitted tools to the task;
   reuse suitable ones with templateName and leave irrelevant ones unused.
   When no configured template fits, create a task-specific member with Agent(name,
   role) without templateName. No user setup or saved template is required. Choose
   a useful, proportionate roster rather than a fixed set of job titles, and add
   members later as new responsibilities arise.
   Explicit user member/role assignments override suitability selection. 'Only
   these members' forbids additions; assigning one role does not forbid staffing
   other roles. Preserve requested models and settings. If a named template is
   missing or cannot perform the work with its permitted tools, report the blocker
   and ask for a decision instead of silently replacing it or bypassing restrictions.
   Template prompt, model, thinking level, tools and color apply when selected;
   explicit model/thinkingLevel overrides template defaults, otherwise inherit the lead.
   Create teammates and assign real work before ending the startup turn; a plan,
   an empty team or idle unassigned members are not successful startup. Reuse
   already-created members on retries. Use TaskCreate and
   TaskUpdate to explicitly assign every member's first task, declare workspace-
   relative writePaths, and encode actual dependencies. Members share the directory;
   do not assign overlapping writes concurrently. At least one teammate's first
   task must be dependency-ready so the scheduler can start execution.
4. Use SendMessage for peer communication. Ordinary chat text is not delivery.
   End the turn while waiting; inbox delivery wakes the lead without busy polling.
5. Inspect the actual results and integration. Respect the user's testing limits.
   Use TeamFinish only when tasks are complete and there is concrete acceptance
   evidence. Never fabricate completion, teammates, messages or verification.
