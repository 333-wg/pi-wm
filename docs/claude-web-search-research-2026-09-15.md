# Claude 联网搜索调研

核验日期：2026-09-15。仅调研，不修改业务代码或凭据。官方页面已通过本机 HTTP 实际读取；内置 web.run 未提供可复用的正文和引用条目，本文不依赖其空返回。

## 1. 核心结论

Claude 也采用“模型决定查什么，工具执行检索，模型继续阅读和回答”的模式。必须区分 Claude 网页产品、Claude Code、本机自定义工具和 Claude API 的服务端工具。模型名字相同，不代表搜索后端和能力相同。

- Claude 网页版提供 Web search 开关，可结合多个来源回答，支持直接 URL 的内容读取和引用。[S1]
- Claude Code 的 WebSearch 查询 Anthropic 的搜索后端，返回标题和 URL；选中页面后用 WebFetch 读取。内置搜索后端不可配置，替换供应商需增加 MCP 搜索工具。[S2]
- Claude API 提供 Anthropic 执行的服务端 web_search / web_fetch，开发者在请求中启用，不是自己执行 Bing 网页抓取。[S3-S4]
- 自配 MCP 搜索服务是另一条路线，可以接 Brave 等服务；不能将该路线混同于全部 Claude 产品的默认后端。[S5]

## 2. Claude Code 的实际链路

```text
用户需求
 -> 模型生成查询
 -> WebSearch 调用 Anthropic 搜索后端
 -> 返回候选标题及 URL
 -> 模型选择候选
 -> WebFetch(URL, 提取目标)
 -> HTML 转 Markdown，页面长度限制
 -> 小型快速模型按目标提取
 -> 主模型收到提取结果，继续查找或回答
```

官方工具参考明确指出：单次 WebSearch 最多可发起 8 次后端搜索，内部会调整查询。它支持允许域名或排除域名，但两类过滤不可同次使用。搜索服务不可由配置直接替换，其他供应商通过 MCP 增加工具。[S2]

WebFetch 通常把小型快速模型的提取答案交给主模型，而非整页原文，并默认缓存响应 15 分钟。这能减少重复抓取与主模型上下文负担，但提取是有损的：结果说没有某信息，可能只是提取提示没有覆盖它，不能直接认定原网页不存在该信息。大页面会先截断，重定向到不同主机需要后续请求。[S2]

这些是公开文档的行为描述，不是一次实际 Claude Code 抓包测量；不能由此断言每个用户环境速度相同，也不能把“一次最多 8 次”写成“一定并行 8 次”。

## 3. 自己开发时如何接 Claude API

官方服务端搜索的基础工具声明如下；这是工具片段，不是完整可运行请求，也不表示旧版本是最新版本：[S3]

```json
{
	"type": "web_search_20250305",
	"name": "web_search",
	"max_uses": 5
}
```

放进受支持的 Claude Messages API 请求 tools 中，API 在服务端执行搜索并把结果交给模型。使用此路线需要支持该功能的 Claude API 接入和组织设置，但不需要另外向 Brave/Bing 提供自己的搜索 Key。不是任意“OpenAI 兼容”转发服务都支持这类 Anthropic 服务端工具。

2026-09-15 读取的文档列出 web_search_20250305、web_search_20260209、web_search_20260318。20260209 及后续版本支持动态过滤：在代码执行环境中过滤检索数据，再向上下文提供相关内容；需使用支持该能力的模型及平台。20260318 还增加响应包含控制。这是减少无关内容和 token 消耗的机制，不等于保证更高召回。[S3]

web_fetch 是读取已知 URL 的服务端工具，可取网页正文和 PDF，也有内容限制、缓存和较新版本的动态过滤。它与 Claude Code 本机 WebFetch 不是同一个工具契约；不能将两者的默认缓存和提取步骤互相套用。[S4]

集成时还要处理引用、完整结果块的多轮回传、pause_turn 续跑及工具内部错误。外层 HTTP 200 仍可能包含搜索/读取错误，必须检查返回内容，不能只看 HTTP 状态。[S3-S4]

## 4. 到底用了哪家搜索引擎

本次可以确认：Claude Code 官方称其使用 Anthropic web search backend。[S2] 网页版帮助文档单独明确图片搜索由 Bing 提供。[S1]

Brave 和 AWS 作者的官方文章展示 Claude Cowork + Amazon Bedrock + Brave Search MCP 的自定义配置：需要为 MCP 配置 Brave API Key。[S5] 这证明该接法存在，不证明全部 Claude 默认文本搜索唯一使用 Brave，也不能据图片搜索就推断文本搜索都是 Bing。

本次读取的资料不足以确认所有 Claude 文本搜索的固定供应商、调度和完整排序实现。Anthropic 信任中心的供应商页面本次 HTTP 只返回动态应用壳，未从中核验供应商清单，因此不据此作断言。

## 5. Claude 同样存在限制

- 官方 API web_fetch 明确不支持 JavaScript 动态渲染网站；需要浏览器时应接客户端浏览器工具。[S4]
- 搜索到链接不等于读到正文；读到标题、描述不等于观看过视频或读过字幕。
- Claude Code 的页面提取有损，不能将摘要中缺少信息当作原文没有。[S2]
- 托管工具支持情况随平台和模型变化。文档明确 Amazon Bedrock 不提供此服务端搜索工具，不能认为所有 Claude 接入都自动联网。[S2-S3]
- 官方搜索有引用机制，但应用仍需核对工具错误和证据覆盖范围，不能靠引用图标代替验证。[S3-S4]

## 6. 对 Wuming 的具体建议

当前项目默认是 Bing HTML，另有 Brave/SearXNG 适配器；本机浏览器搜索也默认 Bing，详见前一份 search-research-2026-09-15.md 和对应会话证据。

路线 A：保留当前 Pi 与多模型架构，优先对照测试已有 Brave API 适配器。补充质量状态、域名约束、重复结果检测、正文提取、缓存和证据分级。最容易与现有项目兼容，但需要自己的搜索凭据。

路线 B：将 Claude 托管搜索作为一个独立研究服务。由后端调用真正支持服务端工具的 Claude Messages API，返回答案、来源和诊断供主 Agent 使用。此方案额外引入模型服务、费用、权限和数据流，不应伪装成普通搜索结果接口，也不保证延迟更低。

路线 C：增加 MCP 搜索工具。适合用户希望更换或组合不同服务的情况；MCP 是连接协议，不是搜索引擎，本身不会改善索引质量。

无论采用哪条路线，都应借鉴“搜索与阅读分开、先过滤再进入上下文、目标化提取、缓存、有损提取可追溯、错误显式化”，而不是只更换模型名称。不要照搬无限内部搜索；按有效候选增量、调用预算和用户需求停止。

## 7. 官方来源

- S1 Claude 网页版搜索：`https://support.claude.com/en/articles/10684626-enable-and-use-web-search`
- S2 Claude Code 工具参考，WebSearch/WebFetch behavior：`https://code.claude.com/docs/en/tools-reference`
- S3 Claude API 搜索：`https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool`
- S4 Claude API 读取：`https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-fetch-tool`
- S5 Brave/AWS 官方集成案例：`https://brave.com/blog/claude-cowork-amazon-bedrock-brave-mcp/`

以上五页均实际读取并观察到 HTTP 200。未执行付费 Claude 搜索 API、未用 Claude Code 实际做联网 A/B、未核验视频字幕；不提供未经测量的供应商排名和性能承诺。
