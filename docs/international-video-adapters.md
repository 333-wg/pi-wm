# Google 与 Grok 视频适配

本次海外服务只接入 Google 与 xAI Grok，不包含其他海外厂商。已有国内适配不受影响。
接口资料核对日期：2026-09-21。

## 配置

在“设置 > 模型 > 视频模型”选择对应预设，填写自己的 API Key 和准确的模型 ID：

| 预设               | Base URL                                         | 模型 ID 示例             |
| ------------------ | ------------------------------------------------ | ------------------------ |
| Google Veo         | https://generativelanguage.googleapis.com/v1beta | veo-3.1-generate-preview |
| Google Gemini Omni | https://generativelanguage.googleapis.com/v1beta | gemini-omni-1.1-flash    |
| Grok Imagine Video | https://api.x.ai/v1                              | grok-imagine-video-1.5   |

Google 使用 Gemini Developer API Key，不支持用 Vertex AI OAuth 凭据替代。Grok 使用 xAI API Key。两者均不需要额外 Secret Key。
原生接口不使用 OpenAI 的模型发现接口，需要手动填写模型 ID。保存配置不代表账号已有模型权限、余额或可用配额。

官方域名可以自动识别；第三方中转必须选择其真实实现的协议，不能仅凭模型名称判断兼容性。
Google 的 Veo 与 Omni 使用不同 API，不可互换协议。未知模型或不支持的参数会在提交前拒绝，不会自动换模型或降级后再扣费。

## 已接入范围

- Veo：文生视频、单张本地产物作为首帧、异步 operation 查询、受保护的视频文件下载。支持 Veo 3.0/3.1 系列的 generate 模型命名，包括 fast/lite 变体；具体 ID 仍以账号实际开放情况为准。
- Veo 3.1：4/6/8 秒；720P、1080P，非 lite 模型可请求 4K；1080P/4K 要求 8 秒。Veo 3.0 当前仅开放 8 秒，1080P 限制为横屏。首帧限 PNG/JPEG，不直接接收公网图片 URL。
- Gemini Omni：文生视频、单张本地产物参考；3–10 秒整数；360P/720P/1080P/4K；16:9 或 9:16。通过 Interactions API 的后台任务生成，使用 Api-Revision: 2026-05-20，并处理 Files 从 PROCESSING 到 ACTIVE 的等待。
- Omni 后台请求显式设置 background=true 和 store=true，以便后续查询。交互会保存在服务端，使用前应按供应商的数据保留政策评估提示词和参考图片是否适合上传。
- Grok：文生视频、单张本地产物或公网图片动画化；1–15 秒；旧 grok-imagine-video 支持 480P/720P，1.5 系列增加 1080P。支持 16:9、9:16、1:1、4:3、3:4、3:2、2:3。指定比例可能拉伸输入图片。
- Grok 1.5 同时识别 grok-imagine-video-1.5-preview 和 grok-imagine-video-1.5-2026-05-30 别名。

本次不开放视频编辑、延长、多参考图片、首尾帧组合或独立音频控制。参数支持情况通过 media_model_status 返回给技能。

## 任务与安全

提交、轮询、结果下载通过现有 generate_video/get_generated_video 工具完成。任务保存原始协议和查询上下文，重启或修改预设后仍按原任务协议查询；更换账号、模型或地址后的连接一致性限制继续生效。
请求结果不确定时不会自动重新提交生成，避免重复扣费。完成的视频保存为本地产物，再次读取直接使用缓存。

Google API Key 只通过 x-goog-api-key 请求头发送。同源文件地址必须符合 Files API 路径白名单；跨域 CDN 跳转走现有公网 DNS 校验下载器，不携带 Google 或 Grok 的凭据。
operation 名称禁止路径穿越；内联视频严格检查 Base64 和大小，最终文件还经过现有文件签名验证。密钥不回显给浏览器或技能。

## 验证边界

2026-09-21 本地验证：11 个测试文件共 230 项媒体及协议测试通过，8 项 Playwright 浏览器测试通过。生产构建、含测试的工作区类型检查、E2E 类型检查和本次改动的定向 lint 通过。已人工检查桌面与手机设置页截图。

自动化覆盖原生请求格式、鉴权、参数限制、异步状态、任务恢复、Google Files 等待和跳转、内联视频大小限制，以及设置页的保存与编辑。
这些测试使用本地模拟响应，不消耗供应商额度。尚未使用真实付费账号生成视频，不能据此保证当前账号的地区、权限、配额或供应商线上行为。

## 官方资料

- Google 视频与 Veo：https://ai.google.dev/gemini-api/docs/video ，https://ai.google.dev/gemini-api/docs/veo
- Google Omni：https://ai.google.dev/gemini-api/docs/omni
- Google Interactions：https://ai.google.dev/api/interactions-api
- Google 官方 Omni 示例：https://github.com/google-gemini/gemini-skills/blob/main/skills/gemini-omni-flash-api/scripts/video/generate_video.py
- xAI 视频生成：https://docs.x.ai/developers/model-capabilities/video/generation
- Grok Imagine Video 1.5：https://docs.x.ai/developers/models/grok-imagine-video-1.5
