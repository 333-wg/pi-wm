<p align="center">
  <img src="apps/web/src/assets/wuming-clover.png" alt="Pi-Wm 标志" width="88">
</p>

<h1 align="center">Pi-Wm</h1>

<p align="center"><strong>基于 Pi 的本地优先 AI 编程工作台</strong></p>

<p align="center">
  在自己的电脑上，让 AI 阅读代码、修改文件、运行命令，并检查执行结果。
</p>

<p align="center">
  Windows 桌面端 · Web 工作台 · 自选模型 · Agent Teams
</p>

<p align="center">
  <a href="#界面预览">界面预览</a> ·
  <a href="#核心功能">核心功能</a> ·
  <a href="#快速开始">快速开始</a> ·
  <a href="#文档导航">文档导航</a> ·
  <a href="#参与开发">参与开发</a>
</p>

---

Pi-Wm 把对话、项目文件、Git 改动、终端、浏览器预览和多 Agent 协作放进同一个工作台。你可以连接自己的模型服务，在本地项目里完成从理解需求、编写代码到运行验证的工作。

**本地优先，不等于离线运行。** 工作区操作和会话状态由本机服务管理；使用远程模型时，请求及相关上下文仍会发送到你配置的服务商。

> **项目状态：持续开发 / 内测。** 当前桌面打包目标为 Windows x64。安装包签名、干净系统上的安装升级验证等仍需完善；请先在测试项目中体验，不要将内测构建视为已完成生产验收的正式版本。

## 界面预览

<table>
  <tr>
    <td align="center" valign="top" width="50%">
      <a href="docs/images/login.png"><img src="docs/images/login.png" alt="Pi-Wm 登录页，包含欢迎介绍与访问密码输入框" width="520"></a>
      <br><strong>登录与欢迎</strong>
      <br><sub>从欢迎页进入个人工作空间</sub>
    </td>
    <td align="center" valign="top" width="50%">
      <a href="docs/images/workbench.png"><img src="docs/images/workbench.png" alt="Pi-Wm 主工作台，展示项目侧栏、功能导航和新任务输入区" width="520"></a>
      <br><strong>项目工作台</strong>
      <br><sub>对话、文件、终端与工具集中在同一界面</sub>
    </td>
  </tr>
  <tr>
    <td align="center" valign="top" width="50%">
      <a href="docs/images/agent-teams.png"><img src="docs/images/agent-teams.png" alt="Agent Teams 协作界面，展示图书管理系统任务的成员、依赖关系与通信流" width="520"></a>
      <br><strong>Agent Teams 协作</strong>
      <br><sub>查看成员分工、任务依赖和团队消息</sub>
    </td>
    <td align="center" valign="top" width="50%">
      <a href="docs/images/appearance-settings.png"><img src="docs/images/appearance-settings.png" alt="外观设置界面，展示浅色与深色配色、语言和后台任务通知选项" width="520"></a>
      <br><strong>外观与偏好</strong>
      <br><sub>选择配色、界面语言与任务通知</sub>
    </td>
  </tr>
</table>

<p align="center"><sub>点击图片查看原图。截图中的模型名称与任务内容仅作界面示例，不代表预置服务或可用额度。</sub></p>

## 核心功能

### 围绕项目完成工作

- **本地编码与终端**：读取和编辑项目文件、查看 Git 差异，在本机 Shell 中运行命令，使用集成终端检查结果。
- **浏览器验证**：Agent 可通过独立的 Playwright 浏览器查看页面、操作控件、截图并检查报错；桌面端另有内置浏览器，方便你直接查看本地预览。
- **会话与任务管理**：保存对话历史，搜索聊天正文，查看请求耗时、失败信息、Token 用量与上下文使用情况。
- **恢复与通知**：提供中断后的恢复操作、上下文压缩和桌面任务通知，便于接着处理未完成的工作。

### 从单个任务到团队协作

- **子任务**：把独立工作委派给子 Agent，查看各自的完整对话、执行状态和结果。
- **Agent Teams**：由负责人组织持续运行的团队成员，通过共享任务、依赖关系和成员消息协作；工作台展示团队进度与验收记录。
- **成员模板**：保存和复用成员角色、模型与工具配置，减少重复设置。
- **目标与定时任务**：支持目标验收、修正轮次和一次性或固定间隔的计划任务。应用关闭后，任务不会继续执行。

### 模型、工具与桌面能力

| 能力         | 可以做什么                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------ |
| 模型配置     | 配置自己的模型服务、模型能力、上下文窗口与思考选项。                                       |
| 官方账号     | 本地模式提供 Claude、ChatGPT、Grok 授权入口；可用模型与额度取决于账号权限和服务商限制。    |
| 图片与视频   | 配置独立的媒体模型，在对话中生成和查看媒体结果；实际能力取决于所接服务。                   |
| MCP          | 在界面中添加、编辑、授权和连接 MCP 服务；保存配置不会自动授予信任。                        |
| Skills       | 使用内置技能，从工作区目录安装、预览和管理本地技能包。                                     |
| Computer Use | 在 Windows 上显式开启后，通过 UI Automation 或截图与输入操作桌面应用；需要 Python 3 环境。 |
| 界面与主题   | 支持中英文界面、浅色与深色配色，以及跟随系统的主题设置。                                   |

能力边界和验证范围请查阅下方专题文档。Agent Teams 的自主规划需要真实模型，Demo 模式不会模拟模型决策。

## 快速开始

### 1. 安装依赖

准备 Git 和 **Node.js 22.19 或更高版本**。如果要打包 Windows 桌面端，请使用 **Windows x64 + Node.js 22.19+ 的 22.x 版本**。

克隆本仓库后，在仓库根目录执行：

```sh
npm install --legacy-peer-deps
```

### 2. 选择启动方式

**桌面端开发运行**

```sh
npm run desktop
```

此命令先构建项目，再启动 Electron 和本地服务，无需手动启动 Gateway。

**浏览器工作台**

```sh
npm run local
```

启动本地服务并打开 `http://127.0.0.1:5173/`。不希望自动打开浏览器时，可设置环境变量 `WUMING_OPEN_BROWSER=false`，再运行同一命令。

### 3. 连接模型，开始第一个任务

1. 首次进入若出现欢迎页，开发默认口令为 `wuming`。
2. 在首次设置或模型设置中添加模型服务；也可以在本地模式的“官方账号”页面进行授权。
3. 选择一个本地项目目录，确认权限设置，再发送具体任务。

例如，先从只读检查开始：

```text
先阅读这个项目的 README 和目录结构，说明启动方式与主要模块，暂时不要修改文件。
```

需要浏览器自动化时，源码运行环境可先安装 Chromium：

```sh
npm run test:e2e:install
```

> 开发默认口令仅适合本机回环访问，不要把本地 Gateway 暴露到公网。桌面端的欢迎页不是安全边界，桌面 Gateway 使用单独生成的随机令牌。

<details>
<summary><strong>构建 Windows 安装包</strong></summary>

```sh
npm run desktop:dist
```

安装包输出到 `release/`。只需要免安装目录时，使用 `npm run desktop:pack`。

打包后的应用包含运行所需的 Node 和浏览器组件，用户无需安装 Node.js 或 npm；Computer Use 所需的 Python 仍需单独准备。未配置签名的安装包可能触发 Windows 未知发布者提示。

构建与验证见[桌面端文档](docs/desktop.md)，更新源配置和发布步骤见[桌面更新](docs/desktop-updates.md)。

</details>

## 使用边界

- **本机命令使用你的系统权限。** 项目目录约束和操作审批不等于操作系统级沙箱；需要容器隔离时，应显式配置 Docker 后端。
- **敏感信息不要提交到仓库。** 模型 API Key 由本地服务加密保存，但 MCP 的环境变量和请求头仍可能明文保存在工作区配置中。
- **桌面预览与 Agent 浏览器相互独立。** 两者不共享页面和 Cookie，也不会自动导入你个人 Chrome / Edge 的登录状态。
- **技能安装目前面向本地目录。** 不要将其理解为已支持远程技能市场、仓库安装或 ZIP 安装。
- **模型调用可能产生费用。** 多 Agent、图片视频生成和真实服务商验证都可能消耗额度，请结合自己的服务与预算使用。

## 文档导航

首页面向使用者；实现细节、配置参数和验证方式集中在以下文档中，部分文档为英文。

| 主题          | 文档                                                                                                                                                                            |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 安装与配置    | [桌面端运行与打包](docs/desktop.md) · [桌面更新](docs/desktop-updates.md) · [开发与配置详解](docs/development-guide.md) · [环境变量示例](.env.example)                          |
| 项目与执行    | [文件与 Git 检查](docs/workspace-inspection.md) · [本地执行](docs/local-device-execution.md) · [终端](docs/terminal.md) · [沙箱与审批](docs/sandbox-and-approvals.md)           |
| 多 Agent 协作 | [Agent Teams](docs/agent-teams.md) · [成员模板](docs/agent-templates.md) · [目标与计划验证](docs/goal-plan-verification.md)                                                     |
| 浏览器与桌面  | [内置浏览器预览](docs/browser-preview.md) · [Computer Use](docs/computer-use.md)                                                                                                |
| 模型与媒体    | [官方账号授权](docs/official-accounts.md) · [模型与思考能力](docs/model-thinking-capabilities.md) · [图片与视频生成](docs/media-generation.md)                                  |
| 技能扩展      | [Skills 管理](docs/skill-management.md) · [技能验证状态](docs/skill-evaluation-status.md)                                                                                       |
| 恢复与诊断    | [上下文恢复](docs/context-recovery.md) · [请求诊断与通知](docs/task-observability.md) · [日志与可观测性](docs/observability.md) · [提示缓存](docs/prompt-cache-optimization.md) |
| 架构与协议    | [系统架构](docs/architecture.md) · [通信协议](docs/protocol-v1.md) · [附件与产物](docs/artifacts.md) · [实现状态](docs/implementation-status.md)                                |

## 参与开发

### 项目结构

```text
apps/
  desktop/       Electron 桌面宿主与打包
  gateway/       本地服务、模型接入与工具管理
  web/           React 工作台
packages/
  pi-adapter/    Pi 运行时适配
  orchestrator/  会话、任务调度与持久化
  protocol/      通信协议与类型
  sandbox/       命令执行、审批与桌面工具
  ...            上下文、附件、轨迹与评估等模块
docs/            功能说明与工程文档
e2e/             Playwright 端到端测试
scripts/         构建、验证与开发脚本
```

技术栈：**TypeScript · React · Vite · Electron · Node.js · SQLite · Pi · Playwright**。

### 常用检查

```sh
npm run check
npm test
npm run test:desktop
npm run test:e2e:install
npm run test:e2e
npm run build
```

提交问题时，请提供操作系统、Node.js 版本、启动方式、复现步骤，以及脱敏后的错误信息。修改功能时，建议同时补充对应测试和文档。

真实模型验收命令可能调用付费服务，请先阅读[开发与配置详解](docs/development-guide.md#verify-a-real-pi-provider)，不要将其当作无费用的普通测试。

<details>
<summary><strong>关于 Pi-Wm 与 Wuming 的命名</strong></summary>

Pi-Wm 是桌面产品名称。内部 `@wuming/*` 包名、协议名称和已有 Wuming 数据目录保持不变，以兼容现有数据与配置。

</details>

## 致谢与第三方说明

- **Pi**：提供项目使用的 Agent 运行时与模型接入基础。
- **[cc-haha](https://github.com/NanmiCoder/cc-haha)**：为 README 信息组织、多 Agent 协作和部分桌面能力提供参考。团队头像与部分 Computer Use 代码的复用说明见 [Agent Teams](docs/agent-teams.md) 和 [Computer Use](docs/computer-use.md)。
- **React、Electron、Playwright 等开源项目**：提供界面、桌面宿主与自动化测试基础。

已复用的 cc-haha 资源保留其 [MIT 许可证文本](apps/web/public/third-party/cc-haha-LICENSE.txt)，桌面运行时代码另有[第三方许可证副本](packages/sandbox/runtime/CC-HAHA-LICENSE.txt)。这些第三方许可不代表 Pi-Wm 整体采用同一许可证；本仓库尚未提供根目录 `LICENSE`，项目整体许可仍待明确。
