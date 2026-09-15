# 缓存命中率审查与改进

> 后续实施：第二轮优化已完成所有上下文层的稳定排序、工具/schema 规范化、日期后移与保留策略配置。当前行为及测试见 [缓存优化实施说明](prompt-cache-optimization.md)。以下保留第一轮调研时的发现和验证记录。

调研日期：2026-09-15。审查对象：当前工作区以及实际安装的 `@earendil-works/pi-ai` / `pi-coding-agent` 0.84.3。保留工作区已有改动，没有调用真实收费模型做 A/B 测试。

## 结论

项目不是“没开缓存”：已经继承 Pi 的 provider 缓存支持，有缓存 token 采集、持久化和稳定前缀设计。但还不是完整的缓存命中率优化方案。每轮重新组装系统上下文，仍可能使后面的长会话失去缓存复用机会。

本次完成两项改动：

1. 输入框“上下文”及运行面板原有的原生悬浮提示，增加最近一次已记录模型请求、会话累计的输入 token 命中率、缓存读取、缓存写入、输入总量与请求数。未收到逐请求数据时明确显示暂无数据。
2. 修复 `stable` / `session` 上下文片段的排序：内容和入选集合不变时，不再因为新问题的相关性分数变化而改变发给模型的文本顺序。相关性仍用于预算不足时选择片段；`turn` 片段保留原有排序。

这只能证明减少了一类不必要的前缀变化，不能据此声称线上命中率提升了某个百分比。

## 统计口径

```text
输入总量 = 未缓存输入 + 缓存读取 + 缓存写入
输入 token 命中率 = 缓存读取 / 输入总量
会话命中率 = 所有已记录模型请求的缓存读取之和 / 输入总量之和
```

- 不是“多少次请求命中”的请求命中率，也不是各次命中率的算术平均。
- 输出 token 不进入分母，缓存写入不是缓存命中。
- 仅汇总 `usageByTurn[].requests`，不把媒体生成、工具账单和没有逐请求明细的历史汇总混入模型请求统计。会话统计包含曾经使用的其他模型，提示中明确标注。
- 输入 token 为零时显示暂无输入用量，不计算 NaN，不把未知伪装成 0%。
- 切换模型后不将旧模型请求标为当前模型请求；会话历史累计仍保留。
- 上下文压缩后的占用估算与历史缓存账单相互独立。压缩后的新前缀是否命中，只能等下一次接口返回。
- 目前协议把缓存数字规范为必填数值，无法区分“接口明确返回 0”与“接口没返回而被归一化成 0”。提示说明这一限制，没有据此推断缓存已关闭。
- 没有服务端缓存库存、剩余 TTL 或精确节省金额的数据，因此不显示虚构的缓存容量、热缓存状态或节省费用。

## 项目已有能力

| 能力                    | 本地依据                                                                                                         | 评价                                                                                            |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 稳定系统提示            | `packages/pi-adapter/src/system-prompt.ts`、`default-factory.ts`                                                 | 自定义系统提示、会话恢复；不是每个请求都新建一段会话                                            |
| 缓存友好的上下文分层    | `packages/context-engine/src/context-engine.ts`                                                                  | 基础提示在前，之后是 stable、session、turn；本次修复前两类的相关性排序漂移                      |
| 上下文前缀摘要          | `ContextPlan.cachePrefixDigest`                                                                                  | 是本地计划审计摘要，不是服务商缓存是否存在的证明，也不是直接发送的 `prompt_cache_key`           |
| 实际缓存用量            | `packages/pi-adapter/src/pi-agent-runtime.ts` 的 `mapUsage` 与 assistant `message_end`                           | 将 Pi 的 input/cacheRead/cacheWrite/output 映射并保存到逐请求记录                               |
| Anthropic 缓存断点      | 安装依赖的 `pi-ai/dist/api/anthropic-messages.js`                                                                | 按 provider 兼容性在系统提示、工具和最近用户消息上设置缓存控制；默认 short，支持按条件使用 long |
| OpenAI / Codex 会话标识 | 安装依赖的 `pi-coding-agent/dist/core/sdk.js`、`pi-ai/dist/api/openai-responses.js`、`openai-codex-responses.js` | SDK 把持久会话 ID 交给 agent；相应 provider 构造缓存 key                                        |
| 第三方用量兼容          | 安装依赖的 `pi-ai/dist/api/openai-completions.js`                                                                | 识别 nested cached_tokens、DeepSeek prompt_cache_hit_tokens、顶层 cached_tokens 等形式          |

## 仍存在的风险

### 1. 动态上下文位于系统提示内

`PiAgentRuntime.#assembleContext` 将工作区内容、Skill 等片段组成 `context.systemPrompt`；`executeTurn` 再调用 `session.setSystemPrompt`。执行结束后恢复之前的系统提示，下轮重新组装。

`apps/gateway/src/main.ts` 每轮读取 AGENTS.md、`.wuming/context.md`、README.md；Skill 目录和媒体策略也作为上下文进入系统提示。显式选择的 Skill 全文在 `pi-agent-runtime.ts` 标为 turn。它们的增删、文本更新、预算截断以及 turn 片段相关性重排，均可能改变位于会话历史之前的内容。

因此，即使 `cachePrefixDigest` 没变，也不代表整个最终系统提示、更不代表包含工具与历史的完整请求前缀没变。当前 stable 摘要只覆盖 stable 片段，不包含 session 和 turn 内容。

### 2. 工具定义与顺序缺乏专门的缓存回归检查

`default-factory.ts` 接收注册顺序的工具，并用它们构造提示与 provider 请求。工具名、描述、schema、顺序或 MCP 可用性发生变化时需要重新验证缓存效果。不能仅因为服务商提供缓存 key，就认为这一部分稳定。

本次没有发现足以证明“当前每轮工具顺序一定随机”的证据；这是待检测的风险，而不是已证实的线上故障。

### 3. 缓存参数不是所有 OpenAI-compatible 接口都通用

安装版本中 Chat Completions 的 key/retention 发送有 URL 和 compat 条件；Responses 和 Codex Responses 的处理又不同。`PI_CACHE_RETENTION=long` 在受支持的 Anthropic 路径通常映射 1h，在部分 OpenAI 路径映射 24h，不应理解为所有 provider 都有同样的缓存机制。

第三方中转是否转发参数、是否使用固定后端、是否完整返回 usage，需要对实际端点抓取脱敏请求并验证。不能只看请求协议名称判断。

### 4. 缺乏失效原因与真实 A/B 数据

已有费用与用量记录，但没有完整的“首次冷请求 / 过期 / 系统提示改变 / 工具变化 / 模型变化 / 压缩后预期重建”的诊断。当前也没有足够数据证明用户实际配置的端点已经达到某个命中率。

## Pi、Claude Code、Codex 对照

### Pi

Pi 将缓存控制放在 provider 适配层，应用通过稳定 `sessionId` 与 `cacheRetention` 使用它。项目已经接入这套能力，没有必要再在上层重复实现同一套缓存字段。

实际应借鉴的是保留会话历史、避免反复改变前部提示、尊重 provider 兼容配置。上游也提供会话亲和性配置，但亲和性不等于命中保证。依据：[S1] 及本地安装源码。

### Claude Code

官方文档明确采用“前部稳定，后部追加”的组织方式：系统提示与工具、项目上下文、会话历史。Plan mode 与 Skill 加载可通过追加会话消息保持已有前缀，项目上下文刷新和压缩则是明确的缓存重建边界。

它还区分普通缓存未命中与压缩等导致的预期重建，并利用 API 返回的 cache read / creation token 展示会话统计。这比只显示累计 token 更适合排查问题。依据：[S2]、[S3]。

Anthropic API 支持自动缓存和显式断点，5 分钟 / 1 小时保留策略有不同写入成本；适用阈值和读取价格需按模型核对。延长 TTL 只能缓解空闲过期，不能修复前缀变化。依据：[S4]。

### Codex / OpenAI

本项目的 Codex 接入路径已通过 Pi 的 `openai-codex-responses` 使用会话缓存 key；这不是在重新实现 Codex 桌面端。

OpenAI 官方文档强调保持工具定义和历史稳定、动态内容靠后、追加而不重写旧消息。当前文档还区分模型代际：GPT-5.6 之前的模型使用稳定 key 帮助路由；GPT-5.6 及之后由服务端自动处理路由，key 主要可用于隔离缓存核算。缓存保留参数也有代际差异，不能把 `prompt_cache_retention: "24h"` 当成所有模型的通用优化。依据：[S5]。

本次未核实 Codex 桌面端全部内部缓存策略，不将 API 文档的通用机制说成桌面端的已验证实现。

## 后续优先级

1. **固定相同入选内容的序列化顺序。** 本次已修复 stable/session 排序。下一步为实际 provider payload 增加工具、system、历史的独立摘要，定位第一个发生变化的层；不记录敏感正文。
2. **拆开稳定策略和动态状态。** 将媒体固定规则与当前配置分离，稳定 Skill 目录的表示；动态 Skill 指令、文件变化通知尽量作为有正确权限层级的增量消息追加。必须同步设计撤销、过期与压缩恢复，不能为缓存忽略权限或配置变化。
3. **按 provider/model 开放保留时长。** 只在兼容能力明确时生效，保留回退行为；评估额外缓存写入成本，而不是全局强制 long。
4. **增加可解释诊断。** 展示最近一次变化原因与前缀摘要，分开首次请求、正常续聊和压缩后的重建；需要新增请求时间、缓存字段是否上报等元数据，现有数值无法可靠反推热缓存状态。
5. **做真实端点 A/B。** 相同模型、工具集、任务输入和调用间隔，比较多轮 token 加权命中率、总成本、首 token 延迟及正确性。冷启动、续聊、超时后恢复、加载 Skill、改配置、压缩分别统计。不要为了“保温”定时发送收费请求，也不要为了提高比例无意义填充提示。

## 验证

- 相关单元测试：23 项通过，覆盖统计公式、未知值、历史模型、原有压缩占用语义以及 stable/session 排序。
- `npm run build` 通过，保留现有大 chunk 提示。
- `npm run check` 通过：12 个工作区及测试代码类型检查、E2E 类型检查、亮色 76/76 和暗色 71/71 对比度检查全部通过。
- `npx playwright test e2e/context-usage.spec.ts` 通过，覆盖桌面/移动、悬浮提示属性、键盘焦点、压缩、刷新、模型切换和 320px 布局。原生浏览器 title 气泡不在页面截图内，测试验证其真实 DOM 属性，不声称截到了原生气泡。
- 扩大到 Pi adapter、orchestrator 上下文和本次改动的测试：114 项通过、1 项失败。失败在 `packages/pi-adapter/test/default-factory.test.ts:146`，仍期待 `You are Wuming (无名)`；工作区已有系统提示改名为 `You are Pi-Wm`。本次没有修改这两个文件或回退已有改名。
- 未进行真实收费 API 命中率基准，不报告未经测量的性能提升。

## 来源

以下来源均于 2026-09-15 联网读取。搜索工具未返回可用结果，改为直接读取官方文档与上游原始文档，并核对本地安装源码。

- [S1: Pi AI 上游 README](https://github.com/earendil-works/pi/blob/main/packages/ai/README.md)
- [S2: How Claude Code uses prompt caching](https://code.claude.com/docs/en/prompt-caching)
- [S3: Claude Code costs / prompt cache statistics](https://code.claude.com/docs/en/costs)
- [S4: Claude API prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- [S5: OpenAI API prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)
