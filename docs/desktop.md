# Pi-Wm Desktop

Desktop packaging targets Windows x64 and native macOS arm64/x64. Electron hosts the existing
production React workbench; a separate, bundled Node 22 process owns the Gateway,
SQLite, user tools, PTYs, and browser automation. No Vite server, system Node,
npm, or source checkout is needed to open the distributed application.

## Development

On first launch, the clover welcome screen accepts `wuming` and opens the
workbench directly. Successful entry is remembered in this device's profile.
This is a first-use UI gate, not an OS-level security boundary. The desktop
continues to use its separate random Gateway token, which is not saved in web
storage. The browser version still validates the configured `WUMING_TOKEN`
server-side (the development default is `wuming`).

Packaging requires Windows x64 or macOS arm64/x64 and native Node 22.19 or newer
in the Node 22 series. Native dependencies and Chromium must match the build host.

```sh
npm ci
npm run desktop
```

This builds the workspace before opening Electron. It uses the development
machine's Node binary without rebuilding node-pty for Electron. The ordinary
`npm run local` browser entry is unchanged.

## Distribution

```sh
npm run desktop:dist
```

Output:

- `release/Pi-Wm-0.1.2-Setup-x64.exe`: per-user NSIS installer.
- `release/win-unpacked/Pi-Wm.exe`: runnable distribution directory; keep its
  sibling files and `resources` together.

`desktop:pack` builds just the unpacked directory. `desktop:stage` assembles the
runtime in `.desktop-stage/runtime`, using workspace-scoped `npm ci --omit=dev --ignore-scripts`
against the repository lockfile and the node-pty rebuild hook. Workspace links
are materialized so they cannot point back to the build machine. The package
includes Node, its license, production dependencies and their licenses, built
workspace packages, builtin skills, the compiled UI, and Playwright's headless
Chromium and FFmpeg. Browser binaries are downloaded at build time, not at first
launch. Node and lockfile SHA-256 values are recorded in `runtime-manifest.json`.

Runtime dependencies have a separate `extraResources` entry: electron-builder's
generic directory copier excludes a root `node_modules`. Staging writes a complete
runtime file inventory (excluding `.gitkeep` placeholders); `afterPack` rejects a
release with missing files, including nested dependencies and native extensions.
Version 0.1.0 omitted these dependencies and must not be distributed.

Version 0.1.2 uses the public name Pi-Wm while retaining `com.wuming.desktop`,
the `wuming://app/` origin, `@wuming/*` internal packages, storage keys, and the
existing `%APPDATA%/Wuming` profile for update and data compatibility. It installs
only the Gateway workspace's production dependency graph. Frontend dependencies
are already bundled by Vite and do not need a second raw runtime installation.
Source maps, type declarations, PDB debugger symbols, and non-target node-pty prebuilds are
removed from staging with a bounded allowlist. Package licenses,
runtime assets, PDF support, the browser, and standalone Node remain intact.
Electron language resources are limited to English and Simplified/Traditional
Chinese. `runtime-manifest.json` records pruning counts and uncompressed bytes.

The installer is an **unsigned internal-test build** unless a signing identity
is supplied to electron-builder. Windows may warn about an unknown publisher.
Windows update behavior and release gates are documented in [desktop updates](desktop-updates.md).
Do not treat installer replacement as verified database migration or rollback.
The product icon is included in both Windows and macOS builds.

## macOS Build and Release

Run `npm run desktop:dist` on a Mac using native Node 22. The same command selects
DMG and ZIP instead of NSIS. Apple Silicon uses arm64; Intel uses x64. Do not
cross-build or run Node under Rosetta: the bundled Node, node-pty, native canvas,
and Playwright browser are installed for the current Node architecture.

- `release/Pi-Wm-<version>-mac-arm64.dmg` and `.zip`: Apple Silicon.
- `release/Pi-Wm-<version>-mac-x64.dmg` and `.zip`: Intel.
- `release/mac-arm64/Pi-Wm.app` or `release/mac/Pi-Wm.app`: unpacked application.

The Mac application uses `Contents/Resources/runtime/node`, executable permissions,
and matching native dependencies. Its data is in `~/Library/Application Support/Wuming`,
outside the app bundle. Closing the last window quits the app, as on Windows.
Computer Use's Windows desktop driver remains unavailable on macOS.

These are **internal-test, ad-hoc-signed builds**, not Developer ID-signed or
Apple-notarized distributions. Gatekeeper can block downloaded builds. Do not
disable Gatekeeper system-wide. Wider distribution requires a separate Developer ID,
hardened runtime/entitlements and notarization rollout. Mac automatic updates remain
disabled until signing and actual installation/upgrade behavior have been verified.
For now, quit the app and replace it with the new `.app`; keep the data directory.

In GitHub Actions, manually run **Desktop macOS**. It uses native `macos-15` arm64
and `macos-15-intel` x64 runners and Node 22.23.2. Pull requests touching the packaging
path also run the workflow but cannot upload releases. Each runner builds, runs
desktop tests, verifies the DMG and extracted ZIP signature, checks the bundled
Node architecture, relocates the app outside the checkout, exercises Chromium,
PDF extraction, native canvas and SQLite, and launches the packaged UI and PTY.
Successful runs retain installers and SHA-256 files as Actions artifacts for 14 days.
`node scripts/verify-desktop-macos.mjs` runs the same package gate locally on a Mac.

Release attachment is opt-in: select `upload_to_release` when dispatching the workflow.
Both architectures must pass. It attaches the two DMGs, two ZIPs and their checksum
files to the existing `v<apps/desktop/package.json version>` release in
`desktopUpdateRepository` (currently `333-wg/pi-wm`). It does not create/publish a
release, overwrite assets, or modify Windows update metadata. The generated
`latest-mac.yml` is deliberately not uploaded while Mac auto-update is disabled.

In `333-wg/pi-wm`, the default `github.token` has the upload job's **Contents: write**
permission; no extra secret is needed. The former `333-wg/wuming-agent` repository URL
redirects to this repository. If the workflow is moved to a different source repository,
configure its Actions secret `DESKTOP_RELEASE_TOKEN` with a fine-grained token authorized
for **Contents: write** on the release repository. No release token is passed to build
or pull-request jobs. Build-only runs do not need this secret. Missing permissions fail
the upload job while leaving verified installers available as workflow artifacts.

Do not announce Mac downloads until the native gates pass and the assets actually
appear in the release. CI smoke tests do not replace testing the downloaded DMG on
a clean Mac with Gatekeeper enabled.

## Lifecycle and Data

- One app instance owns one Gateway. A second launch focuses the first window.
- The Gateway binds `127.0.0.1` on a dynamically allocated port; no fixed-port
  reservation or probe of an unrelated service is used.
- A private IPC readiness message gates window loading. Startup/crash failures
  offer restart or exit and identify the local log location.
- Closing the last window quits the application. There is no hidden tray mode:
  running tasks and automations stop when the app exits, and do not run while
  the app is closed. Shutdown asks the Gateway to release resources, then kills
  its process tree if it does not exit within the grace period. Parent IPC loss
  also initiates Gateway shutdown.
- The default profile is `%APPDATA%/Wuming`; `data`, `workspace`, and `logs` are
  subdirectories. User data is outside the installation and preserved on
  uninstall. The former browser-only `%LOCALAPPDATA%/Wuming` data is not imported
  automatically or overwritten.
- `--user-data-dir=C:\absolute\profile` selects an isolated profile, including
  its own single-instance lock. Use this for verification without touching real
  conversations or credentials.
- Project selection is a native Electron dialog, tied to the application
  window. Ordinary folder selection replaces the previous PowerShell dialog
  only in desktop mode.

## Security Boundary

The workbench has a stable `wuming://app/` origin, keeping browser preferences
independent of the ephemeral Gateway port. Node integration is disabled;
context isolation, renderer sandboxing, CSP, frame restrictions, and sender-
validated preload IPC are enabled. The preload only exposes connection
bootstrap, not arbitrary filesystem, shell, or IPC methods.

Each launch generates a fresh random Gateway token. It is retained in renderer
memory rather than localStorage, never placed in a URL or command-line argument,
and removed from the Gateway environment before tools can inherit it. Desktop
requests require the actual loopback Host header; desktop Origin is explicitly
allowed. The custom protocol serves only built assets and forwards authenticated
API requests to that one Gateway without following redirects. External HTTP(S)
links leave the app in the system browser; executable URL schemes are denied.

This does **not** turn local process execution into an OS-level workspace
sandbox. Approved commands run with the user's account privileges. Model calls
still contact the user's configured provider. Broader secret isolation, signing,
updates, data migration, and a clean-machine acceptance matrix remain release
work, not claims made by this desktop-host increment.

## Verification

```sh
npm run build
npm run test:desktop
npm run verify:desktop
node scripts/verify-desktop.mjs --packaged=release/win-unpacked/Pi-Wm.exe
npm run verify:desktop:workflows
node scripts/verify-desktop-workflows.mjs --packaged=release/win-unpacked/Pi-Wm.exe
npm run verify:desktop:installer
```

Unit/integration tests cover origin and path policy, API forwarding, environment
isolation, readiness, early exit, timeout termination, real Gateway handshake,
host/origin rejection, and shutdown after parent disconnect. Electron smoke
tests cover renderer isolation, production UI, API/WebSocket connectivity,
single instance, project/theme persistence across reload and restart, token rotation,
native PTY command execution, and closed Gateway ports. They use disposable profiles
with spaces in their paths and do not call paid
models. Both packaged checks first validate the runtime inventory, copy the entire
release outside the source checkout, reject ancestor `node_modules` directories,
and remove developer Node/npm paths and injected Node options. The smoke check
starts the real Pi runtime with no provider configured. Screenshots are under
`test-results/desktop` and `test-results/desktop-packaged`.

The earlier in-repository release check was insufficient: Node resolved missing
packages from the checkout's ancestor `node_modules`. It is superseded by the
relocated checks. Installer verification extracts the actual NSIS payload without
executing the installer, checks its inventory, then runs relocated workflows.
Its report includes the installer SHA-256 under `test-results/desktop-installer`.
It also launches bundled Chromium, generates and extracts a PDF, and exercises
the native canvas binding and SQLite using the bundled Node executable.
This does not modify the user's installed app or registry and is not a substitute
for testing the NSIS installation/upgrade UI on a clean VM.

The workflow check uses the real Pi adapter and local file/command execution with
a deterministic loopback model endpoint. It asserts that both Electron data paths
belong to its disposable profile, uses synthetic credentials, and never loads the
user's saved provider keys. It covers Chinese/spaced project paths, read/write/
readback/command verification, approval denial, stopping a hanging request, a 401
without retries, shutdown during execution, persisted history, and renderer-crash
recovery. The native picker and error-dialog responses are stubbed at Electron's
dialog API; the renderer, Gateway, and parent IPC are real. This is not a manual
native-dialog test or evidence of real-model task quality. Windows run commands
also have regression coverage for quoted executable, script, and output paths.

Workflow windows stay hidden to avoid interfering with the user's desktop.
JSON results are under `test-results/desktop-workflows` and
`test-results/desktop-workflows-packaged`; visible UI screenshots remain part of
the separate smoke check. Do not rebuild the web assets or package while running
a desktop check against that same directory.

Before public distribution, still verify the NSIS install/uninstall and upgrade
flow on a clean Windows account or VM with no developer runtimes, perform a
bounded task against an explicitly chosen real model provider, and finish code
signing, application identity, update/data-migration policy, and release support
documentation. Passing local automated checks qualifies this build for internal
testing, not unrestricted public release.
