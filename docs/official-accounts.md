# Official Account Login

The independent Settings > Official accounts page supports Claude, ChatGPT and Grok
subscription accounts. API-key services remain under Settings > Models. No API-key
service needs to be configured before signing into an official account. Account management is
available only in `local_device` deployment mode and requires a local owner connection.
Use `npm run local` or the desktop app. Server deployments do not advertise this capability.

## Implementation

The cc-haha OAuth services were reviewed as a functional reference:
https://github.com/NanmiCoder/cc-haha

The installed `@earendil-works/pi-ai` 0.84.3 already implements all three OAuth
providers and the corresponding inference protocols. Wuming uses those native
implementations instead of copying cc-haha's Anthropic-to-Responses proxy or its
plaintext credential files. No cc-haha source files were copied.

- Claude: PKCE browser authorization, local callback on port 53692, manual full
  callback URL fallback; native Anthropic Messages with OAuth request handling.
- ChatGPT: PKCE browser authorization on port 1455 or device-code authorization;
  native Codex Responses, not the metered OpenAI API-key endpoint.
- Grok: device-code authorization through xAI; the SDK's native xAI Responses
  provider. This differs from cc-haha's browser callback and CLI-proxy route.

Model availability comes from the installed SDK catalog and does not guarantee
that a particular subscription has access to every listed model. Account plans,
provider restrictions and authorization endpoints can change. Network failures,
quota errors and revoked credentials surface through the existing runtime error path.
An expired token is refreshed by the SDK at request time; a failed refresh retains
the credential for retry. Sign out and sign in again if authorization is revoked.

## Credentials And Lifecycle

`official-accounts.enc` under `WUMING_DATA_DIR` is AES-256-GCM encrypted with a
SHA-256-derived key from the existing model configuration secret (`custom-models.key`
or `WUMING_MODEL_CONFIG_KEY`). The key remains on the local machine; this is not a
replacement for OS account protection or full-disk encryption.

Official provider IDs are `official-claude`, `official-chatgpt`, `official-grok`.
Custom model registration cannot use this namespace. Secrets never enter the
WebSocket results, browser storage, model catalog, or Pi's plaintext `auth.json`.
Runtime instances share one credential store, serializing rotation and logout.
Writes use a uniquely named temporary file and atomic rename; failed persistence
does not publish a new in-memory credential.

Only HTTPS authorization links on a provider allowlist are exposed. Browser
callbacks use the SDK's state/PKCE checks; manual input additionally requires the
complete URL with matching state. Pending attempts expire after ten minutes.
Restarting authorization, cancelling, signing out, and gateway shutdown abort the
pending flow and close its callback listener. Sign-out deletes the local credential;
it does not revoke the grant at the provider or interrupt an already dispatched request.

The frontend keeps a visible authorization link if automatic browser opening is
blocked. The desktop shell opens that link in the system browser. ChatGPT's device
mode is an alternative when the fixed callback port is already occupied.

## Verification

Unit tests cover encryption/reload, invalid storage, serialized refresh/logout,
manual state mismatch and replay, timeout/cancel, device-code prompts, error
redaction, model availability, and runtime credential resolution. Gateway tests
cover owner-only management and model selection. Playwright covers the actual
local Claude start/cancel flow and responsive settings at desktop/mobile widths.

Tests do not use real subscription accounts. Final authorization and a paid or
quota-consuming model request must be verified with the user's own account.
