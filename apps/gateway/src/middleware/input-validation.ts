// apps/gateway/src/middleware/input-validation.ts
// 输入验证和清理中间件

import type { IncomingMessage } from "node:http";

/**
 * 验证和清理字符串输入
 */
export function sanitizeString(input: string, options?: { maxLength?: number }): string {
	let sanitized = input
		// 移除控制字符（除了换行和制表符）
		.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
		// 规范化 Unicode
		.normalize("NFC");

	if (options?.maxLength) {
		sanitized = sanitized.slice(0, options.maxLength);
	}

	return sanitized;
}

/**
 * 验证文件名安全性
 */
export function isValidFilename(filename: string): boolean {
	// 不允许路径遍历
	if (filename.includes("..") || filename.includes("/") || filename.includes("\\")) {
		return false;
	}

	// 不允许特殊文件名
	const forbidden = ["CON", "PRN", "AUX", "NUL", "COM1", "LPT1"];
	const upper = filename.toUpperCase();
	if (forbidden.some((name) => upper === name || upper.startsWith(name + "."))) {
		return false;
	}

	// 不允许控制字符和特殊字符
	if (/[\x00-\x1F<>:"|?*]/.test(filename)) {
		return false;
	}

	return true;
}

/**
 * 验证 URL 安全性
 */
export function isValidUrl(url: string): boolean {
	try {
		const parsed = new URL(url);

		// 只允许 http/https
		if (!["http:", "https:"].includes(parsed.protocol)) {
			return false;
		}

		// 不允许本地地址（除非在开发环境）
		if (process.env.NODE_ENV !== "development") {
			const hostname = parsed.hostname.toLowerCase();
			const forbidden = ["localhost", "127.0.0.1", "0.0.0.0", "::1", "169.254."];
			if (forbidden.some((f) => hostname === f || hostname.startsWith(f))) {
				return false;
			}
		}

		return true;
	} catch {
		return false;
	}
}

/**
 * 验证 email 格式
 */
export function isValidEmail(email: string): boolean {
	const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
	return emailRegex.test(email) && email.length <= 254;
}

/**
 * 验证命令注入风险
 */
export function containsCommandInjection(input: string): boolean {
	// 检测常见的命令注入模式
	const dangerousPatterns = [
		/[;&|`$()]/, // Shell 特殊字符
		/\bexec\b/i, // exec 命令
		/\beval\b/i, // eval 命令
		/\brm\s+-rf\b/i, // 危险删除
		/\bcurl\b/i, // 网络请求
		/\bwget\b/i, // 网络请求
	];

	return dangerousPatterns.some((pattern) => pattern.test(input));
}

/**
 * SQL 注入检测（基础版）
 */
export function containsSQLInjection(input: string): boolean {
	const sqlPatterns = [
		/(\b(SELECT|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|EXEC|EXECUTE)\b)/i,
		/(--|#|\/\*|\*\/)/, // SQL 注释
		/(\bOR\b.*=.*|\bAND\b.*=.*)/i, // 常见注入模式
		/(\bUNION\b.*\bSELECT\b)/i,
	];

	return sqlPatterns.some((pattern) => pattern.test(input));
}

/**
 * XSS 检测
 */
export function containsXSS(input: string): boolean {
	const xssPatterns = [
		/<script\b[^>]*>(.*?)<\/script>/gi,
		/<iframe\b[^>]*>(.*?)<\/iframe>/gi,
		/javascript:/gi,
		/on\w+\s*=/gi, // 事件处理器
		/<object\b[^>]*>/gi,
		/<embed\b[^>]*>/gi,
	];

	return xssPatterns.some((pattern) => pattern.test(input));
}

/**
 * 验证请求大小
 */
export function validateRequestSize(
	req: IncomingMessage,
	maxBytes: number
): Promise<{ valid: boolean; error?: string }> {
	return new Promise((resolve) => {
		let size = 0;

		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > maxBytes) {
				req.destroy();
				resolve({
					valid: false,
					error: `Request body exceeds maximum size of ${maxBytes} bytes`,
				});
			}
		});

		req.on("end", () => {
			resolve({ valid: true });
		});

		req.on("error", () => {
			resolve({ valid: false, error: "Request error" });
		});
	});
}

/**
 * 通用输入验证规则
 */
export interface ValidationRule {
	type: "string" | "number" | "boolean" | "email" | "url" | "filename";
	required?: boolean;
	minLength?: number;
	maxLength?: number;
	min?: number;
	max?: number;
	pattern?: RegExp;
	custom?: (value: any) => boolean;
}

/**
 * 验证输入对象
 */
export function validateInput(
	input: Record<string, any>,
	rules: Record<string, ValidationRule>
): { valid: boolean; errors: string[] } {
	const errors: string[] = [];

	for (const [field, rule] of Object.entries(rules)) {
		const value = input[field];

		// Required 检查
		if (rule.required && (value === undefined || value === null || value === "")) {
			errors.push(`${field} is required`);
			continue;
		}

		// 跳过空值（非 required）
		if (value === undefined || value === null) {
			continue;
		}

		// 类型检查
		switch (rule.type) {
			case "string":
				if (typeof value !== "string") {
					errors.push(`${field} must be a string`);
					break;
				}
				if (rule.minLength && value.length < rule.minLength) {
					errors.push(`${field} must be at least ${rule.minLength} characters`);
				}
				if (rule.maxLength && value.length > rule.maxLength) {
					errors.push(`${field} must be at most ${rule.maxLength} characters`);
				}
				if (rule.pattern && !rule.pattern.test(value)) {
					errors.push(`${field} has invalid format`);
				}
				break;

			case "number":
				if (typeof value !== "number" || isNaN(value)) {
					errors.push(`${field} must be a number`);
					break;
				}
				if (rule.min !== undefined && value < rule.min) {
					errors.push(`${field} must be at least ${rule.min}`);
				}
				if (rule.max !== undefined && value > rule.max) {
					errors.push(`${field} must be at most ${rule.max}`);
				}
				break;

			case "boolean":
				if (typeof value !== "boolean") {
					errors.push(`${field} must be a boolean`);
				}
				break;

			case "email":
				if (typeof value !== "string" || !isValidEmail(value)) {
					errors.push(`${field} must be a valid email`);
				}
				break;

			case "url":
				if (typeof value !== "string" || !isValidUrl(value)) {
					errors.push(`${field} must be a valid URL`);
				}
				break;

			case "filename":
				if (typeof value !== "string" || !isValidFilename(value)) {
					errors.push(`${field} must be a valid filename`);
				}
				break;
		}

		// 自定义验证
		if (rule.custom && !rule.custom(value)) {
			errors.push(`${field} failed custom validation`);
		}
	}

	return {
		valid: errors.length === 0,
		errors,
	};
}

/**
 * 使用示例：
 *
 * // 验证用户输入
 * const result = validateInput(userInput, {
 *   username: { type: 'string', required: true, minLength: 3, maxLength: 20 },
 *   email: { type: 'email', required: true },
 *   age: { type: 'number', min: 18, max: 120 },
 *   website: { type: 'url', required: false },
 * });
 *
 * if (!result.valid) {
 *   return { error: result.errors.join(', ') };
 * }
 */
