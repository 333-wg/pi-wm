// apps/gateway/src/middleware/security.ts
// 安全中间件：CSP、安全头部、Rate Limiting

import type { IncomingMessage, ServerResponse } from "node:http";
import type { StructuredLogger } from "@wuming/orchestrator";

/**
 * Content Security Policy 配置
 * 防止 XSS、数据注入等攻击
 */
export const CSP_POLICY = {
	// 默认策略：只允许同源
	"default-src": ["'self'"],

	// 脚本：允许同源 + unsafe-inline（React 需要）+ unsafe-eval（开发模式）
	"script-src": [
		"'self'",
		"'unsafe-inline'", // React inline scripts
		...(process.env.NODE_ENV === "development" ? ["'unsafe-eval'"] : []),
	],

	// 样式：允许同源 + unsafe-inline（styled-components）
	"style-src": ["'self'", "'unsafe-inline'"],

	// 图片：允许同源 + data URLs + blob URLs
	"img-src": ["'self'", "data:", "blob:"],

	// 字体：允许同源 + data URLs
	"font-src": ["'self'", "data:"],

	// 连接：允许同源 + WebSocket
	"connect-src": ["'self'", "ws://localhost:*", "ws://127.0.0.1:*", "wss://localhost:*", "wss://127.0.0.1:*"],

	// 媒体：允许同源
	"media-src": ["'self'"],

	// 对象：不允许（防止 Flash、Java applet）
	"object-src": ["'none'"],

	// Frame：只允许同源
	"frame-src": ["'self'"],

	// Base URI：限制为同源
	"base-uri": ["'self'"],

	// Form action：限制为同源
	"form-action": ["'self'"],

	// Frame ancestors：不允许被嵌入（防止 Clickjacking）
	"frame-ancestors": ["'none'"],

	// 升级不安全请求（生产环境）
	...(process.env.NODE_ENV === "production" ? { "upgrade-insecure-requests": [] } : {}),
};

/**
 * 生成 CSP 头部字符串
 */
function buildCSPHeader(policy: typeof CSP_POLICY): string {
	return Object.entries(policy)
		.map(([directive, values]) => {
			if (values.length === 0) return directive;
			return `${directive} ${values.join(" ")}`;
		})
		.join("; ");
}

/**
 * 安全头部配置
 */
export interface SecurityHeaders {
	// Content Security Policy
	"Content-Security-Policy"?: string;

	// 防止 MIME 类型嗅探
	"X-Content-Type-Options": "nosniff";

	// 防止点击劫持
	"X-Frame-Options": "DENY" | "SAMEORIGIN";

	// XSS 保护（旧浏览器）
	"X-XSS-Protection": "1; mode=block";

	// Referrer 政策
	"Referrer-Policy": "strict-origin-when-cross-origin";

	// 权限策略
	"Permissions-Policy"?: string;

	// HSTS（生产环境）
	"Strict-Transport-Security"?: string;
}

/**
 * 获取安全头部
 */
export function getSecurityHeaders(options?: { enableCSP?: boolean; enableHSTS?: boolean }): SecurityHeaders {
	const headers: SecurityHeaders = {
		"X-Content-Type-Options": "nosniff",
		"X-Frame-Options": "DENY",
		"X-XSS-Protection": "1; mode=block",
		"Referrer-Policy": "strict-origin-when-cross-origin",
		"Permissions-Policy": ["geolocation=()", "microphone=()", "camera=()", "payment=()", "usb=()"].join(", "),
	};

	// CSP
	if (options?.enableCSP !== false) {
		headers["Content-Security-Policy"] = buildCSPHeader(CSP_POLICY);
	}

	// HSTS（仅生产环境 + HTTPS）
	if (options?.enableHSTS && process.env.NODE_ENV === "production") {
		headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains; preload";
	}

	return headers;
}

/**
 * Rate Limiting 实现
 * 基于 Token Bucket 算法
 */
export class RateLimiter {
	private buckets = new Map<string, TokenBucket>();
	private cleanupInterval: NodeJS.Timeout;

	constructor(
		private config: {
			// 每个时间窗口允许的请求数
			requestsPerWindow: number;
			// 时间窗口大小（毫秒）
			windowMs: number;
			// 清理间隔（毫秒）
			cleanupIntervalMs?: number;
		},
		private logger?: StructuredLogger
	) {
		// 定期清理过期的 bucket
		this.cleanupInterval = setInterval(() => {
			this.cleanup();
		}, config.cleanupIntervalMs || 60000);
	}

	/**
	 * 检查是否允许请求
	 */
	check(identifier: string): { allowed: boolean; retryAfter?: number } {
		let bucket = this.buckets.get(identifier);

		if (!bucket) {
			bucket = new TokenBucket(this.config.requestsPerWindow, this.config.windowMs);
			this.buckets.set(identifier, bucket);
		}

		const allowed = bucket.consume();

		if (!allowed) {
			const retryAfter = Math.ceil(bucket.getRefillTime() / 1000);
			this.logger?.log("warn", "rate_limit.exceeded", { identifier, retryAfter });
			return { allowed: false, retryAfter };
		}

		return { allowed: true };
	}

	/**
	 * 清理过期的 bucket
	 */
	private cleanup(): void {
		const now = Date.now();
		let removed = 0;

		for (const [identifier, bucket] of this.buckets.entries()) {
			if (now - bucket.lastRefill > this.config.windowMs * 2) {
				this.buckets.delete(identifier);
				removed++;
			}
		}

		if (removed > 0) {
			this.logger?.log("debug", "rate_limit.cleanup", { removed, remaining: this.buckets.size });
		}
	}

	/**
	 * 销毁 Rate Limiter
	 */
	destroy(): void {
		clearInterval(this.cleanupInterval);
		this.buckets.clear();
	}
}

/**
 * Token Bucket 实现
 */
class TokenBucket {
	private tokens: number;
	public lastRefill: number;

	constructor(
		private capacity: number,
		private refillIntervalMs: number
	) {
		this.tokens = capacity;
		this.lastRefill = Date.now();
	}

	/**
	 * 消耗一个 token
	 */
	consume(): boolean {
		this.refill();

		if (this.tokens > 0) {
			this.tokens--;
			return true;
		}

		return false;
	}

	/**
	 * 补充 tokens
	 */
	private refill(): void {
		const now = Date.now();
		const elapsed = now - this.lastRefill;

		if (elapsed >= this.refillIntervalMs) {
			this.tokens = this.capacity;
			this.lastRefill = now;
		}
	}

	/**
	 * 获取下次补充时间（毫秒）
	 */
	getRefillTime(): number {
		const now = Date.now();
		const elapsed = now - this.lastRefill;
		return Math.max(0, this.refillIntervalMs - elapsed);
	}
}

/**
 * Rate Limiting 中间件
 */
export function createRateLimitMiddleware(
	limiter: RateLimiter,
	options?: {
		// 提取标识符的函数（默认使用 IP）
		getIdentifier?: (req: IncomingMessage) => string;
		// 白名单
		whitelist?: string[];
	}
) {
	const getIdentifier =
		options?.getIdentifier ||
		((req: IncomingMessage) => {
			// 从 X-Forwarded-For 或 socket 获取 IP
			const forwarded = req.headers["x-forwarded-for"];
			if (typeof forwarded === "string") {
				return forwarded.split(",")[0]?.trim() || "unknown";
			}
			return req.socket.remoteAddress || "unknown";
		});

	return function rateLimitMiddleware(req: IncomingMessage, res: ServerResponse, next: () => void): void {
		const identifier = getIdentifier(req);

		// 白名单检查
		if (options?.whitelist?.includes(identifier)) {
			return next();
		}

		const { allowed, retryAfter } = limiter.check(identifier);

		if (!allowed) {
			res.writeHead(429, {
				"Content-Type": "application/json",
				"Retry-After": String(retryAfter || 60),
			});
			res.end(
				JSON.stringify({
					error: "Too Many Requests",
					message: "Rate limit exceeded. Please try again later.",
					retryAfter,
				})
			);
			return;
		}

		next();
	};
}

/**
 * 应用安全头部中间件
 */
export function applySecurityHeaders(req: IncomingMessage, res: ServerResponse, next: () => void): void {
	const headers = getSecurityHeaders({
		enableCSP: true,
		enableHSTS: process.env.NODE_ENV === "production",
	});

	for (const [key, value] of Object.entries(headers)) {
		if (value) {
			res.setHeader(key, value);
		}
	}

	next();
}

/**
 * 使用示例：
 *
 * // 在 server.ts 中：
 * import { RateLimiter, createRateLimitMiddleware, applySecurityHeaders } from './middleware/security.js';
 *
 * // 创建 Rate Limiter
 * const rateLimiter = new RateLimiter({
 *   requestsPerWindow: 100,  // 每分钟 100 个请求
 *   windowMs: 60000,         // 1 分钟
 * }, logger);
 *
 * const rateLimitMiddleware = createRateLimitMiddleware(rateLimiter, {
 *   whitelist: ['127.0.0.1', '::1'],  // 本地请求不限制
 * });
 *
 * // HTTP 服务器
 * const server = createServer((req, res) => {
 *   // 1. 应用安全头部
 *   applySecurityHeaders(req, res, () => {
 *     // 2. Rate limiting
 *     rateLimitMiddleware(req, res, () => {
 *       // 3. 业务逻辑
 *       handleRequest(req, res);
 *     });
 *   });
 * });
 */
