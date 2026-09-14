# Real-model plan acceptance

This opt-in acceptance mode extends `scripts/verify-pi-tools.ts`. It uses the
configured Pi provider and can incur model costs. It is not part of ordinary
unit or demo-browser tests.

Configure `WUMING_AGENT_DIR`, `WUMING_MODEL_PROVIDER` and `WUMING_MODEL_ID`
using the existing provider setup. Credentials are read from that configuration;
do not paste them into prompts, source files, or test reports.

In PowerShell, with the required provider configuration already present:

```powershell
$env:WUMING_PI_GOAL_PLAN = "1"
npm run verify:pi-tools
```

The flag selects the plan case instead of the default single-tool suite. Remove
the flag after use to return to the normal suite.

## Acceptance criteria

Two independent steps write numeric inputs into separate JSON files. A dependent
step reads both, adds their values, writes a report, and reads the report back.
The script independently verifies file contents, source references, all three
completed step states, and successful writes to each step's exact output path.
The merge must read both exact input paths before its final report write, then
read that report after the write. Unrelated paths, failed calls, extra JSON
fields, and non-file tools fail acceptance. The model's final answer alone
cannot satisfy these checks.

The credential-free verifier unit tests run with `npm run test:acceptance`
and are included in `npm test`. They do not invoke an external provider.
The suite includes real disposable Node child processes for chunked readiness,
startup timeout, early exit, invalid ports, and spawn failure. Startup failures
reap the owned child before returning; shutdown waits for observed exit and
fails if termination cannot be confirmed. Raw startup logs are not included
in errors. All 18 verifier/lifecycle tests passed on 2026-09-05. This does not
establish that a real model or the production gateway has passed acceptance.

The report contains provider/model identifiers, aggregate and per-step usage,
and the passed check names. Temporary workspace and gateway data are removed
after the run. On failure the script attempts to cancel the plan and stops its
owned gateway.

## Limits and verification status

### Saved Web model configuration preflight

The separate `verify:pi-provider` smoke script can read an existing Web model
source by setting `WUMING_PI_MODEL_SOURCE_DIR` to its data directory. Set the
existing agent directory, provider and model ID variables explicitly, then run:

```powershell
$env:WUMING_PI_MODEL_SOURCE_DIR = ".wuming-data"
$env:WUMING_PI_PREFLIGHT = "1"
npm run verify:pi-provider
```

This checks only decryption, configuration validity, and selected-model presence.
It sends no provider request and creates no session or credential copy. Legacy
source files are not migrated. Credentials remain in memory; the source key is
read from its existing key file or the configured encryption-key environment.
On 2026-09-05 the saved `deepseek-v4-pro` configuration passed this preflight,
with unchanged hashes for the encrypted source and its key. This is not evidence
of endpoint connectivity, actual model identity, or task completion.

Removing `WUMING_PI_PREFLIGHT` enables the real smoke request and may incur model
costs. Saved-source loading applies to `verify:pi-provider` and
`verify:pi-files`, not the gateway-backed DAG/tools script. The credential-free
acceptance suite includes 28 unit/lifecycle tests and two local provider-wire
integration cases, including saved-source loading and strict file round-trip
assertions. Wrong-key loading also fails without modifying the fixture.

### Real file round-trip acceptance — not passed

The new `npm run verify:pi-files` uses the saved-model environment variables
above, a temporary workspace/database, real orchestrator and approval broker,
and only read_file/write_file tools. Reads/writes are capped at 4 KiB, the saved
model registration at 256 output tokens per request, and the turn at 30 seconds
with automatic retries disabled. These limits are not a provider billing cap.
Acceptance requires a completed durable operation, exactly read/write/read in
order, exact file content including its final newline, and the expected final
assistant response. Tool success alone does not establish acceptance.

On 2026-09-05, one observed run completed all three tool calls but wrote 38 bytes
instead of the generated 55-byte input. This was not simply a missing final
newline. Reported total usage was 4,810 tokens; configured cost zero does not
establish the bill. No content-level trace was retained from that run, so the
cause is unresolved. The verifier now records only boolean content matches and
byte counts at the read/write boundaries, not file bodies or credentials.
A subsequent diagnostic run timed out before its first tool invocation and
therefore did not locate the mismatch. The encrypted source and key hashes
remained unchanged during these checks.

Two network-free integration tests using the real file executor, approval
broker, and Pi-backed tool definitions pass for the generated proof format and
Chinese/emoji text with CRLF. They establish exact local read/write/read
behavior for those fixtures, not model-facing message correctness or remote
model reliability. File/DAG real-provider acceptance remains pending. Avoid
further blind paid retries; use the boundary evidence on the next intentional
real run to isolate the failure before changing the runtime.

### Local provider-wire integration

`npm run test:provider-wire` builds the packages and tests the real Pi session
factory/runtime, OpenAI-compatible SDK streaming transport, durable orchestrator,
approval broker, and file tools against a disposable loopback HTTP server. It
does not read saved credentials or contact an external model. The server learns
the generated proof only from the read tool result in the next request; it does
not obtain it from the user prompt or fixture variable. Assertions check exact
Unicode/CRLF content, tool-call IDs, streamed argument reconstruction, exclusive
file-tool exposure, initial required tool choice, persisted write arguments,
durable completion, and final readback. A corrupt-output case proves a successful
operation and final assistant answer cannot bypass content acceptance.

Both cases passed on 2026-09-05. This narrows the unresolved external failure to
behavior not reproduced by this local protocol fixture; it does not prove the
external provider receives the same messages or identify its upstream model.
The suite is included in `test:acceptance` / `npm test`. Its scripts and the
real-file verifier are typechecked by `scripts/tsconfig.test.json` under the
normal `npm run check` gate.

### Remaining real-run boundaries

On 2026-09-05, the saved deepseek-v4-pro configuration completed the separate
real-provider smoke script and returned exactly WUMING_PI_OK. Reported usage
was 1,383 input, 28 output, 320 cache-read, and 1,731 total tokens. Original
encrypted configuration/key hashes were unchanged. The source registration was
bounded to 256 output tokens, with a 30-second abort deadline, no tools, disabled
automatic retry/compaction, and a temporary empty workspace. Configured cost is
zero and does not establish the actual bill. The evidence record is
docs/real-provider-smoke-2026-09-05.json.

The first attempt exposed a local recursive override of Pi's getContextUsage.
A network-disabled diagnostic and a real-session factory regression reproduced
the stack overflow. Removing that override preserves Pi's native method; the
regression and the real smoke then passed. This does not verify tool execution
or the durable-plan workflow; their real acceptance remains pending.

- The session has a 20,000-token dispatch budget, not a provider-enforced cost
  ceiling. Active model requests can overshoot a local accounting threshold.
- The workspace catalog is explicitly pinned to the temporary test directory.
- The prompt requests file tools only; the verifier rejects other tool traces.
  This is an acceptance assertion, not a separate network isolation boundary.
- A successful run establishes this small deterministic file workflow, not
  general model reliability or production multi-node readiness.
- Static TypeScript checking passed on 2026-09-05. Missing required agent
  configuration was verified to fail before gateway startup. No real-provider
  request was made in that validation; real acceptance remains pending.
