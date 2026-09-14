# Skill Evaluation Status

Updated: 2026-09-06. The full-system goal remains open.

## Source Guard and Routing Follow-up

The gateway now requires human approval before read_file/edit can access
SKILL.md source, refuses such inspection under never/on_failure, and withholds
SKILL.md matching/context lines from grep content and output artifacts. Human
management preview is unaffected. Tests cover pre-IO denial, case/Windows path
variants, explicit approval, ordinary-file access and artifact filtering.
This does not isolate arbitrary commands, external tools, renamed source copies
or prior conversation contents; see skill-management.md for the exact boundary.

Eligible summaries are also supplied in the provider-visible skill_load tool
description; wire tests verify descriptions and exclude manual-only entries.
Live loader checks still enforce enabled/manual-only policy. Skill choice is
not assigned by a keyword router. Recovery errors remind the model to reassess
skills only when the loader is actually available.

Retained follow-up reports (do not pool these into a success percentage):

- skill-model-evaluation-source-gate-2026-09-06.json: 7/9 under the earlier
  assertions. Chinese debug chose only fixture-audit; recovery skipped the
  requested initial read. The disabled-source case passed with real denials.
- skill-model-evaluation-intent-order-2026-09-06.json: 5/9 under the earlier
  assertions after primary-operation and exact-file-order guidance. Disabled
  source passed again. Chinese debug loaded both debug and unrelated
  fixture-audit, revealing that target-presence alone was too weak a check.
- skill-model-evaluation-strict-routing-2026-09-06.json: 1/4 targeted cases
  passed with acceptanceVersion skill-routing-v2-no-unrelated-fixture. Chinese
  debug passed; English debug also loaded fixture-audit and failed; review and
  recovery skipped skills. All four requests completed, so these are behavioral
  failures, not provider failures. The other five cases were not selected in
  this targeted run, not implicitly passed.

The v2 harness now rejects unrelated fixture activation/output during debug,
review and recovery. Source-boundary behavior has improved in these read-only
samples, but automatic builtin selection is NOT stable or fully accepted.
No source guard can establish general instruction isolation after a user has
approved inspection. Do not claim skill-system parity or completion from these
results. The final read_file description additionally advertises the approval
requirement; the remote runs above predate that last descriptive-only change.

## New Provider Recheck

The newly configured deepseek-v4 provider completed all nine cases with normal
stop reasons and no provider failures. See
skill-model-evaluation-new-provider-2026-09-06.json. Four cases passed:
greeting, translation, explicit manual selection, and automatic activation of
the installed fixture skill. Five failed behavioral assertions, not transport.

Both debug cases and code review skipped their applicable builtin skills.
The recovery case observed a missing-file error, listed the directory, read
the alternative configuration and reported its actual proof, but did not load
a newly applicable skill. This is evidence of changing approach, not successful
skill-mediated recovery. Review also included speculative input-validation
findings beyond the demonstrated arithmetic defect.

The disabled case recognized that fixture-audit was disabled, but adopted its
distinctive output directive from readable source anyway. Loader policy and
source-data markers therefore do not establish behavioral isolation. Keep this
negative case failing; do not hide it by counting only activation IDs.

This run used 5-second evaluation-only context-preparation pacing, a 120-second
turn timeout, at most 4096 output tokens, and required a normal stop reason.
The harness stops after two consecutive provider failures and reports unrun
cases separately; this run had none. Earlier transport failures remain
historical evidence, but provider availability is no longer the current blocker.
Automatic builtin invocation and disabled-source adherence need further work.

## Evidence and Changes

The initial seven-case real-model run passed only greeting and translation.
Diagnostic logging established that context plans included the catalog, not
that the provider received it. A local HTTP/SSE provider test then demonstrated
that Pi reset the prompt during preflight and dropped assembled context.
default-factory now supplies it through the supported before_agent_start hook.

The regression checks actual wire messages, not a mocked prompt setter. It
exercises a real failed file read, builtin debug loading, an alternative read,
reporting its unpredictable proof, explicit manual selection, and removal of
that explicit context on the next turn. It uses a scripted provider and does
not prove semantic selection by an LLM.

Prompt guidance distinguishes designated skills from untrusted file data,
requires loading applicable skills before task work, preserves unrelated-task
exclusions and prohibits bypassing manual-only policy via filesystem reads.
The debug description now includes first missing-file/configuration failures
and read-only diagnosis; excluding text-only explanation was ambiguous.

## Retained Real-Model Runs

Paths below are relative to docs/. These are separate attempts, not samples
pooled into a passing benchmark. Reports sanitize and cap diagnostic text.

| Report                                                    | Result | Interpretation                                                                                                                     |
| --------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| skill-model-evaluation-2026-09-06.json                    | 2/7    | Baseline; incomplete diagnostics                                                                                                   |
| skill-model-evaluation-diagnostic-2026-09-06.json         | 0/4    | Skipped loads and HTTP 429; context plan did not prove delivery                                                                    |
| skill-model-evaluation-prompt-fix-2026-09-06.json         | 0/4    | HTTP 429; wording change alone unverified                                                                                          |
| skill-model-evaluation-flash-2026-09-06.json              | 0/7    | Alternate saved provider timed out on every case                                                                                   |
| skill-model-evaluation-context-fix-2026-09-06.json        | 2/2    | Lifecycle fix: Chinese review loaded code-review; explicit manual output matched                                                   |
| skill-model-evaluation-integrated-2026-09-06.json         | 2/7    | Greeting/translation passed; Chinese diagnosis skipped debug; other cases hit HTTP 429                                             |
| skill-model-evaluation-debug-description-2026-09-06.json  | 0/2    | Revised trigger still unverified because of HTTP 429                                                                               |
| skill-model-evaluation-recovery-recheck-2026-09-06.json   | 0/2    | Recheck still hit HTTP 429                                                                                                         |
| skill-model-evaluation-preserved-evidence-2026-09-06.json | 0/1    | Provider timeout; no returned runtime evidence                                                                                     |
| skill-model-evaluation-installed-2026-09-06.json          | 1/2    | Installed skill loaded and returned correct proof; disabled source instructions still influenced the reply                         |
| skill-model-evaluation-source-boundary-2026-09-06.json    | 1/2    | Installed skill still worked; disabled recheck interrupted by HTTP 429, with partial tools preserved                               |
| skill-model-evaluation-paced-2026-09-06.json              | 3/9    | 60-second inter-case pacing: greeting, explicit manual skill and installed automatic skill passed; six cases hit HTTP 429/timeouts |

The earlier harness counted requested explicit IDs as used. Integrated and
later reports read recorded turn usage, retaining separate successful load IDs.
Explicit output has an exact response assertion. Reports before the evidence
repair may omit tools from failed operations. Returned runtime failures/retries
now preserve those items; a timeout/abort without a returned result can still
omit them. An empty array is not proof that no upstream request or tool ran.

## Further Repairs and Coverage

The installed-skill test exposed a distinction between loader enforcement and
model behavior: skill_load correctly denied a disabled skill, but the model read
the install source through read_file and adopted its reply-format directive.
Raw SKILL.md source reads now carry an explicit inspection-data marker, and
policy denials instruct the model not to follow previously seen copies. The
negative test checks a distinctive forbidden output marker as well as recorded
activation IDs. The mitigation is not yet behaviorally accepted and is not a
general prompt-injection sandbox.

Retry attribution no longer mutates explicit input skills. Returned failure
items and cross-attempt skill IDs survive SQLite reopen/event replay; tests also
cover more than eight observed skills. A local HTTP fixture returns 429 after a
skill load and verifies that completed tool evidence remains visible while the
operation is still marked failed.

The real-model suite now has nine cases, including installed/disabled workflows,
instruction/description/policy digests, and an optional pause between cases via
WUMING_SKILL_EVAL_PAUSE_MS (0 through 60000). This pacing does not add retries or
relax assertions. Unknown case IDs are rejected rather than producing a zero-case
success. Negative greeting/translation cases require no unnecessary tool calls.

Local checks: npm run check and npm run test passed, along with nine skill
Playwright tests. The launch-recipe reference was verified in the gateway pack
dry run and through on-demand loading tests; its real-model authoring quality is
not established by those packaging tests.

The paced debug-zh trace provides real partial recovery evidence: ls with path
workspace failed (ENOENT); the model loaded debug; ls with path . then succeeded
and emitted a changed-attempt observation. The provider subsequently returned
429 before the requested proof was verified. This proves an observed mid-turn
activation and changed input, not completion of the original diagnostic task.
The installed-disabled mitigation remains unverified because both subsequent
negative attempts were interrupted by provider errors. Further rapid retries
are not justified by this evidence; a responsive provider is needed to finish
the remaining real-model acceptance cases.

## Outstanding Gates

- Test Chinese/English positive, negative and ambiguous triggers after the latest
  lifecycle and description changes with a responsive provider.
- Demonstrate real-model mid-turn activation, an authorized changed approach
  and verification of the original requested result after an observed error.
- Exercise code-change, app launch, browser verification and research output
  quality beyond this read-only routing/recovery smoke suite.
- Compare installed user skills with builtins in real execution, including
  disabled/manual-only policy and deliberate instruction-injection attempts.
- Extend artifact workflows with available tools and actual output inspection;
  seven coding-oriented skills do not cover every vendor workflow.

Do not claim full acceptance based on two successful cases or local tests.
HTTP 429/timeouts are environment failures, not passing behavior samples.
