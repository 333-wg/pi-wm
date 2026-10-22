# 通用后台执行

耗时工具可以先返回任务编号，让同一个助手继续做独立工作。需要结果的步骤仍然等待真实结果。适用于命令、Python、网页检索、图片与视频生成及已注册的 MCP 工具，不限于某一种素材或页面，也不会自动创建子代理。

例如：启动检查 `src` 的测试后，先整理 `docs` 中的说明；测试结果回来后，助手继续分析失败或完成验收。测试运行时修改它正在读取的文件会影响结果，因此应明确声明任务涉及的路径。

## 执行规则

- `background_start` 调用已有工具，默认等待 1 秒。短任务直接返回结果，长任务返回任务编号；提交成功不等于执行成功。
- 助手根据依赖关系主动选择后台执行，原来的工具调用方式继续可用。它不是把所有调用自动并行化。
- `background_wait` 读取结果，单次等待最多 30 秒；等待超时只返回运行状态，不终止任务。`background_list` 查看状态，`background_cancel` 取消任务。
- 一轮模型输出结束后，宿主检查未收取的结果，必要时等待，并触发同一会话继续处理。所有必要结果处理完后，当前操作才能结束。
- 页面输入框上方显示后台任务、耗时和输出，支持单独停止。停止整个操作会取消该操作的后台任务；迟到结果不会重新唤醒已停止的操作。
- 原工具的参数校验、权限、审批和故障恢复继续生效。后台执行不会增加工具权限。

## 资源与生命周期

命令和 MCP 工具默认独占整个工作目录。`workspace_paths` 可以声明本次任务读取和修改的全部路径，让不重叠的工作继续；空数组只用于完全不访问工作区的操作。路径声明用于协调，不是文件系统沙箱，也不能代替真实权限检查。

同一会话最多同时运行 8 项任务，最多保留 64 条记录；执行超时最多 20 分钟，并受原工具及当前操作自身限制。运行中的相同工具和参数会复用现有任务，避免重复提交。停止后若底层工具还没有真正退出，相关资源继续保持占用。

记录保存在会话目录的 `background-tasks.json`。重启后，原来仍在运行的任务标记为“已中断”，不会自动重发命令或付费请求。此版本不恢复原进程；远程服务也可能在本地取消后继续运行，助手需要检查实际状态。

开发服务器和监听进程继续使用已有的 `preview_start` 生命周期管理，不作为必须等待结束的后台任务。

## 实现与验收

- `packages/pi-adapter/src/background-tasks.ts`：任务、结果、超时、资源协调和持久化。
- `packages/pi-adapter/src/pi-agent-runtime.ts`：运行进度和结果返回后的自动续接。
- `apps/gateway/src/server.ts`：会话授权后的查询和取消接口。
- `apps/web/src/components/BackgroundTasks.tsx`：状态、输出和停止操作。

针对性测试：

```sh
npx vitest run packages/pi-adapter/test/background-tasks.test.ts packages/pi-adapter/test/background-runtime.test.ts packages/pi-adapter/test/default-factory.test.ts packages/pi-adapter/test/system-prompt.test.ts packages/pi-adapter/test/pi-agent-runtime.test.ts apps/gateway/test/server.test.ts
npx tsc -b --pretty false
npm run check --workspace @wuming/web
node scripts/check-tests.mjs --only pi-adapter,gateway
```

自动续接测试既覆盖可控会话，也覆盖真实 Pi 工厂与执行循环；模型响应由本地测试提供，不请求外部模型。浏览器验收使用隔离的网关、真实 Pi 运行时适配层与可控工具。真实模型能否合理拆分依赖还需要在实际使用中观察。

2026-10-21 浏览器验收：后台运行期间独立工作可见；结果完成后自动续接；输出可展开；单项停止、失败反馈和刷新恢复通过。桌面及 390px 手机宽度的 DOM 尺寸检查未发现任务栏横向溢出。截图接口超时，未完成截图视觉验收。

部署时需重启网关加载后端改动；已经运行的非 watch 网关不会因修改源文件自动更新。
