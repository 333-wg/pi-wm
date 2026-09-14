# Trajectory

`@wuming/trajectory` defines a body-free, hash-chained operation timeline and a
deterministic structural evaluator. Events record references, digests, bounded
usage and lifecycle metadata; prompts, tool arguments, outputs and credentials
remain in their existing authorized stores.

Replay verifies sequence numbers, previous-event digests and each event digest.
The `structural-v1` evaluation scores integrity, completion, reliability, policy
signals and observability. It explicitly reports semantic correctness as
`not_evaluated`; completing a provider request is not proof that its answer was
correct.
