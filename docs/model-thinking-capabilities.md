# Model Thinking Capabilities

Reviewed on 2026-09-16. This is adapter policy, not a promise that every relay implements every upstream capability.

## Resolution Order

1. Explicit per-model override.
2. Endpoint capability declarations.
3. Documented corrections and exact installed-catalog entries.
4. For an unlisted GPT/o/Claude release, inherit the complete thinking profile of the newest preceding member of the same product line.
5. Unrecognized aliases remain configurable through the manual override; an arbitrary display name is not evidence of provider capabilities.

GPT base, Pro, Mini, Nano, Codex, Codex Spark and Chat are separate lines. Claude Opus, Sonnet and Haiku are separate lines. A versioned relay alias can inherit its matching release. An older alias must not inherit a newer release's capabilities. GPT-6 Astra's documented profile has low, medium, high, xhigh and max, without off/minimal.

Claude inheritance includes adaptive versus budget-based thinking for the Messages API. The OpenAI-compatible adapter receives effort parameters instead. Only thinking-related compatibility flags are inherited, never another model's fallback routing or tool declarations.

## Domestic Providers

Keep exact provider-specific profiles rather than assigning GPT's menu to every reasoning model:

| Model                                      | Control                            | Available UI levels     |
| ------------------------------------------ | ---------------------------------- | ----------------------- |
| DeepSeek V4 Flash / Pro and deepseek-flash | thinking.type + reasoning_effort   | off, low, high, max     |
| Kimi K2.6                                  | thinking.type                      | off, on                 |
| Kimi K3                                    | reasoning_effort, always reasoning | low, high, max          |
| GLM 4.7                                    | thinking.type                      | off, on                 |
| GLM 5.3                                    | thinking.type + reasoning_effort   | low, high, max          |
| Qwen 3.7 Plus                              | enable_thinking                    | off, on                 |
| Qwen 3.8 Max                               | enable_thinking + reasoning_effort | off, low, medium, xhigh |

Qwen native catalog entries take priority over third-party aggregators so their enable_thinking wire format is not lost. Qwen's token-budget capability is distinct from effort; this UI retains off/on for budget-only Qwen profiles instead of inventing effort values.

## Primary Sources

- OpenAI: https://developers.openai.com/api/docs/models/gpt-6-astra
- Anthropic: https://platform.claude.com/docs/en/build-with-claude/effort
- Anthropic: https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking
- DeepSeek: https://api-docs.deepseek.com/guides/thinking_mode
- Kimi: https://platform.kimi.com/docs/guide/use-reasoning-effort
- Z.ai: https://docs.z.ai/guides/capabilities/thinking-mode
- Alibaba Cloud: https://help.aliyun.com/zh/model-studio/deep-thinking

Unit tests cover precedence and family inheritance. Wire tests capture adapter payloads before networking, and browser tests verify menu options, manual overrides and persistence. None of these tests certify a user's third-party endpoint.
