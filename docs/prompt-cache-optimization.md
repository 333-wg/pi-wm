# 缓存优化实施说明

实施日期：2026-09-15。基于当前项目和实际安装的 Pi 0.84.3，继续落实 [第一轮调研](prompt-cache-review-2026-09-15.md)。

## 默认生效的优化

1. **上下文入选和渲染排序分离。** 相关性继续决定预算不足时选择哪些片段；入选后，stable、session、turn 均按作用域、必需性、固定优先级、类型权重和 ID 排序。相同内容不会仅因提问措辞不同而重新排列。文件更新、Skill 选择变化、预算裁剪仍如实改变内容。
2. **工具清单与 schema 稳定化。** 工厂统一按名称注册工具，递归规范化 schema 对象键顺序，不修改调用方对象。保留数组顺序、工具执行函数、参数准备函数与校验语义；重复工具名称显式报错。真实工具定义或权限变化仍然生效，不会为了保缓存继续暴露已撤销工具。
3. **日期后移。** 每次构建基础系统提示时，当前日期位于固定指令之后，避免跨日重新创建会话时从提示开头打断匹配。日期仍属于 system 提示，没有把权限或政策规则降级到用户消息。这不意味着跨日仍能命中全部历史；日期之后的部分依然可能重新计算。
4. **沿用持久会话标识。** 没有生成随轮次变化的新 cache key，也没有改成所有用户共用一个固定 key。继续由 Pi 的持久会话与各 provider 适配器处理。

这些优化在加载新代码的网关中生效。已经启动的网关需要重启；本次没有终止用户的运行中任务。排序或基础提示结构首次切换到新版本时可能发生一次缓存重建。

## 请求统计实时更新（2026-09-16）

此前上下文占用在每次模型响应结束时更新，但缓存面板只读取整轮结束后提交的 `usageByTurn[].requests`。因此长工具循环的首轮会出现上下文已有数值、缓存统计却显示暂无数据的情况，并不代表服务商没有命中缓存。

- Pi 在每次请求结束后通过 `onRequestUsage` 上报用量；网关先持久化 `session.request.usage.updated` 事件与快照，再发送小型增量事件给前端，不推送整份聊天记录。
- `usageRequests` 按会话内 `requestId` 去重；重复观察更新原记录，整轮结束补齐遗漏记录。它独立于原有费用账单，不改变预算、费用或工具账单的结算时机。
- 旧快照从已有逐请求汇总初始化，不从聊天内容或整轮总量推测缓存。分叉会话不继承源会话的缓存账单。
- 刷新、重连、后续失败或停止任务后，已经保存的请求用量仍可展示；尚未返回的用量不作估计。首次等待显示“等待首个请求用量”，明细标签为“最近完成请求”。
- SDK 仍会将缺失的缓存字段归一化为零，本次不声称能区分“未上报”和“明确零命中”。也没有请求缓存保温、修改缓存 key 或调用真实收费接口。

相关验证：`packages/orchestrator/test/request-usage.test.ts`、Pi adapter 请求回调测试、协议与 reducer 测试、前端用量测试，以及 `e2e/context-usage.spec.ts` 中的运行中刷新、停止和结束去重场景。`/demo-cache-live` 仅在 demo runtime 提供模拟数据。

已运行的网关需在任务结束后重启以加载新逻辑；无需修改 SQLite 表结构。本次未重启用户服务。

## 保留时长配置

新增可选网关变量，见 `.env.example`：

```dotenv
# 不配置时保留 Pi/provider 默认值及现有 PI_CACHE_RETENTION 行为。
WUMING_PI_CACHE_RETENTION=long
```

| 值     | 行为                                                                  |
| ------ | --------------------------------------------------------------------- |
| 未配置 | 不覆盖 SDK 默认策略，也不覆盖已有 PI_CACHE_RETENTION 环境配置         |
| short  | 显式向 Pi 指定短缓存偏好；具体 TTL 由 provider/model 决定             |
| long   | 显式向 Pi 指定长缓存偏好，由适配器按兼容配置映射                      |
| none   | 移除 SDK 的显式缓存控制和相应会话缓存 key；不能保证关闭服务商自动缓存 |

非法值在初始化时明确报错，不静默当成开启缓存。SDK 调用方也可通过 `createDefaultPiSessionFactory({ cacheRetention })` 配置相同策略。

当前安装版本中，支持长保留的 Anthropic 路径映射为 1h，支持长保留的部分 OpenAI 路径映射为 24h；明确声明 `supportsLongCacheRetention: false` 时不发送长 TTL。第三方接口未声明能力时，SDK 可能采用自己的默认能力判断，所以仍需针对真实端点核实。较新 OpenAI 模型的缓存字段有代际差异，不能把该选项当成所有模型通用的 24 小时保证。

没有为用户全局强制 long，没有修改真实密钥或模型配置，也没有发送用于保持缓存活跃的收费请求。它影响普通 agent 请求；Pi 自身的压缩请求仍使用其专门策略。

## 已验证

`packages/pi-adapter/test/prompt-cache-wire.test.ts` 使用本地 HTTP 服务接收真实 Pi SDK 序列化后的请求，并返回脚本化 SSE。覆盖 3 种协议、10 组配置：Chat Completions、Responses、Anthropic Messages，以及默认/short/long/none 和不支持长保留的情况。

- 不同提问、同一批上下文时，真实请求中的系统提示与工具定义完全一致。
- 关闭再恢复同一会话、颠倒工具注册顺序和 schema 对象键顺序后，请求前缀与已有会话标识仍稳定。
- 历史消息保持追加；Anthropic 自动移动的 cache_control 标记与实际提示内容分开比较。
- 工作区上下文真正更新时，新内容进入下一次请求，没有读取被冻结的旧版本。
- 支持或不支持长保留时，对应参数正确发送或省略。
- 缓存读取、写入、普通输入与输出经 SSE 解析后的映射正确。
- 原有首次强制工具调用仍只作用于首次请求，不被缓存选项覆盖。

相关及扩展回归命令：

```sh
npx vitest run packages/pi-adapter/test packages/context-engine/test packages/orchestrator/test/context-usage.test.ts apps/web/test/context-usage.test.ts scripts/lib/provider-file-round-trip.test.ts scripts/lib/provider-skill-round-trip.test.ts scripts/lib/model-request-pacer.test.ts
npm run check
npm run build
```

测试服务中的缓存数字是模拟返回值，只证明协议映射，不是实际服务商的命中率或费用测量。

本次最终结果：上述扩展回归 13 个文件、147 项测试全部通过；`npm run check` 的 12 个工作区及测试类型检查、E2E 类型检查和对比度检查通过；`npm run build` 通过，只有现有的大 chunk 提示。修改范围内的 oxlint 与 `git diff --check` 通过。这不是运行了整个仓库的全部行为测试。

## 没有冒进的改动

- 没有冻结 AGENTS.md、README、Skill 或权限状态，也没有为了命中率保留过期政策。
- 没有把政策整体搬入普通用户消息。Pi 的自定义消息最终会转成 user 角色；完整的增量上下文设计还需要同时解决权限层级、撤销、历史残留和压缩后的恢复，不能只移动字符串。
- 没有改动预算相关的选择、必需片段失败条件、截断规则和自动压缩机制。
- 没有宣称真实命中率提升百分比。下一步应在用户实际端点上，固定模型、任务和请求间隔，分别测量首次请求、正常续聊、空闲恢复、Skill 变动和压缩后的 token 加权命中率、成本与首 token 延迟。

## 调研依据

2026-09-15 重新读取了 OpenAI 与 Claude Code 官方文档，并核对安装依赖的 provider 源码。核心原则是稳定前缀和追加历史；延长 TTL 不能补救前部内容反复变化。

- [OpenAI Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)
- [How Claude Code uses prompt caching](https://code.claude.com/docs/en/prompt-caching)
- [Pi AI README](https://github.com/earendil-works/pi/blob/main/packages/ai/README.md)，与项目安装的 `node_modules/@earendil-works/pi-ai/dist/api/` 源码对照。
