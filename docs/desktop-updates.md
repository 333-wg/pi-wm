# Desktop Updates and GitHub Releases

## User Experience

- Desktop only: Settings > About & updates, plus the application menu.
- An available update adds a quiet shortcut above Settings in the main sidebar.
- Check at startup (after 20 seconds) and every six hours when automatic checking is enabled.
- Checking does not download. Downloading does not install. Quitting normally does not install.
- The user explicitly chooses Download, then Restart & install and confirms in a native dialog.
- A 24-hour reminder deferral and the automatic-check preference are stored in the user's existing profile.
- The main process asks the local service about queued/running operations across all sessions, in-flight requests, recovery, automation ticks, and open terminals. Unknown/busy status blocks installation. It checks again after confirmation, gates new requests, then stops the service before invoking the installer.
- Update failure does not remove the installed application or user data. The existing Wuming profile and application ID remain unchanged.
- Development and unconfigured builds report their status explicitly and do not contact a release server.

## Choose a Repository

Use a **public release repository**. It may be separate from the private source repository; publishing installation binaries does not require publishing source code. No GitHub access token belongs in the desktop package.

The update repository is baked into each build. Choose a stable owner/repository before distributing the first update-enabled installer. The older 0.1.2 builds without this feature need one manual installation to acquire the updater.

## Build on Windows x64

Use Node 22.19+ (Node 22), as required by the existing desktop runtime packaging.

1. Increase the desktop version using npm so the lockfile also stays in sync:

   npm version 0.1.3 --workspace @wuming/desktop --no-git-tag-version

2. Set the public release repository in PowerShell. Replace the example before running:

   $env:WUMING_UPDATE_REPOSITORY = 'YOUR_OWNER/YOUR_RELEASE_REPOSITORY'

3. Run the checks and build:

   npm run check
   npm run test:desktop
   npm run desktop:dist

The build script validates the repository and injects both electron-builder's GitHub publish configuration and the desktop's repository metadata. It always uses publish=never, even if GH_TOKEN is present. Without WUMING_UPDATE_REPOSITORY, it produces an explicitly unconfigured build.

Before uploading, verify release/win-unpacked/resources/app-update.yml points to the expected public repository. Do not edit generated checksums or rename the installer after building.

## Publish a Release

Create a draft GitHub Release with a version tag matching the desktop version, for example v0.1.3. Attach the complete generated update set:

- Pi-Wm-0.1.3-Setup-x64.exe
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

## References

- electron-builder auto-update documentation: https://www.electron.build/auto-update.html
- GitHub Releases documentation: https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases
