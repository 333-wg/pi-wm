# 联网搜索调研：Codex、Pi 与 Wuming

调研日期：2026-09-15。范围：官方在线文档、Pi 作者的技能源码、当前工作区源码、截图对应会话及本机默认搜索链路复测。

## 结论

此次失败不是“模型没有联网”，也没有证明“相关视频不存在”。实际问题是默认搜索源返回偏题结果，浏览器备用路径仍使用同一搜索源，网页读取只得到页脚，程序没有将这些情况识别为检索质量失败。优先改数据源、质量判定、正文提取和证据状态，而不是先换模型或增加搜索次数。

下文区分代码和日志直接证明的事实、本机复测观察以及设计建议。本次没有比较付费供应商的真实召回率，没有观看视频或核验视频时长。

## 1. 截图对应的真实过程

日志文件为本机 Wuming/pi-sessions 下的 2026-09-15T07-31-07-699Z_01a0a3fa-0933-7aa9-b9c4-a5b1e2fb8913.jsonl。以下为北京时间。

| 时间     | 实际调用                                                  | 观察                                              |
| -------- | --------------------------------------------------------- | ------------------------------------------------- |
| 15:35:56 | 两次 web_search，含 site:youtube.com                      | 返回 Pi 文档、圆周率等站外结果                    |
| 15:36:03 | 两次 web_search，查询官网名及教程视频                     | 继续出现圆周率等偏题结果                          |
| 15:36:10 | browser_search                                            | searchUrl 实际为 cn.bing.com/search，仍是偏题结果 |
| 15:36:16 | web_fetch 读取 YouTube 搜索页                             | HTTP 200，正文却只有 About、Press、Terms 等页脚   |
| 15:36:29 | 两次 web_search，含 youtube.com/watch 和 youtube ... demo | 两组都返回 Movies & TV、About YouTube、应用商店等 |

这一段共 6 次普通搜索、1 次浏览器搜索、1 次页面读取，均为 isError: false。按有序 URL 列表精确比较，7 次搜索只有两组不同结果。模型尝试了换词和页面读取，不能简单归因于“不会换词”或“没有打开页面”。但读取页脚不等于验证视频。提示词规定浏览器优先，实际却先用 web_search；同轮也已有多个工具调用，不能声称项目完全没有并行能力。

本段工具返回已单独提取到同目录 search-research-2026-09-15.evidence.json，未导出无关聊天或凭据。

本机复测：直接调用 SafeWebClient.search() 和已编译的 PlaywrightBrowserManager.search() 均复现同类无关结果，浏览器最终地址为 cn.bing.com。独立读取 Bing DOM，页面标题及输入框仍包含完整查询，因此查询未在 Wuming 的 URL 构造处简单丢失。DuckDuckGo HTML 本次遇到人机验证，不能把另一个免费网页抓取源当作已经验证的修复。

重定向和偏题是事实；是否由地域策略、搜索端重写、网络中间层或多种因素导致，未做隔离变量实验，不能指定唯一原因。单次搜索复测为数百毫秒至一秒多，只是少量样本，不是稳定性能基准。

## 2. Codex 与 Pi 到底提供什么

### Codex

官方 Codex 配置文档说明，本地聊天支持缓存和实时搜索，缓存使用 OpenAI 维护的网页结果索引。这不是在用户机器上解析 Bing HTML。[O1]

官方 Responses API 公开托管 web_search：推理模型可搜索、打开页面、页内查找；输出搜索调用和引用，支持域名限制、来源清单、实时访问控制及返回内容预算。[O2]

必须区分 Codex 产品、开发者的托管搜索 API、自建 Agent 的同名函数。工具名字相同、换成 Codex 系列模型、兼容 OpenAI 的接口或已有订阅，均不能证明自建接口接通了托管工具。需要检查服务端支持及实际请求/返回。公开文档没有证明本次 Codex 搜索必定使用哪家供应商，也没有公开完整排序和抓取实现。

### Pi

Pi README 默认四工具为 read、write、edit、bash，能力由技能、扩展和包补充。它是 Agent 运行框架，不是一个自带通用搜索引擎的产品。[P1]

作者 badlogic/pi-skills 提供可检查实例：模型加载 brave-search，使用 shell 执行 search.js，脚本调用 Brave Search API，并可读取候选网页，将标题、链接、摘要、时间信息及正文返回模型。[P2-P4]

该脚本支持数量、国家、时效过滤；正文使用 Readability/JSDOM/Turndown，设置截取长度。它不要求启动浏览器。值得注意，示例逐个读取正文，并不是天然的高并发检索平台。[P4]

同库的 youtube-transcript 是另一项技能，依赖 youtube-transcript-plus；查到视频与读到字幕是不同能力。技能存在不代表任何视频都能读取，也不证明其他人的 Pi 已安装了它。[P2,P5]

你的 default-factory.ts 明确关闭 Pi 自动技能和扩展加载，由 Wuming 自己管理。安装 Pi SDK 不会自动获得作者技能仓库的能力；不应盲目取消这些配置，避免破坏现有能力管理边界。

## 3. 项目中的具体缺口

| 层次     | 源码位置                                                         | 影响                                                          |
| -------- | ---------------------------------------------------------------- | ------------------------------------------------------------- |
| 默认源   | apps/gateway/src/configuration.ts:148                            | 未配置时为 Bing HTML                                          |
| 备用源   | packages/sandbox/src/browser.ts:53；apps/gateway/src/main.ts:886 | 浏览器仍默认 Bing，工具不同不等于索引独立                     |
| 提示词   | packages/pi-adapter/src/system-prompt.ts:91                      | 研究和素材下载统一浏览器优先，API 配置好也可能不优先调用      |
| 搜索参数 | packages/sandbox/src/types.ts:79；tools.ts:719                   | 只暴露 query/count，缺少语言、地区、时效、内容类型            |
| 结果质量 | packages/sandbox/src/web.ts:345；tools.ts:751                    | Bing 2xx 直接解析返回，未区分偏题、解析变化与有效命中         |
| 标题解析 | packages/sandbox/src/browser.ts:444                              | 联合选择器不保证先取标题；日志出现域名面包屑当标题            |
| 动态页面 | packages/sandbox/src/web.ts:142                                  | 通用 HTML 转文本跳过脚本，无 YouTube 专门提取；日志只得到页脚 |
| 证据结构 | packages/sandbox/src/types.ts:84                                 | 只有 provider/items 等基本信息，缺少质量与核验状态            |
| Pi 接入  | packages/pi-adapter/src/default-factory.ts:149                   | noExtensions/noSkills 开启，能力由 Wuming 管理                |
| 测试     | packages/sandbox/test/web.test.ts:97；browser.test.ts:52         | 静态样例和模拟站点不证明真实问题召回质量                      |

另有待回归验证的风险：浏览器只等待 domcontentloaded 就取结果；Bing 跳转链接未统一解包，浏览器还排除初始搜索域链接。这些不能未经复现就称为截图直接原因。现有网络隔离、权限、大小限制和外部文本不可信标记应保留。

## 4. 分阶段改进方案

目标流程：需求和实体识别 → 搜索路由 → 结构化 API / 可选独立第二索引 / 平台 API → 质量检查和去重 → 读取正文或字幕 → 证据记录 → 有出处且限定核验程度的回答。

### 第一阶段：数据源和诊断

- 优先验证已有 Brave API 适配器，改动最小；需要凭据和同题对照，不能先承诺它最好。Brave 文档支持地区、语言、时效和额外摘要，可逐步接入。[B1]
- 搜索 API 优先，普通页面轻量读取，动态页面再使用浏览器。保留用户设备/Gateway 的权限和网络边界，回退不得绕过显式阻断。
- 可选第二独立索引；SearXNG 只是聚合入口，独立性和效果取决于实例背后引擎，不能按工具名计算多源。
- 将状态区分为 ok、empty、low_relevance、blocked、parse_failed、timeout。HTTP 成功不等于检索有效。
- 记录 provider、requested/final URL、耗时、原始/有效条数及过滤原因；不要记录密钥、Cookie 或无关私人浏览数据。
- 健康状态区分未配置、未验证、可用、降级、受阻；不能只要函数存在就显示搜索可用。

### 第二阶段：读取和证据

- 先定位 Pi coding agent、作者和仓库，再扩展别名，避免 pi 歧义。
- 将指定域名作为明确约束；URL 规范化后检查，不因搜索引擎忽略 site: 就接纳站外结果。
- 视频需求需可识别的视频详情 URL/ID，平台首页、About 和应用商店不是视频候选。
- 检测不同查询的重复 URL 集合和新增有效候选量；重复偏题时换策略或来源，而非无限换词。
- 使用成熟正文提取器，保留标题、作者、日期、原 URL；页脚和动态空壳应返回正文不足。
- 证据分级：discovered（找到链接）、metadata_verified（核实元数据）、content_verified（读取正文/字幕）。不把未经校准的数值冒称精确置信度。
- 无结果时说明当前渠道未取得可核验结果，不推断项目太新、小众或根本不存在。

### 第三阶段：速度与成本

以下是起始设计建议，不是 Codex 已公开的内部参数，也不是现已实现的能力：

- 简单查找先走一个可靠源；复杂任务再并发 2-3 个互补查询，去重后读取 3-5 个候选。
- 纯读取采用有界并发，浏览器有状态操作保持隔离。既有工具并行应保留，重点减少无效轮次。
- 缓存键包含查询、供应商、地区、语言、时效、内容类型，按内容设 TTL；不长期缓存验证码和错误结果。
- 同请求去重、总超时、有限重试、取消传播、限流退避和检索预算一起设计。
- 模型只收摘要、相关片段及必要诊断，完整证据留在可追踪存储；确定性过滤后再按需语义重排。
- 分别测模型、排队/审批、联网、解析、总耗时。日志中的消息时间间隔不是纯网络时延。

## 5. YouTube 应单独处理

可选接入 YouTube Data API 的 search.list 搜索视频候选，再以 videos.list 的 snippet/contentDetails 核对相关元数据。[Y1-Y2]

找到标题、ID、时长不等于理解视频。官方 captions.download 要求相应授权及编辑视频的权限，不能承诺普通 API key 能下载任意公开视频字幕。其他字幕读取方式也有字幕缺失和访问受限的问题。[Y3]

流程：定位项目 → 找到视频候选 → 核对标题/作者/日期 → 有权限且可获取时读取描述或字幕 → 标注仅元数据或内容已核验。没有字幕时可初步判断相关性，但不能声称观看过或编造章节。

## 6. 验收

建立固定问题集：本次 Pi/YouTube 案例、中文问题、英文官方文档、近期版本、指定域名、动态页面、确实无结果、验证码、403/429、超时和重复结果。

固定响应回归测试与真实问题评估分开。前者验证解析和质量状态，后者在同环境、同模型、同预算下对照供应商。测 Top-K 相关性、视频 URL 有效率、域名违规率、重复率、正文成功率、引用可核验率、错误否定率、P50/P95 总延迟和每个有效答案的费用。没有完整相关结果集时，不要将相关条数冒称严格召回率。

最低要求：不把首页当视频；页脚标为正文不足；重复偏题会触发策略变化；区分未找到和不存在；已核实事实可定位到具体证据。

## 7. 来源与限制

本次内置 web.run 多次未返回可核验正文或引用条目，没有据此编造搜索结果。以下官方文档和作者源码均通过本机 HTTP 实际读取并观察到 HTTP 200。

- O1 Codex 配置：`https://developers.openai.com/codex/config-basic/`，本次转向 `https://learn.chatgpt.com/docs/config-file/config-basic`。
- O2 托管搜索：`https://developers.openai.com/api/docs/guides/tools-web-search`。
- P1 Pi README：`https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/README.md`。
- P2 技能目录：`https://raw.githubusercontent.com/badlogic/pi-skills/main/README.md`。
- P3 搜索技能：`https://raw.githubusercontent.com/badlogic/pi-skills/main/brave-search/SKILL.md`。
- P4 搜索实现：`https://raw.githubusercontent.com/badlogic/pi-skills/main/brave-search/search.js`。
- P5 字幕技能：`https://raw.githubusercontent.com/badlogic/pi-skills/main/youtube-transcript/SKILL.md`；同目录 package.json 用于核对依赖。
- B1 Brave 参数：`https://api-dashboard.search.brave.com/app/documentation/web-search/query`。
- Y1 视频搜索：`https://developers.google.com/youtube/v3/docs/search/list`。
- Y2 视频详情：`https://developers.google.com/youtube/v3/docs/videos/list`。
- Y3 字幕权限：`https://developers.google.com/youtube/v3/docs/captions/download`。

源码基于当前工作区，包括已有未提交修改，不代表安装包一定完全一致。历史会话与复测相互印证了偏题、重定向和正文不足。

未完成：Brave/托管搜索/YouTube API 的需凭据测试、跨网络对照、模型端到端 A/B、视频字幕读取。没有依据宣布某供应商必定最好或承诺固定成功率。

本轮仅新增调研资料，不修改业务实现、搜索凭据、网络权限或现有用户配置。
