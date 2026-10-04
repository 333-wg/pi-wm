# Terminal

The Terminal tab uses a real PTY/ConPTY over the authenticated Wuming WebSocket.
It is not a textarea-backed command simulator.

## Desktop and session behavior

点击“终端”或执行 `/terminal` 会在右侧展开终端面板，不再替换当前对话或清空草稿。
桌面默认仅占部分宽度；拖动左侧分隔线可左右调节，也可聚焦分隔线后用左右方向键调整，
双击分隔线恢复默认宽度。窄屏使用右侧抽屉，保留原页面，避免将对话压缩得过窄。
再次点击“终端”或点击“收起终端面板”只隐藏面板，命令继续运行；终端工具栏里的
“关闭终端”仍会确认并结束进程。切换工作台页面会收起面板，重新打开后保留原终端。
终端、浏览器预览和运行详情面板互斥显示，避免挤占对话空间。

The terminal and chat share the gateway URL/subprotocol resolver. Desktop windows
use the loopback WebSocket address supplied by the desktop bridge, never the
`wuming://app/` page host. Browser deployments use their HTTP(S) origin.

There is one terminal per visited workspace in the current application window.
Switching workbench views or workspaces hides the renderer without disposing the
Shell or changing its directory. Closing or restarting requires confirmation.
Changing the Shell selection applies to the next new/restarted terminal, not the
running process. The directory displayed is the initial directory, not a claim
to track subsequent `cd` commands. Agent command tools remain separate.

Connection loss triggers up to four automatic retries with a 12-second handshake
deadline, followed by a manual retry action. Reconnection attaches to the same
terminal ID and replays only missing output, using a bounded-history reset if the
replay window was exceeded. A missing process is reported instead of silently
replaced. Disconnected terminals have an idle grace period; application/window
teardown closes connected terminals and the desktop gateway disposes its own PTYs
on shutdown. Reloading the page does not restore terminal identities.

Windows detects PowerShell 7, Windows PowerShell, CMD and Git Bash, in that default
preference order. POSIX prefers the user's login Shell. Clients can request only
registered Shell IDs, not arbitrary executable paths. Container mode exposes only
the container Shell. No WSL profile or Agent takeover is introduced here.

## Protocol

After the normal `hello` frame, `terminal.shells` lists available Shell IDs and a
default. The browser sends `terminal.create` with an optional `shellId` and a
client-owned terminal id, workspace id, and bounded rows/columns. Input,
resize, attach, and close are separate strict protocol frames. The gateway
returns `terminal.ready`, ordered `terminal.output` frames, `terminal.exit`, and
explicit `terminal.error` frames. A bounded UTF-8 output buffer supports attach
replay without persisting terminal secrets to SQLite.

`terminal.ready` also includes the selected Shell ID and initial directory.
Capacity failures use `capacity_reached`, distinct from a duplicate terminal ID's
`conflict`, so clients cannot enter a create/attach retry loop at capacity.

## Verification

- `npx playwright test e2e/terminal-session.spec.ts e2e/terminal.spec.ts`
- `npm run build`, then `node scripts/verify-desktop-terminal.mjs`

The desktop verification uses an isolated temporary profile and the demo runtime;
it exercises the real terminal UI under the custom desktop origin.

Terminal ownership is `(principalId, workspaceId, terminalId)`. Every input,
resize, attach, and close checks that ownership; disconnecting a browser only
detaches its listener, allowing a short-lived reconnect. Idle terminals are
reaped after `WUMING_TERMINAL_IDLE_TIMEOUT_MS`, and the gateway caps concurrent
terminals with `WUMING_MAX_TERMINALS`.

## Execution modes

- `WUMING_TERMINAL_MODE=host` starts a PTY in the workspace. The child receives
  a minimal environment and does not inherit bearer tokens, model credentials,
  agent directories, or arbitrary gateway configuration.
- `WUMING_TERMINAL_MODE=docker` starts `/bin/sh` inside a digest-pinned image
  with no network, read-only root, dropped capabilities, no-new-privileges,
  bounded CPU/memory/PIDs, a bounded tmpfs, and the workspace as the only bind
  mount.
- `WUMING_TERMINAL_MODE=disabled` removes the capability and the UI reports a
  clear disabled state.

Host mode is intended for a trusted loopback development gateway. Public or
multi-tenant deployments should use Docker mode or leave terminal access
disabled until a stronger identity and policy layer is configured.
