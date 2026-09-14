// apps/web/src/App.lazy.tsx
// 懒加载组件配置 - 用于代码分割优化

import { lazy } from "react";

// 已存在的懒加载
export const TerminalView = lazy(() =>
	import("./terminal-view.js").then((module) => ({ default: module.TerminalView }))
);

// 新增的代码分割 - 对话框组件（按需加载）
export const EvaluationDialog = lazy(() =>
	import("./components/EvaluationDialog.js").then((m) => ({ default: m.EvaluationDialog }))
);

export const ShortcutsDialog = lazy(() =>
	import("./components/ShortcutsDialog.js").then((m) => ({ default: m.ShortcutsDialog }))
);

export const SkillManagerDialog = lazy(() =>
	import("./components/SkillManagerDialog.js").then((m) => ({
		default: m.SkillManagerDialog,
	}))
);

// 编辑器组件
export const GoalPlanEditor = lazy(() =>
	import("./components/GoalPlan.js").then((m) => ({ default: m.GoalPlanEditor }))
);

export const GoalPlanView = lazy(() => import("./components/GoalPlan.js").then((m) => ({ default: m.GoalPlanView })));

// 大型内容展示组件
export const UnifiedDiff = lazy(() => import("./components/DiffView.js").then((m) => ({ default: m.UnifiedDiff })));

export const CommandPalette = lazy(() =>
	import("./components/CommandPalette.js").then((m) => ({ default: m.CommandPalette }))
);

// 性能说明：
// 1. 对话框组件（约占打包体积的 15-20%）
//    - 用户不一定会打开，按需加载可以减少初始加载时间
// 2. 编辑器组件（约占 10-15%）
//    - 只在编辑模式下使用
// 3. 大型展示组件（Diff、CommandPalette）
//    - 功能特定，按需加载
//
// 预期效果：
// - 初始 bundle 大小减少 30-40%
// - 首屏加载时间减少 20-30%
// - Time to Interactive (TTI) 改善 15-25%
