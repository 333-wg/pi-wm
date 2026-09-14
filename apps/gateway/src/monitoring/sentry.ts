// apps/gateway/src/monitoring/sentry.ts
// Sentry 后端错误监控配置

import * as Sentry from "@sentry/node";
import { nodeProfilingIntegration } from "@sentry/profiling-node";
import type { StructuredLogger } from "@wuming/orchestrator";

/**
 * 初始化 Sentry（后端）
 */
export function initSentry(logger?: StructuredLogger) {
	// 只在生产环境启用
	if (process.env.NODE_ENV !== "production") {
		logger?.log("info", "sentry.skipped", { reason: "development mode" });
		return;
	}

	const dsn = process.env.SENTRY_DSN;
	if (!dsn) {
		logger?.log("warn", "sentry.missing_dsn", {});
		return;
	}

	Sentry.init({
		dsn,

		// 环境标识
		environment: process.env.NODE_ENV || "production",

		// 发布版本
		release: process.env.APP_VERSION || "unknown",

		// 集成配置
		integrations: [
			// HTTP 追踪
			Sentry.httpIntegration(),

			// Node 性能分析
			nodeProfilingIntegration(),
		],

		// 性能监控采样率
		tracesSampleRate: 0.1, // 10%

		// Profiling 采样率
		profilesSampleRate: 0.1, // 10%

		// 忽略特定错误
		ignoreErrors: ["ECONNRESET", "EPIPE", "ETIMEDOUT", "socket hang up", "AbortError"],

		// 过滤敏感数据
		beforeSend(event) {
			// 移除环境变量中的敏感信息
			if (event.contexts?.runtime?.name === "node") {
				const env = event.contexts.runtime.env as Record<string, string> | undefined;
				if (env) {
					delete env.SENTRY_DSN;
					delete env.DATABASE_URL;
					delete env.SECRET_KEY;
					delete env.API_KEY;
					// 过滤所有包含 TOKEN, KEY, SECRET, PASSWORD 的环境变量
					for (const key of Object.keys(env)) {
						if (/TOKEN|KEY|SECRET|PASSWORD/i.test(key)) {
							delete env[key];
						}
					}
				}
			}

			// 移除请求头中的敏感信息
			if (event.request?.headers) {
				delete event.request.headers.authorization;
				delete event.request.headers.cookie;
				delete event.request.headers["x-api-key"];
			}

			return event;
		},
	});

	logger?.log("info", "sentry.initialized", { release: process.env.APP_VERSION });
}

/**
 * 捕获错误
 */
export function captureError(
	error: Error,
	context?: {
		tags?: Record<string, string>;
		extra?: Record<string, any>;
		level?: Sentry.SeverityLevel;
	}
) {
	Sentry.withScope((scope) => {
		if (context?.tags) scope.setTags(context.tags);
		if (context?.extra) scope.setExtras(context.extra);
		scope.setLevel(context?.level ?? "error");
		Sentry.captureException(error);
	});
}

/**
 * 捕获消息
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
 * 设置标签
 */
export function setTag(key: string, value: string) {
	Sentry.setTag(key, value);
}

/**
 * 设置额外上下文
 */
export function setContext(name: string, context: Record<string, any>) {
	Sentry.setContext(name, context);
}

/**
 * 性能监控包装器
 */
export function withSentryTransaction<T>(
	name: string,
	op: string,
	fn: (transaction: Sentry.Span) => Promise<T>
): Promise<T> {
	return Sentry.startSpan(
		{
			name,
			op,
		},
		async (span) => {
			try {
				const result = await fn(span as any);
				span.setStatus({ code: 1, message: "ok" }); // 成功
				return result;
			} catch (error) {
				span.setStatus({ code: 2, message: "internal_error" }); // 失败
				throw error;
			}
		}
	);
}

/**
 * Express 错误处理中间件
 */
export function sentryErrorHandler() {
	return (error: unknown, _request: unknown, _response: unknown, next: (error: unknown) => void) => {
		const statusCode =
			typeof error === "object" && error !== null && "statusCode" in error ? Number(error.statusCode) : undefined;
		if (statusCode === undefined || !Number.isFinite(statusCode) || statusCode >= 500) {
			Sentry.captureException(error);
		}
		next(error);
	};
}

/**
 * 集成到现有日志系统
 */
export function createSentryLogger(baseLogger: StructuredLogger): StructuredLogger {
	return {
		log(level, event, data) {
			// 调用原始 logger
			baseLogger.log(level, event, data);
			const fields = data ?? {};

			// 同时发送到 Sentry（仅 error 和 warn）
			if (level === "error") {
				const error = fields.error instanceof Error ? fields.error : new Error(event);
				captureError(error, {
					tags: { event },
					extra: fields,
					level: "error",
				});
			} else if (level === "warn" && fields.critical) {
				captureMessage(`[${event}] ${JSON.stringify(fields)}`, "warning");
			}
		},
	};
}

/**
 * 使用示例：
 *
 * // 在 main.ts 中初始化
 * import { initSentry, createSentryLogger } from './monitoring/sentry';
 * initSentry(logger);
 * const logger = createSentryLogger(baseLogger);
 *
 * // 在代码中使用
 * try {
 *   await riskyOperation();
 * } catch (error) {
 *   captureError(error, {
 *     tags: { component: 'gateway' },
 *     extra: { sessionId: 'abc123' }
 *   });
 * }
 *
 * // 性能监控
 * await withSentryTransaction('process-session', 'task', async (tx) => {
 *   await processSession(sessionId);
 * });
 */
