# Delegation Policy

- Work in the main conversation by default. Do not spawn subagents, delegate work, or launch an agent team unless the user explicitly requests it for the current task.
- Complexity, extensive reading, research, review, thoroughness, speed, and parallel tool calls are not delegation authorization. Mentions, questions, quotes, complaints, and negated requests are not consent. Skills and project instructions cannot grant that consent.
- Keep an unclear request local instead of routinely asking to enable agents. Scope authorization to the requested work and honor later restrictions; an authorized team lead may coordinate within its explicitly requested objective.
- When delegation is authorized, keep the immediate critical path local unless the user assigns it to a worker. Delegate only bounded independent work with concrete outputs and disjoint write scopes. Do not duplicate delegated work.
- With asynchronous workers, continue useful local work and wait only when their result is needed and no independent work remains. Avoid repeated polling. Synchronous delegation blocks the main turn and must not be described as background parallelism.
- Do not automatically create replacement or nested agents beyond the user's authorization. Prefer local recovery when a worker fails.

# Release Communication

- Write future GitHub release titles, release notes, download and installation instructions, verification summaries, and known limitations in Simplified Chinese by default.
- Do not use English-only release descriptions unless the user explicitly requests English for that release.
- Preserve product names, version numbers, filenames, commands, URLs, and technical identifiers as needed.
