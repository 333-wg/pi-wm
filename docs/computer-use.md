# Windows Computer Use

The local Pi runtime prefers semantic automation rather than desktop pixels:

1. Websites: existing isolated Playwright browser tools (`browser_open`,
   `browser_snapshot`, `browser_action`). Headless by default; their login state
   is separate from the user's personal browser and other agent sessions.
2. Native Windows apps: `computer_windows`, `computer_inspect`,
   `computer_element_action`. Read controls and use their supported UI Automation
   patterns without requesting focus or directly injecting global input.
3. Unsupported controls: `computer_screenshot` and explicitly approved
   `computer_action`, followed by `computer_release` when finished.

Semantic results are text, so they do not require model vision. The screenshot
fallback still needs an image-capable model. Routing guidance is included in both
the model context and built-in skill, not dependent on the model loading a skill.

## Enable

1. Install Python 3 with `venv` support. Optionally set `WUMING_COMPUTER_PYTHON`
   to its absolute executable path for a manually launched Gateway.
2. Open Settings > Computer Use, turn on desktop control and accept the permission
   dialog. A missing environment is prepared automatically: an isolated venv and
   mss/Pillow downloaded from PyPI. Installation stages are shown in Settings.
3. Once ready, the built-in `computer-use` skill and its tools become available.
   The switch is persisted in `<dataDir>/computer-use/settings.json`. On restart,
   a successful environment probe is required before restoring access.
4. On single-owner gateways bound to loopback (no `WUMING_AUTH_TOKENS_JSON`), the
   Settings grant covers reads and semantic control operations. `always` still
   prompts; read-only sessions cannot mutate controls or send input. Foreground
   pixel actions execute directly in local full-access sessions. Other modes use
   per-action approval or an explicit `computer_control` grant. Always-ask is still
   honored. Shared or non-loopback deployments
   retain explicit per-operation approval and require `on_risk` or `always`.
5. Ask the agent to perform the desktop task. The skill guides browser/semantic
   routing, observed controls, result verification and release. Closing the switch withdraws the skill
   and tools for subsequent turns and aborts active desktop execution. The skills
   manager displays this built-in as settings-managed, with no separate switch.

An installation interrupted by Stop may finish downloading dependencies, but
cannot re-enable control. Emergency stop persists the disabled setting. Normal
application shutdown preserves the requested setting. Restoring the switch does
not itself enqueue a task; existing automation policies are unchanged.
Purchases, publishing, deletion and other consequential actions still
require task-specific user confirmation via `require_confirmation=true`; the skill instructs this, rather than
claiming that a pixel executor can reliably classify every action's consequences.

To stop, use the Computer Use settings switch or emergency-stop button. In Electron, Ctrl+Alt+F12 is registered
as a global emergency shortcut (a registration failure is written to the desktop
log). The Python helper also checks this combination while executing. Emergency
stop disables subsequent calls and cancels an active helper or pending approval.

## Implementation

- `packages/sandbox/src/computer.ts`: persistent settings, automatic isolated
  setup, environment readiness, lease, cancellation, bounded processes, snapshots.
- `packages/sandbox/src/computer-tools.ts`: approvals, image tool results and
  artifact retention. Does not depend on MCP image conversion.
- `packages/sandbox/runtime/computer_windows.py`: DPI-aware display capture,
  window identity checks, tagged Win32 input and a low-level keyboard/mouse
  observer. Untagged input interrupts the operation; it is never suppressed or
  logged. An atomic input batch may already have been sent before interruption.
- `packages/sandbox/src/computer-semantic.ts` and `runtime/ComputerUia.cs`: bounded
  UI Automation bridge, compiled once per source digest using Windows .NET
  Framework's C# compiler into the application data directory. No PowerShell
  execution-policy changes, additional Python package or downloaded executable.
  A missing/blocked .NET compiler is surfaced as an error, not a pixel fallback.
- `/api/computer-use`: local, owner-only settings/status endpoints. No HTTP
  endpoint accepts arbitrary input actions, scripts, executables or Python paths.
- Desktop approval decisions also require the device owner on a loopback
  connection. Do not expose or reverse-proxy a local-device Gateway to others.
- Desktop staging includes the Python and C# runtime sources. Python itself is not bundled.

## Semantic Contract

- Read at most 250 controls, depth 8, with a 5-second traversal budget and an
  18-second hard process timeout. A truncated result is explicitly marked.
- Omit password controls and their subtrees. Other app content is not
  privacy-filtered and remains untrusted input to the model.
- Keep native runtime IDs on the host. Model-visible refs are random and bound
  to one observed snapshot. Revalidate the process start time, native control ID,
  control type/name/automation ID and observed value/state before mutation.
- Support Invoke, Value, SelectionItem, Toggle and ExpandCollapse patterns only.
  Reject disabled/offscreen/unsupported controls instead of silently clicking.
- Return a new control tree after an operation. Provider completion does not
  prove task success. A timeout or verification failure is an uncertain outcome;
  do not automatically replay an action or fall back to pixels.
- UIA providers may activate their own app. Receipts include `foregroundChanged`,
  `targetActivated` and `cursorMoved`. These are observations, not proof of who
  caused a change on a shared desktop. If the target process became foreground,
  subsequent semantic actions on that process require explicit approval unless
  the task has a valid continuous-control grant. Merely
  moving the user's mouse or switching to another unrelated app does not promote
  the target to foreground-only. Transport failures are conservatively escalated.
- This is not a virtual desktop. Native applications and providers vary; do not
  promise that every UIA call works in the background. The bundled WinForms
  integration fixture itself exposes a Value provider that can activate a window.

## Upstream Reuse

Reviewed NanmiCoder/cc-haha at commit
`0676c194e84b2da77c94d3992eadbf6e5eb9d7cb` (MIT). Relevant upstream files:

- `desktop/src/pages/ComputerUseSettings.tsx` and
  `desktop/src/components/computer-use/ComputerUseEnableDialog.tsx`: settings
  workflow and one-time enable consent, adapted to this application's UI.
- `src/utils/computerUse/skillGate.ts` and `preauthorizedConfig.ts`: persistent
  enable state, skill visibility and settings-level permission model. This
  project additionally restricts preauthorization to a loopback single-owner host.
- `src/vendor/computer-use-mcp/imageResize.ts`: algorithm actually ported into
  Python as `target_image_size`, retaining its tile budget, binary search,
  portrait handling and JavaScript rounding. Copyright and MIT license accompany
  the runtime in `CC-HAHA-LICENSE.txt` and are included in desktop staging.

The 28-pixel tile, 1568-token/long-edge policy follows upstream; other model
providers may resize differently. Returned dimensions always describe the actual
image used for this adapter's coordinate conversion, including negative display
origins and portrait monitors. This is not a complete cc-haha clone: the Windows
executor remains a bounded native adapter, without upstream analytics, arbitrary
REPL, clipboard permissions or macOS bridge. The new UIA bridge is an independent
Windows implementation, not a port of the upstream macOS AX/Swift executor. Input
interference monitoring follows the upstream approach but is not its complete
foreground-lease implementation. The helper now also synchronizes its hook thread
through an event barrier and checks that accepted tagged input was observed.

## Continuous Control and Verification

- `computer_control` requests human approval for a named task, default 5 minutes,
  maximum 10. This is local-owner only, in-memory and bound to the live operation
  ID and retry attempt, not the cached tool snapshot. It is not a persistent grant.
  Full-access sessions do not need it; compatibility calls succeed without a prompt.
- The existing approval broker still enforces read-only and always-ask policies.
  Sending, submitting, purchasing, deleting, publishing and entering credentials
  must set `require_confirmation=true`, including during a grant. This relies on
  the model correctly identifying consequences; it is not automatic risk detection.
- Take a fresh screenshot after consent. Subsequent ordinary actions do not steal
  focus back automatically. Release, expiry, 120-second idle, error or emergency
  stop invalidates the grant. Task changes/retries cannot reuse it. Physical input
  during actual foreground execution is monitored. Global last-input tick changes
  between observations no longer revoke consent: passive mouse movement and other
  injected input made that rule too broad. Target identity/focus/geometry checks remain.
- The native helper distinguishes `not_started` from `unknown` (possible partial
  input). Transport errors are conservatively unknown. Neither path retries the
  action. Unknown results consume the snapshot and revoke continuous control.
- Post-action screenshots sample up to 1500 ms for three unchanged frame intervals.
  `observation.stable` is visual evidence only: a loading screen can also be stable.
  `computer_screenshot.wait_ms` can observe for up to 3000 ms without sending input.
- UIA value, select, toggle, expand and collapse poll their expected native state
  for up to 1500 ms. `verified=true` confirms that control state, not the full task.
  Timeout is unknown; no mutation is replayed. Invoke has no generic postcondition
  (`verified=null`), so the model must inspect the business result. The enclosing
  helper timeout still bounds stalled provider calls.
- UIA receipts also observe last-input changes. Input activity while the target
  is foreground at the start or end marks the outcome unknown. This cannot identify
  every transient focus change or distinguish all third-party injected input.

## Boundaries

- Screenshots include all visible windows on the selected display; window titles
  and process paths are also sent to the selected model. Close sensitive windows
  first. Saved screenshots follow existing conversation artifact retention.
- Foreground fallback uses the real desktop. Do not operate it concurrently with the agent.
  It is not a VM or a security sandbox. Protected/elevated windows may reject input.
- An explicitly approved action can restore the captured window after the
  approval UI took focus. Explicit `focus` uses only the captured inventory. All
  input checks process identity and geometry; click points must belong to the
  captured foreground window.
- IDs expire after 120 seconds and are consumed by one action. These checks do
  not prove that same-window content is unchanged; dynamic UI still needs care.
- A per-Gateway lease excludes other sessions; the helper also uses a Windows
  named mutex to exclude simultaneous helper commands across processes. The idle
  lease expires after 120 seconds. Stop releases it once the child has exited.
- `computer_apps` lists up to 300 Start Menu shortcuts with opaque two-minute refs;
  `computer_open` launches one through Windows Shell. The host revalidates its
  path/content digest against a fresh inventory. No arbitrary commands or paths
  are accepted from the model. Store-only/portable apps may not appear. A launch
  request is not proof the window is ready; inspect windows afterwards.
- Supported input: click, double-click, right-click, scroll, text, key chords,
  and focus of an existing window. No dragging, held inputs, clipboard API,
  macOS executor or Linux executor in this version.
- Structured not-started/unknown receipts render as "not executed"/"outcome
  unverified" instead of a green completed label, without marking them retryable.
- Each input batch includes matching key/button releases; there is no exposed
  key-down/mouse-down tool. Do not blindly repeat a failed input operation.

## Verification

Model connection failures and desktop action receipts are separate failure paths.
Bounded model retries persist completed tool results and request timing/status
before starting another attempt. The retry prompt carries the current task's tool
ledger and asks the model to inspect current state, then continue unfinished work
instead of replaying the original task. Manual recovery after desktop tools uses
the same continuation instruction. This is not an exactly-once guarantee for
model-selected actions; unknown receipts still require observation before replay.
Retry history records scheduling, whereas the durable attempt counts started
task attempts. The UI must not derive started attempts from history length.

```powershell
npx vitest run packages/sandbox/test/computer.test.ts packages/sandbox/test/approval.test.ts apps/gateway/test/computer.test.ts apps/gateway/test/tools.test.ts
python -B -m unittest discover -s packages/sandbox/runtime -p test_computer_windows.py -v
npx playwright test e2e/computer-use.spec.ts
npx vitest run packages/orchestrator/test/request-usage.test.ts packages/pi-adapter/test/pi-agent-runtime.test.ts apps/web/test/failure-state.test.ts
npx playwright test e2e/failure-recovery.spec.ts
$env:WUMING_TEST_UIA = "1"
npx vitest run packages/sandbox/test/computer-uia.integration.test.ts
```

Manager/permission tests use fake desktop results. The opt-in Windows integration
test compiles an invisible WinForms fixture, edits its text via UIA, invokes its
save button, checks the actual file, rejects stale controls and excludes a known
password value. It also checks a delayed value update and an intentionally refused value:
the former is verified, while the latter returns an unknown outcome without replay.
It records foreground/cursor observations; providers can activate windows.
The disposable text fixtures discard keyboard/IME messages so they do not record
the user's typing if a provider activates the invisible test window.
`WUMING_UIA_ASSERT_CURSOR_STILL=1` additionally asserts an unchanged mouse
on a deliberately idle test machine, not a user's concurrently used desktop.
No screenshots or keystrokes are sent into unrelated user applications. A separate
headless-browser test fills a local form by semantic targets and checks isolated
storage across two sessions. No live-model task-success rate has been measured.
