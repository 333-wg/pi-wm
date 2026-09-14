// apps/web/src/components/MemoizedComponents.tsx
// 使用 React.memo 优化的组件包装

import { memo, type ReactNode } from "react";
import type { TranscriptItem, ToolStatus } from "@wuming/protocol";

/**
 * Memo 优化原则：
 * 1. 纯展示组件
 * 2. props 变化频率低
 * 3. 渲染成本较高
 * 4. 子组件数量多
 */

// 工具卡片 - 渲染成本高，props 相对稳定
interface ToolCardProps {
	item: TranscriptItem;
	status?: ToolStatus;
	onRetry?: () => void;
}

export const MemoizedToolCard = memo(
	function ToolCard(props: ToolCardProps) {
		// 实际实现在 ToolCard.tsx
		// 这里只是示例包装
		return null;
	},
	(prevProps, nextProps) => {
		// 自定义比较函数
		return (
			prevProps.item.id === nextProps.item.id &&
			prevProps.status === nextProps.status &&
			prevProps.onRetry === nextProps.onRetry
		);
	}
);

// Markdown 渲染 - 渲染成本高
interface MarkdownProps {
	content: string;
	className?: string;
}

export const MemoizedMarkdown = memo(
	function Markdown({ content, className }: MarkdownProps) {
		return null; // 实际实现
	},
	(prevProps, nextProps) => {
		return prevProps.content === nextProps.content && prevProps.className === nextProps.className;
	}
);

// Diff 视图 - 计算密集
interface DiffViewProps {
	before: string;
	after: string;
	context?: number;
}

export const MemoizedDiffView = memo(
	function DiffView(props: DiffViewProps) {
		return null; // 实际实现
	},
	(prevProps, nextProps) => {
		return (
			prevProps.before === nextProps.before &&
			prevProps.after === nextProps.after &&
			prevProps.context === nextProps.context
		);
	}
);

// 代码块 - 语法高亮成本高
interface CodeBlockProps {
	code: string;
	language?: string;
	showLineNumbers?: boolean;
}

export const MemoizedCodeBlock = memo(
	function CodeBlock({ code, language, showLineNumbers }: CodeBlockProps) {
		return null; // 实际实现
	},
	(prevProps, nextProps) => {
		return (
			prevProps.code === nextProps.code &&
			prevProps.language === nextProps.language &&
			prevProps.showLineNumbers === nextProps.showLineNumbers
		);
	}
);

// Transcript 消息项
interface TranscriptMessageProps {
	item: TranscriptItem;
	index: number;
	onAction?: (action: string) => void;
}

export const MemoizedTranscriptMessage = memo(
	function TranscriptMessage({ item, index, onAction }: TranscriptMessageProps) {
		return null; // 实际实现
	},
	(prevProps, nextProps) => {
		// 只在 item.id 和 index 相同时跳过重渲染
		return prevProps.item.id === nextProps.item.id && prevProps.index === nextProps.index;
	}
);

/**
 * 使用指南：
 *
 * 1. 将现有组件替换为 Memoized 版本：
 *    import { MemoizedToolCard } from './MemoizedComponents';
 *
 * 2. 或者直接在组件定义时使用 memo：
 *    export const MyComponent = memo(function MyComponent(props) { ... });
 *
 * 3. 注意事项：
 *    - 不要 memo 所有组件（有性能开销）
 *    - props 包含函数时，确保函数引用稳定（useCallback）
 *    - props 包含对象时，确保对象引用稳定（useMemo）
 *
 * 4. 效果评估：
 *    - 在 React DevTools Profiler 中查看渲染次数
 *    - Memoized 组件应该只在 props 真正变化时重渲染
 */

/**
 * 性能最佳实践示例：
 *
 * // ❌ 错误：每次渲染都创建新函数
 * <MemoizedToolCard
 *   item={item}
 *   onRetry={() => handleRetry(item.id)}
 * />
 *
 * // ✅ 正确：使用 useCallback 保持引用稳定
 * const handleRetryCallback = useCallback(() => {
 *   handleRetry(item.id);
 * }, [item.id]);
 *
 * <MemoizedToolCard
 *   item={item}
 *   onRetry={handleRetryCallback}
 * />
 */
