# 独立定时任务

## 源码对标

参考仓库：NanmiCoder/cc-haha，核对提交 `2f8d819d50123eb20e4e8f9fce197b569ce142c3`（2026-09-23 获取）。

- `desktop/src/pages/ScheduledTasks.tsx`：独立任务列表、创建与编辑入口。
- `src/server/services/cronService.ts`：独立任务配置，固定 `bypassPermissions`。
- `src/server/services/cronScheduler.ts`：当前分钟匹配、防同任务重叠、独立模型和目录、执行记录。
- `src/server/api/scheduled-tasks.ts`：任务与日志管理 API。

这里对齐行为和交互，不移植其 Bun/Claude CLI 执行器；继续使用现有 Gateway、SQLite、Goal 和 Pi runtime。本次未复制上游实现代码。

## 已实现

- 侧边栏「定时任务」与移动端快捷入口，独立于当前聊天。
- 名称、描述、提示词、独立模型、工作项目，以及新建/编辑弹窗。
- 任务固定完全访问（unrestricted + never），不改变普通聊天权限，不获取操作系统管理员权限。
- 日历：每日、每周/工作日、每月、时区与未来三次预览；另保留一次性和固定分钟间隔。
- 启用、禁用、立即执行、删除确认、执行日志、输出摘要与完整运行对话。
- 执行配置在领取运行时快照；编辑项目或模型不影响已领取的运行。
- 同一任务不重叠执行。其他任务的调度不等待长任务结束。
- 项目权限校验、只读用户限制、数据库原子领取与创建幂等。

## 错过的触发

新独立任务只运行当前分钟内已到点的计划。更早的计划会跳过；恢复后不会补跑。日历和间隔任务推进到当前或未来的有效时刻，错过的一次性任务结束而不执行。同分钟内重启不会重复领取。

“不补跑”指未触发的计划，不是丢弃已经领取的执行记录；已领取任务仍使用现有执行恢复机制。

只有本地服务运行且电脑唤醒才会触发。工作项目决定执行目录，但完全访问模式下目录不是安全隔离边界。

## 兼容范围

原会话自动化保留在 `/automations` 命令中。其原有审批继承、多步骤计划、评审循环及合并补跑语义不变，不会静默迁移成完全访问任务。

任务内部执行上下文从聊天列表和搜索中隐藏，也不允许通过普通聊天命令编辑。历史运行会话仍保留。

## 尚未对齐

- 自定义五段 Cron、独立的每小时频率控件。
- Git worktree 隔离。
- 每任务桌面/IM 通知设置。
- 列表运行耗时包含分派和排队时间；尚未提供独立的超时状态展示。

## 验证命令

```sh
npm run check
npm run build
npx vitest run packages/protocol/test packages/orchestrator/test/automation-calendar.test.ts packages/orchestrator/test/scheduled-tasks.test.ts
npx playwright test e2e/scheduled-tasks.spec.ts e2e/automation-calendar.spec.ts e2e/automation.spec.ts
```

独立任务浏览器用例覆盖 1440px、390px、320px；日历触发用例等待真实时钟到点，不通过“立即执行”模拟调度。
