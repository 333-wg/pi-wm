# Context Engine

The context engine assembles the model-facing system prompt under an explicit
token budget. It keeps the base system prompt, policy, selected Skills,
workspace references, and memory as versioned fragments with content hashes and
source provenance.

The durable `ContextPlan` contains decisions and hashes, not fragment bodies.
The Pi adapter rebuilds the assembly immediately before a model request and
rejects drift. Stable fragments are placed first and produce a separate cache
prefix digest; optional workspace fragments are relevance ranked and may be
bounded using an explicit truncation policy.
