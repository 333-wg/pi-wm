# Capability Kernel

The capability kernel turns runtime tools, skills, MCP surfaces, prompt
fragments, hooks, memories, models, and executors into one versioned manifest
vocabulary. A scoped registry resolves those manifests into an immutable,
content-addressed `CapabilityPlan` for one operation.

The current integration records the plan on the durable operation before the
runtime may send a model request. Pi recomputes the plan immediately before
execution and rejects drift, so changed Skill content or tool schemas cannot be
used under an older recorded digest.

Important invariants:

- Resolution is deterministic for the same context and registrations.
- Dependencies are included; missing, cyclic, conflicting, and denied
  requirements fail closed.
- Child scopes may override parent registrations, and disposal reveals the
  previous registration.
- Plans contain JSON data only and are recursively frozen.
- A persisted plan must pass `verifyCapabilityPlan()` before it is returned by
  the orchestrator store.

The hook pipeline executes only hook manifests selected by that immutable plan.
Operation hooks run sequentially in capability priority order at
`before_execute`, `after_execute`, and `on_error`. Enforcing hooks fail closed
on denial, timeout, invalid output, missing registration, or manifest drift.
Observing hooks may fail without blocking the operation, but every outcome is
returned as a bounded audit record. Hook inputs are immutable and hook results
cannot rewrite prompts, tool arguments, or permissions; they may only continue,
deny, and attach up to 16 KiB of JSON annotations.

This package deliberately does not execute tools or enforce sandbox permissions.
Runtime, hook, policy, and executor providers consume the same plan while
sandbox enforcement remains in its owning layer.
