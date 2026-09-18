# Desktop Browser Preview

The desktop toolbar's globe button opens a browser next to the conversation. This is an Electron WebContentsView, not an iframe: local pages render at their real origin, including sites that forbid framing.

## Supported

- Task-owned tabs, an address bar, back/forward, reload/stop and load-error retry.
- Main-frame SPA/hash routes update the address even while subresources are loading. Opening the current pending destination reuses its task's tab without restarting the load; another task's tabs remain separate.
- Address shorthand supports domain ports (HTTPS) and loopback addresses (HTTP), including queries and fragments. Explicit HTTP(S) schemes are preserved.
- Stopping an uncommitted navigation keeps the last page visible, or returns to the new-tab screen when there is no committed page. Cancelled and superseded load failures do not replace the current page with an error.
- Popup URLs open as sibling tabs in their originating task.
- Resizable split view, narrow-window overlay, 390px viewport mode and page zoom.
- Developer tools and opening the current page in an external browser.
- Ctrl/Cmd+L, Ctrl/Cmd+R, Ctrl/Cmd+W and Alt+Left/Right while a page is focused.
- Ctrl/Cmd+Plus/Minus/0 and native zoom requests use the preview zoom controls, bounded to 50%-200%. The toolbar also displays non-preset native factors.
- Successful preview_start calls open the local page. Tool results provide a reopen button; ordinary localhost links in the conversation open inside the app.
- Closing the panel hides pages without discarding them. App dialogs temporarily hide native pages so approvals and settings remain accessible.

## Session And Security Boundaries

Cookies and site storage use a persistent partition derived from the workspace ID. Tasks in a workspace share that login session; different workspaces do not. Persistent cookies survive app restart, subject to the website's own expiration policy. Tabs themselves are not restored across app restarts.

Preview pages have sandboxing and web security enabled, Node integration disabled, no preload bridge, and no access to the workbench's authenticated API proxy. Only HTTP(S) URLs without embedded credentials are accepted. Privileged schemes, remote webviews and permission requests such as camera/microphone are blocked. Browser IPC only accepts the application's trusted main frame. A tab cannot be controlled through another task's owner identity. There is a 24-tab application limit.

## Known Limits

The existing Agent browser tools still use their independent automation browser. They do not share this preview's pages or cookies. This feature does not import Chrome/Edge logins. Popup URLs become isolated tabs, so OAuth flows that specifically require window.opener may need the external browser. Device mode changes viewport width; it does not emulate a phone user agent or touch hardware. The web-only edition does not expose this native-browser feature.

The Agent is instructed to leave preview services running for user review. Existing preview idle timeout and application shutdown still stop those services.

## Verification

Run npm run verify:desktop:browser for the real Electron smoke suite. It uses a disposable application profile and a loopback fixture, never real accounts or model providers. It checks SPA/hash history while subresources are still loading, subframe route isolation, pending-address tab reuse, stopping slow loads with/without a committed page, native zoom shortcuts, non-preset zoom display, rendering of frame-denied pages, popup tabs, login persistence after restart, workspace isolation, responsive geometry, modal occlusion and errors. Screenshots are written under test-results/desktop-browser.

Run `node scripts/verify-desktop-browser.mjs --packaged="release/win-unpacked/Pi-Wm.exe"` against a packaged build. The verifier relocates the app outside the checkout and removes developer runtime paths before running the same browser checks with a temporary profile. Packaged screenshots are written under `test-results/desktop-browser-packaged`.

`node scripts/verify-desktop-installer.mjs "path/to/Pi-Wm-Setup-x64.exe"` extracts an actual installer and runs the workflow and browser checks against its payload. It does not execute NSIS or modify installed apps, registry entries, or real user profiles.

Focused tests: node --test apps/desktop/tests/browser-preview.test.mjs and npx vitest run apps/web/test/browser-preview.test.ts packages/pi-adapter/test/system-prompt.test.ts.
