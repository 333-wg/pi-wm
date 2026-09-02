# Terminal

The Terminal tab uses a real PTY/ConPTY over the authenticated Wuming WebSocket.
It is not a textarea-backed command simulator.

## Protocol

After the normal `hello` frame, the browser sends `terminal.create` with a
client-owned terminal id, workspace id, and bounded rows/columns. Input,
resize, attach, and close are separate strict protocol frames. The gateway
returns `terminal.ready`, ordered `terminal.output` frames, `terminal.exit`, and
explicit `terminal.error` frames. A bounded UTF-8 output buffer supports attach
replay without persisting terminal secrets to SQLite.

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
