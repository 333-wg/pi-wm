# Verification Guard Design

Status: historical proposal; backend evidence checking is implemented, while the UI section below remains proposed. See [Agent verification workflow](agent-verification-workflow.md) for current behavior and limitations.  
Created: 2026-09-07  
Issue: 验证循环现在完全依赖 prompt guidance，model 可能跳过验证就报告完成

## 目标

在 orchestrator 层添加一个轻量的结构化检查，当检测到代码变更但缺少验证步骤时，向用户发出明确警告。

## 非目标

- 不强制阻止 turn 完成（用户可能有意跳过验证）
- 不替代 skill 里的验证指导
- 不解析命令输出判断测试是否通过（那是更高级的结构化验证，留给 evaluation 系统）

## 检测逻辑

### 1. 识别代码变更 turn

当 turn 的 `tools` 包含以下任一工具时，视为代码变更：

- `write_file`
- `edit`

排除纯读取操作（`read_file`、`grep`、`glob`、`ls`）和纯搜索（`web_search`、`web_fetch`）。

### 2. 识别验证步骤

验证工具包括：

- `exec` — 跑构建、测试、lint
- `run_python` — 计算验证
- `preview_start` + `preview_status` — 启动开发服务器
- `browser_open` / `browser_snapshot` / `browser_action` — 前端验证

如果代码变更 turn 里**没有调用任何验证工具**，生成警告。

### 3. 警告形式

在 `#commitRuntimeCompletion` 完成后、`settleOperation` 之前，检查 `result.tools`：

```typescript
if (hasCodeChanges && !hasVerification) {
	// 插入一个 session event: session.verification.missing
	const warningEvent: SessionEvent = {
		type: "session.verification.missing",
		eventId: this.#idFactory(),
		sessionId: operation.sessionId,
		revision: snapshot.revision + 1,
		timestamp: now,
		operationId: operation.id,
		changedTools: ["write_file", "edit"], // 实际调用的变更工具
	};
	events.push(warningEvent);
	snapshot = reduceSessionEvent(snapshot, warningEvent);
}
```

这个事件会：

- 记录在 session event log 里，可追溯
- 在 UI 的 Run rail 里显示为 ⚠️ 图标
- 不阻止 operation 完成

## Protocol 变更

### `packages/protocol/src/index.ts`

添加新的 SessionEvent 类型：

```typescript
StrictObject({
  type: Type.Literal('session.verification.missing'),
  eventId: Id,
  sessionId: Id,
  revision: Revision,
  timestamp: Timestamp,
  operationId: Id,
  changedTools: Type.Array(Id, { minItems: 1, maxItems: 10 }),
}),
```

### `packages/domain/src/index.ts`

在 `reduceSessionEvent` 里处理这个事件：

```typescript
case 'session.verification.missing':
  return {
    ...state,
    revision: event.revision,
    verificationWarnings: [
      ...(state.verificationWarnings ?? []),
      {
        id: event.eventId,
        operationId: event.operationId,
        changedTools: event.changedTools,
        createdAt: event.timestamp,
      },
    ],
  };
```

### `SessionSnapshot` 扩展

```typescript
verificationWarnings?: Array<{
  id: string;
  operationId: string;
  changedTools: string[];
  createdAt: number;
}>;
```

## UI 变更

### `apps/web/src/App.tsx` (Run rail)

在 operation 卡片里，如果 `session.verificationWarnings` 包含对应的 `operationId`，显示：

```tsx
{
	verificationWarning && <div class="verification-warning">⚠️ 未检测到验证步骤 — 代码已修改但未运行测试或构建</div>;
}
```

## 实施步骤

1. ✅ 写设计文档（本文件）
2. 扩展 protocol: 添加 `session.verification.missing` event schema
3. 扩展 domain: 在 reducer 里处理新事件
4. 实现检测逻辑: 在 `orchestrator.ts` 的 `#commitRuntimeCompletion` 里插入检查
5. UI: 在 Run rail 里渲染警告
6. 测试: 写一个单元测试验证检测逻辑，写一个 E2E 测试验证 UI 显示

## 未来扩展

- 结构化验证结果收集：解析 `exec` 输出，提取测试通过/失败数，存到 operation metadata
- 与 `code-change` skill 集成：如果 skill 被选中，提高验证期望
- 验证覆盖率报告：在 Run rail 里显示"本次 turn 修改了 3 个文件，测试了 2 个"
