# Official Account Login

The independent Settings > Official accounts page supports Claude, ChatGPT and Grok
subscription accounts, plus DeepSeek platform account authorization. API-key services remain under Settings > Models. No API-key
service needs to be configured before signing into an official account. Account management is
available only in `local_device` deployment mode and requires a local owner connection.
Use `npm run local` or the desktop app. Server deployments do not advertise this capability.

## 登录前风险确认

每次点击 Claude、ChatGPT 或 Grok 的「登录」时，先显示对应提供商的风险确认框。
只有点击「我已了解风险，继续登录」后才发起授权；点击取消或按 Escape 不发送登录请求，
也不打开授权页面。确认不会跨提供商或跨登录尝试保存，ChatGPT 的浏览器/设备码方式均需确认。
退出登录、取消已经开始的授权和手动回填流程保持不变。

- **Claude：较高风险**，提示 Anthropic 风控可能导致授权撤销、账号限制或封禁。
- **ChatGPT：相对较低风险，但并非无风险**，提示 ChatGPT / Codex 订阅授权仍可能被限流、撤销、限制或封禁。
- **Grok：中等风险**，提示 xAI 风控可能导致授权失效、账号限制或封禁，订阅权益不保证可在第三方使用。

这些定性等级参考 [cc-haha #1526](https://github.com/NanmiCoder/cc-haha/pull/1526)，
不是服务商官方评级或封禁概率。Pi-Wm 是第三方应用，官网授权不代表官方认可或账号安全保证；
具体限制以服务商现行条款和风控策略为准。此功能只增加界面确认，不修改 OAuth 协议、请求身份或凭据存储。

## DeepSeek 开放平台账号

在“官方账号 → DeepSeek → 登录”阅读计费与第三方接入提示，确认后在系统浏览器完成授权。无需 API Key，调用使用开放平台余额，不是免费网页版聊天额度。

- 使用 S256 PKCE 和随机 state，临时回调端口只监听 `127.0.0.1`；错误 state、重复参数及已消费回调不接受。等待授权最多十分钟，服务端更短的期限优先；取消、重启授权与网关退出会关闭监听，迟到响应不得保存凭据。
- 令牌仅保存到现有加密账号文件。模型调用固定为 `https://api.deepseek.com/anthropic/v1/messages`，使用 `x-dsh-auth-token`，移除 API-key/Bearer 身份并拒绝重定向。不采集浏览器 Cookie，不回退到其他服务商密钥。
- DeepSeek 账号令牌没有公开的刷新流程。SDK 的 OAuth 存储结构只作适配，内部 `refresh` 为非秘密占位、`expires` 为不自动刷新的哨兵值；不会向界面声称具体有效期。401 提示退出后重新登录，其他网络错误不清除凭据。
- 退出先删除本机凭据，再尽力调用平台登出；远端失败不会恢复本机登录。不会中断已发出的请求。
- 首版使用固定目录 `deepseek-flash`、`deepseek-v4-pro`，提供文本、工具调用和 off/low/high/max 思考。输出上限暂取 32,768；未接动态 `/models` 目录、图片/Files 或余额查询。模型权限以账号实际返回为准；价格未知暂按目录零值记录，**费用统计不代表免费或真实账单**。
- 协议已对照 [DeepSeek 官方账号实现](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/credentials/deepseek-account-platform) 和 [官方模型传输说明](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/llm/llm-deepseek)。cc-haha 仅作为交互参考，未复制其当前自定义许可证下的实现。

回归使用模拟平台响应和真实本机回调、真实 Pi SDK 流式传输，不调用付费模型。实际账号完成授权、账号权限和余额计费仍须用户实测。

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

Official provider IDs are `official-claude`, `official-chatgpt`, `official-grok`, `official-deepseek`.
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
for Claude/ChatGPT/Grok it does not revoke the grant at the provider or interrupt an already dispatched request. DeepSeek additionally attempts remote logout as described above.

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
