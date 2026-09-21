# 国内视频模型原生适配

更新日期：2026-09-21。

本项目按供应商 API 协议适配，而非仅按模型名称分类。豆包和即梦产品里的 Seedance 通过火山方舟调用；火山视觉的即梦 API 则使用另一套签名及任务协议。以下实现通过本地协议及服务集成测试，不表示所有账户、区域、模型版本已完成真实付费生成验证。

## 服务清单

| 设置协议        | Base URL 示例                              | 模型 ID 示例                                     | 当前范围                                                    |
| --------------- | ------------------------------------------ | ------------------------------------------------ | ----------------------------------------------------------- |
| 豆包 / Seedance | `https://ark.cn-beijing.volces.com/api/v3` | doubao-seedance-1-5-pro-251215                   | 文生视频、单张首帧；API Key                                 |
| 即梦            | `https://visual.volcengineapi.com`         | jimeng_ti2v_v30_pro                              | 视频 3.0 文生/首帧/Pro；Access Key + Secret Key             |
| 可灵            | `https://api-beijing.klingai.com/v1`       | kling-v2-6                                       | text2video / image2video、pro 模式；Access Key + Secret Key |
| 通义万相        | `https://dashscope.aliyuncs.com/api/v1`    | wan2.6-t2v / wan2.6-i2v                          | 文生和单张首帧；API Key                                     |
| MiniMax / 海螺  | `https://api.minimaxi.com/v1`              | MiniMax-Hailuo-2.3 / MiniMax-H3 / MiniMax-H3-Max | Hailuo V1 和 H3 V2 文生/首帧；API Key                       |
| Vidu            | `https://api.vidu.cn/ent/v2`               | viduq3-pro / viduq3-turbo                        | 文生和单张首帧；API Key，以 Token 鉴权                      |

示例是接口配置示例，不代表模型仍向所有账户开放，也不会自动替用户选择付费模型。必须使用控制台已开通的准确 ID。设置页选择协议会填入基础地址和模型占位符，不会提交生成。已有模型可独立设为默认；中转仍需明确选择其实际兼容协议。

## 模型边界

- Seedance 支持方舟 API Key，不是豆包聊天网页凭据；首帧上传为 Data URL。参数按原生字段发送；新模型的可用时长和尺寸仍以供应商为准。
- 即梦模型字段填写 req_key。本轮支持 jimeng_t2v_v30、jimeng_t2v_v30_1080p、jimeng_i2v_first_v30、jimeng_i2v_first_v30_1080、jimeng_ti2v_v30_pro；5/10 秒转换为 121/241 帧。清晰度由 req_key 决定，显式冲突会拒绝。仅支持长期 AK/SK、cn-north-1 / cv 签名；未接入临时凭据、首尾帧双图或多参考素材。
- 可灵使用本地生成的短期 HS256 JWT，按文生或图生选择提交及查询路径，并把模式随任务持久化。本轮开放 5/10 秒、pro 质量模式，不支持 Omni/O 系列、分镜、运动控制、音频参数，也不把分辨率假装映射为可灵参数。
- 万相必须选择匹配的 -t2v / -i2v 模型；文生发送 parameters.size，图生发送 input.img_url 与 parameters.resolution。R2V、编辑、首尾帧等其他端点没有接入。
- MiniMax Hailuo V1 完成后先查询 file_id，再请求 files/retrieve 获取下载地址。H3/H3-Max 使用 /v2/video_generation 和 /v2/query/video_generation/{task_id}，解析 task.content.url，不走 V1 文件下载流程。H3-Max 最短 5 秒、H3 最短 4 秒；视频续写、多参考、音频输入未暴露。
- Vidu 按模型区分能力：viduq2 为文生；viduq2-pro / viduq2-turbo / viduq2-pro-fast 为图生；viduq3-pro / viduq3-turbo 可用于两种基础模式。Q1、Vidu 2.0 有独立时长及清晰度限制。未开放多参考、首尾帧、模板和音频参数。
- 原生图生模式不支持单独画幅参数时，会拒绝 aspectRatio，而不是无声丢掉用户要求。不能提交不匹配的文生模型后偷偷忽略参考图。

## 安全与兼容

- apiSecret 只存在于输入配置、宿主内存和原有 AES-GCM 加密配置文件中，不返回模型设置列表、模型上下文、工具输出或任务数据库。错误诊断额外屏蔽 Secret Key、JWT、Token 和签名。
- 自动识别只匹配明确的官方 HTTPS 主机。不会根据中转模型名字猜协议，不用付费生成探测协议，不会失败后换协议重投。
- 原生接口使用明确的 API 前缀；错误的聊天兼容地址会在请求前拒绝。官方原生服务不调用 OpenAI /models 列表接口。
- 新增的 request_context 数据库列只保存可灵的 text/image 查询模式；已有任务保留原来的协议与连接指纹。无 Secret Key 的旧连接指纹保持不变。
- 即梦查询虽然为 POST，仍属于可退避的读取操作。HTTP 429 / 临时服务器错误沿用原有持久化查询调度，不生成新任务。
- 完成的视频通过现有安全下载器取回，下载 CDN 时不附加 API 凭据，继续应用大小限制和媒体校验。
- 保存配置不等于真实生成成功。当前没有自动测试账户权限、余额或真实出片；需另行授权进行低成本实测。

## 核对来源

- 火山方舟视频任务 API：<https://www.volcengine.com/docs/82379/1520757>
- 即梦视频 3.0 Pro：<https://www.volcengine.com/docs/85621/1777001>
- 即梦首尾帧接口（用于核对协议，不表示已开放此模式）：<https://www.volcengine.com/docs/85621/1791184>
- 火山官方 V4 签名实现：<https://github.com/volcengine/volc-sdk-python/blob/master/volcengine/auth/SignerV4.py>
- 可灵官方 API：<https://app.klingai.com/global/dev/document-api/apiReference/model/textToVideo>
- 万相文生视频：<https://help.aliyun.com/zh/model-studio/text-to-video-api-reference>
- 万相图生视频：<https://help.aliyun.com/zh/model-studio/image-to-video-api-reference>
- MiniMax V1 文生/图生：<https://platform.minimax.io/docs/api-reference/video-generation-t2v>、<https://platform.minimax.io/docs/api-reference/video-generation-i2v>
- MiniMax H3 V2：<https://platform.minimax.io/docs/api-reference/video-generation-v2-create>、<https://platform.minimax.io/docs/api-reference/video-generation-v2-query>
- Vidu：<https://platform.vidu.cn/docs/text-to-video>、<https://platform.vidu.cn/docs/image-to-video>、<https://platform.vidu.cn/docs/task-creation>

## 验证

协议回归：apps/gateway/test/media-video-native.test.ts。

服务回归：apps/gateway/test/media-generation.test.ts，覆盖六类服务及 H3 的文生/图生提交、参考图、加密保存、重载、任务查询、下载、视频入库和幂等取回，并覆盖即梦 POST 查询退避。

界面回归：e2e/media-generation.spec.ts，覆盖六种服务配置、双凭据不回显、桌面/手机输入框边界以及原有视频生成流程。全部使用本地模拟响应，不创建付费任务。

本轮结果：10 个相关测试文件、194 个用例通过；8 个 Playwright 端到端测试通过，桌面和手机截图已人工检查。生产构建、相关工作区（含测试）类型检查、E2E 类型检查及定向 lint 通过。没有使用真实供应商凭据或提交付费任务。
