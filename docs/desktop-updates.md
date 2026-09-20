# Desktop Updates and GitHub Releases

## User Experience

- Desktop only: Settings > About & updates, plus the application menu.
- An available update adds a quiet shortcut above Settings in the main sidebar.
- Check at startup (after 20 seconds) and every six hours when automatic checking is enabled.
- Checking does not download. Downloading does not install. Quitting normally does not install.
- The user explicitly chooses Download, then Restart & install and confirms in a native dialog.
- After confirmation, Windows installation runs silently and automatically starts the new version. This is explicit consent, not unattended background installation.
- A 24-hour reminder deferral and the automatic-check preference are stored in the user's existing profile.
- The main process asks the local service about queued/running operations across all sessions, in-flight requests, recovery, automation ticks, and open terminals. Unknown/busy status blocks installation. It checks again after confirmation, gates new requests, then stops the service before invoking the installer.
- Update failure does not remove the installed application or user data. The existing Wuming profile and application ID remain unchanged.
- Development and unconfigured builds report their status explicitly and do not contact a release server.

## Choose a Repository

Use a **public release repository**. It may be separate from the private source repository; publishing installation binaries does not require publishing source code. No GitHub access token belongs in the desktop package.

The update repository is baked into each build. New builds default to **333-wg/pi-wm**, configured in `apps/desktop/package.json` as `desktopUpdateRepository`. The older 0.1.2 builds without this feature or without an update source need one manual installation to acquire the configured updater. Editing the source repository does not reconfigure an already installed binary.

Set `WUMING_UPDATE_REPOSITORY=owner/repository` to use a separate public release repository, or set it to `disabled` to intentionally build without an update source. Blank or unset values use the package default. GitHub URLs, credentials and malformed repository names are rejected.

## Build on Windows x64

Use Node 22.19+ (Node 22), as required by the existing desktop runtime packaging.

1. Increase the desktop version using npm so the lockfile also stays in sync:

   npm version 0.1.5 --workspace @wuming/desktop --no-git-tag-version

2. Normally no update-source environment variable is needed. To override the default for a dedicated test repository, set it in PowerShell:

   $env:WUMING_UPDATE_REPOSITORY = 'YOUR_OWNER/YOUR_RELEASE_REPOSITORY'

3. Run the checks and build:

   npm run check
   npm run test:desktop
   npm run desktop:dist

The build script validates the repository and injects both electron-builder's GitHub publish configuration and the desktop's repository metadata. It always uses publish=never, even if GH_TOKEN is present. Configured installer builds automatically run release-file verification after packaging; directory-only builds do not have release metadata to verify.

Before uploading, verify release/win-unpacked/resources/app-update.yml points to the expected public repository. Do not edit generated checksums or rename the installer after building.

### Verify Release Files

```sh
npm run verify:desktop:release
```

This read-only gate checks the desktop version, the expected Windows x64 filename, installer size and SHA-512 against both metadata entries in `latest.yml`, blockmap structure/coverage, and the packaged public GitHub source in `app-update.yml`. It rejects artifacts from mixed builds. Rebuild the entire release on failure; do not fix a checksum by hand. Blockmap coverage is not a cryptographic verification of every blockmap checksum, and this gate does not verify publisher signatures or installation behavior.

### Failure Recovery

The About & updates page shows the configured repository and bounded error categories, never raw provider errors, request URLs, filesystem paths or credentials. Missing stable releases, incomplete release metadata, network timeouts, access/rate-limit failures, disk space, cache permissions, and checksum/signature failures have separate messages.

A failed check clears any previous release selection and retries checking. A missing installer asset returns to checking so a repaired release can be discovered. Interrupted or rejected downloads can be downloaded again, or the user can explicitly check for newer metadata. Failed checksum/signature verification never enables installation. An installation failure preserves the restart action instead of being overwritten by a periodic check.

### Automated Verification

```sh
npm run test:desktop
npx playwright test e2e/desktop-updates.spec.ts
npm run verify:desktop:updates
```

The download test uses the real `electron-updater` NSIS implementation against an isolated loopback HTTP server and disposable cache. It exercises missing metadata, version discovery, corrupt payload rejection and a successful retry. The payload is not an executable; the test never installs, restarts or accesses a real user profile. This test uses Node loopback sockets in place of Electron networking and does not claim GitHub availability, differential-download verification, code-signing acceptance or a real N-to-N+1 installation.

The Playwright suite checks recovery actions and desktop/mobile layout. The native Electron check covers the menu and preload IPC in development mode; it is not a production update installation test.

### Packaged In-App Update Verification

After building a newer release, retain the previous version's `win-unpacked` directory and run:

```powershell
npm run verify:desktop:update-flow -- --baseline="D:\previous-release\win-unpacked\Pi-Wm.exe"
```

The test relocates both packaged applications outside the source checkout. It uses one disposable profile, a separate updater cache and a loopback update server serving the actual new installer. It drives the About & updates buttons through real preload IPC and Electron networking: missing metadata, cancellation, checksum rejection, retry, verified cached download after restart, declined confirmation, and the NSIS installation handoff. It also opens the new application directly with the old test profile to check session and preference compatibility.

The feed is overridden only in the disposable test process. The real `quitAndInstall` / NSIS argument construction executes, but the final OS process launch is intercepted. **This is not proof that NSIS replaced an installed application.** It never installs on the developer machine, changes registry entries, publishes a release, or modifies an existing user's profile. `test-results/desktop-update-flow/report.json` records these boundaries explicitly. A clean Windows VM still needs an actual N-to-N+1 installation test before public rollout.

For users, the intended path is **Settings > About & updates > Check for updates > Download > Restart & install**. GitHub hosts the files; users do not need to visit its website to download each update. Merely pushing source code is insufficient: the configured public repository needs a published stable release with the matching installer, blockmap and `latest.yml`. Old builds without a configured updater still require one initial manual installation.

## Publish a Release

Create a draft GitHub Release with a version tag matching the desktop version, for example v0.1.5. Attach the complete generated update set:

- Pi-Wm-0.1.5-Setup-x64.exe
- The matching .exe.blockmap
- latest.yml

Add human-readable release notes. Publish only after all assets are uploaded. Use a normal published release, not a draft or prerelease, for the stable channel. Source-code ZIP/TAR archives are not desktop update packages.

Future versions follow the same process with a higher version number. Do not overwrite a published installer in place. Keep older releases available for diagnostics and differential downloads.

## Before the First Public Rollout

- Sign Windows installers using a consistent trusted code-signing identity. Configure signing via the build environment; never commit certificate passwords. SHA-512 download verification is not a replacement for publisher authentication.
- On a clean Windows machine, install version N, publish N+1 to the configured test repository, and verify detection, progress, cancellation, retry, signature/checksum rejection, restart and preservation of sessions, projects and settings.
- Test with a task in another session, a queued task, an approval wait and an open terminal. Installation must remain blocked.
- Confirm normal Quit after a completed download does not silently install.
- Test interruption during download and startup without network access.
- Test release downloads from your actual users' network regions. If GitHub access is unreliable there, plan an HTTPS mirror/update service rather than embedding unofficial proxy addresses or credentials.

No GitHub repository, release, tag or upload is created by this implementation. A full remote N-to-N+1 installation test requires real release artifacts and a configured repository.

## Actual Installation Gate

The Windows job runs both a standard temporary-directory scenario and a long-TEMP scenario with Unicode path components. Both must pass; the latter deliberately exceeds the old uninstaller's 260-character rollback path threshold. Evidence artifacts are named `desktop-installed-update-evidence-standard` and `desktop-installed-update-evidence-long-temp`, and include installer logs when present. For the legacy-path repair release, dispatch this gate separately with 0.1.5 and 0.1.6 as baselines.

The `Desktop Installed Update` workflow runs only when manually dispatched on an ephemeral GitHub-hosted Windows runner. Its script refuses to run locally or on a self-hosted runner because this test deliberately installs software and updates the Windows registry.

For a real release, build the candidate normally and use a lower-version installer with a configured updater as the baseline. Keep both installers, the candidate's blockmap and `latest.yml` in the draft release. Upload a second copy of the candidate's metadata named `update-test-latest.yml` for the test downloader. Dispatch the workflow with the draft release ID, baseline version and candidate target version. The workflow validates GitHub asset SHA-256 digests before execution.

The test installs the baseline, creates isolated test data, drives its update UI against a loopback server serving the candidate installer, and executes the unmodified NSIS launch with silent/restart flags. It checks the original Windows process exits, replacement of the installed binary, updated Windows registration, automatic restart, and preservation of the session, workspace file and settings. Only the update feed and native confirmation response are automated; installer spawning, installation, quitting and restarting are not mocked.

After the gate passes, remove the baseline installer, any baseline blockmap and `update-test-latest.yml` from this draft. Keep the three candidate release files listed above. Do not delete the baseline's original published release. The evidence records which two versions were installed. Unsigned early releases must explicitly disclose their unsigned status and still require a signing plan for wider distribution.

For testing a candidate's updater without a real next release, `node scripts/build-desktop-update-fixture.mjs` can instead create an unpublished higher-version fixture from the same application source. Neither build command publishes anything. In that variant the candidate is the baseline, and all higher-version fixture assets must be removed before publication. Never publish a fixture version as a product release.

### Public Feed Check

After publishing, run the read-only download check with an older packaged app:

```sh
node scripts/verify-desktop-published-update.mjs --baseline=C:/path/to/older/win-unpacked/Pi-Wm.exe
```

This launches an isolated profile, keeps the packaged GitHub provider and Electron HTTPS executor, and uses the app UI to discover and download the actual public release without a GitHub token or an external browser. It verifies the downloaded installer against the local candidate metadata. It prohibits installer execution and never overwrites the developer's installed app. Keep `test-results/desktop-published-update/report.json` alongside the Windows installation evidence; the two checks prove different parts of the update path.

## Legacy Uninstaller Path Compatibility

The 0.1.5/0.1.6 NSIS uninstaller stages old files beneath its temporary `old-install` directory. Deep dependency paths can exceed the legacy Windows path limit, causing `Rename` to fail and the uninstaller to abort with exit code 2. This is not necessarily a running-process problem. Fixing only the new application's JavaScript or pruning only the new package cannot repair files in an already-installed old version.

The custom NSIS include preserves electron-builder's process checks, then prepares the child environment immediately before invoking the old uninstaller and after any elevation. It passes the existing effective TEMP directory in Windows extended-path form (`\\?\...`, or `\\?\UNC\...` for UNC paths). The directory and its permissions do not change. No public short directory, drive mapping, global environment change, or registry long-path switch is used. The old uninstaller itself already supports this form, including its plugin loading and rollback operations.

TEMP and TMP are saved separately and restored before the new application is launched, on handled failures, and when the installer closes. Preparation failures, unreadable paths, unsupported source lengths, and reparse points stop before old-file removal. The original installed-file traversal still needs ordinary source paths that the legacy uninstaller can read; this fix does not claim unlimited installation-directory lengths.

Each installer attempt writes a local UTF-16LE diagnostic file under `%LOCALAPPDATA%\Pi-Wm\installer-logs`, preserving Unicode directory names. It records the package version, old installation root, longest path, preparation errors, old-uninstaller exit/launch result, and completion phase. A failure dialog points to that file. Logs from an old uninstaller do not expose its internal Windows error or exact failed-file trace, so an exit code alone must not be labelled as a file lock.

Staging removes type declarations from the generated application runtime, not from user projects. Staging and `afterPack` also reject packaged relative paths longer than 190 UTF-16 code units. The installer rejects installation roots longer than 68 code units before removing the old version, keeping the complete source path within 259 code units including its separator. Keep these two limits in sync. Actual path and native-runtime checks remain separate gates.

`apps/desktop/tests/installer-paths.test.mjs` compiles a registry-free legacy NSIS fixture using the installed builder's real recursive move/restore functions. It verifies the original failure, the parent-to-child compatibility fix, PowerShell/plugin startup, genuine locked-file rollback, cancellation, missing TEMP, reparse rejection, path normalization, and restoration of distinct TEMP/TMP values. It never invokes the product uninstaller or changes an installed application. This regression test does not replace the disposable Windows installation gate above.

## References

- electron-builder auto-update documentation: https://www.electron.build/auto-update.html
- GitHub Releases documentation: https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases
