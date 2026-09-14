// apps/web/src/lib/sentry.ts
// Sentry 前端错误监控配置

import * as Sentry from "@sentry/react";

/**
 * 初始化 Sentry
 * 应在应用入口点调用一次
 */
export function initSentry() {
	// 只在生产环境启用
	if (!import.meta.env.PROD) {
		console.log("[Sentry] Skipped in development mode");
		return;
	}

	Sentry.init({
		// DSN 从环境变量获取
		dsn: import.meta.env.VITE_SENTRY_DSN,

		// 环境标识
		environment: import.meta.env.VITE_ENVIRONMENT || "production",

		// 发布版本（用于追踪问题）
		release: import.meta.env.VITE_APP_VERSION || "unknown",

		// 集成配置
		integrations: [
			// 浏览器追踪
			Sentry.browserTracingIntegration(),

			// 性能监控
			Sentry.replayIntegration({
				// Session Replay 配置
				maskAllText: true, // 隐藏所有文本（隐私保护）
				blockAllMedia: true, // 阻止媒体记录
			}),
		],

		// 性能监控采样率
		tracesSampleRate: 0.1, // 10% 的事务被追踪

		// Replay 采样率
		replaysSessionSampleRate: 0.01, // 1% 正常会话
		replaysOnErrorSampleRate: 1.0, // 100% 错误会话

		// 忽略特定错误
		ignoreErrors: [
			// 浏览器扩展错误
			"top.GLOBALS",
			"canvas.contentDocument",
			"MyApp_RemoveAllHighlights",
			// 网络错误（通常是用户网络问题）
			"NetworkError",
			"Network request failed",
			// 取消的请求
			"AbortError",
			"The user aborted a request",
		],

		// 过滤敏感数据
		beforeSend(event) {
			// 移除敏感信息
			if (event.request) {
				// 移除 Authorization 头
				delete event.request.headers?.Authorization;
				delete event.request.headers?.authorization;

				// 清理 URL 中的 token
				if (event.request.url) {
					event.request.url = event.request.url.replace(/token=[^&]+/, "token=***");
				}
			}

			// 过滤用户 IP
			if (event.user) {
				delete event.user.ip_address;
			}

			return event;
		},

		// 性能监控前的处理
		beforeSendTransaction(transaction) {
			// 过滤敏感数据
			if (transaction.request) {
				delete transaction.request.headers?.Authorization;
			}
			return transaction;
		},
	});

	console.log("[Sentry] Initialized successfully");
}

/**
 * 手动捕获错误
 */
export function captureError(error: Error, context?: Record<string, any>) {
	Sentry.withScope((scope) => {
		if (context) scope.setExtras(context);
		Sentry.captureException(error);
	});
}

/**
 * 手动捕获消息
 */
export function captureMessage(message: string, level: Sentry.SeverityLevel = "info") {
	Sentry.captureMessage(message, level);
}

/**
 * 设置用户上下文
 */
export function setUser(user: { id: string; email?: string; username?: string }) {
	Sentry.setUser(user);
}

/**
 * 清除用户上下文
 */
export function clearUser() {
	Sentry.setUser(null);
}

/**
 * 添加面包屑（用户操作追踪）
 */
export function addBreadcrumb(breadcrumb: {
	message: string;
	category?: string;
	level?: Sentry.SeverityLevel;
	data?: Record<string, any>;
}) {
	Sentry.addBreadcrumb(breadcrumb);
}

/**
 * 性能监控：开始事务
 */
export function startTransaction(name: string, op: string) {
	return Sentry.startInactiveSpan({
		name,
		op,
	});
}

/**
 * 使用示例：
 *
 * // 在 main.tsx 中初始化
 * import { initSentry } from './lib/sentry';
 * initSentry();
 *
 * // 在组件中使用
 * try {
 *   await fetchData();
 * } catch (error) {
 *   captureError(error, { component: 'DataFetcher' });
 * }
 *
 * // 性能监控
 * const transaction = startTransaction('load-transcript', 'http');
 * // ... 执行操作
 * transaction.end();
 */
