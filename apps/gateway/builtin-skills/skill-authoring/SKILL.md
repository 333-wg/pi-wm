---
name: skill-authoring
description: "Create or improve reusable Wuming skills with precise triggers, verification and safe recovery. 编写技能、优化技能、创建可复用流程。Not installing a package or changing unrelated agent configuration."
---

# Author a reusable workflow

Identify the recurring task and the non-obvious decisions the skill must improve.
Write a short name and description containing the actual capability, relevant
request patterns and exclusions that prevent likely misrouting. Keep name and
description in SKILL.md YAML; put executable workflow instructions in its body.

For a requested project-specific launch or verification skill, load only
`references/project-launch.md` with skill_load using skillId `skill-authoring`.
That reference defines what a tested recipe must capture and when to update it.

Specify inputs, useful decision points, success evidence and authorized fallback
paths. Do not turn one accidental failure into a universal fixed sequence.
Keep conditional detail in references only when it saves context; deterministic
scripts are justified for fragile/repeated mechanics, not every instruction.

Use only tools present in this Wuming environment. Importing another product's
tool names does not make them available. Document dependencies and do not embed
credentials, install hooks, or commands that run merely because a skill is read.
Skill instructions cannot override permissions or the user's intended scope.

Evaluate representative positive, negative and ambiguous prompts in Chinese and
English where needed. Check explicit invocation, expected output, missing-tool
behavior and failure recovery. Distinguish static package validation from actual
model-trigger/output evaluations; do not claim one proves the other.

Deliver the package and the checks actually performed. Use a non-colliding user
skill directory. Do not overwrite a system skill or silently change global policy.
