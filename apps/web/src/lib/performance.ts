// apps/web/src/lib/performance.ts
// 前端性能优化工具集

import { useEffect, useRef, useCallback } from "react";

/**
 * 防抖 Hook
 * 用于延迟执行频繁触发的操作（如输入框、搜索）
 *
 * @param callback - 要执行的函数
 * @param delay - 延迟时间（毫秒）
 * @returns 防抖后的函数
 */
export function useDebounce<T extends (...args: any[]) => any>(
	callback: T,
	delay: number
): (...args: Parameters<T>) => void {
	const timeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const callbackRef = useRef(callback);

	useEffect(() => {
		callbackRef.current = callback;
	}, [callback]);

	return useCallback(
		(...args: Parameters<T>) => {
			if (timeoutRef.current) {
				clearTimeout(timeoutRef.current);
			}
			timeoutRef.current = setTimeout(() => {
				callbackRef.current(...args);
			}, delay);
		},
		[delay]
	);
}

/**
 * 节流 Hook
 * 限制函数执行频率（如滚动、resize）
 *
 * @param callback - 要执行的函数
 * @param delay - 节流间隔（毫秒）
 * @returns 节流后的函数
 */
export function useThrottle<T extends (...args: any[]) => any>(
	callback: T,
	delay: number
): (...args: Parameters<T>) => void {
	const lastRun = useRef(Date.now());
	const callbackRef = useRef(callback);

	useEffect(() => {
		callbackRef.current = callback;
	}, [callback]);

	return useCallback(
		(...args: Parameters<T>) => {
			const now = Date.now();
			if (now - lastRun.current >= delay) {
				callbackRef.current(...args);
				lastRun.current = now;
			}
		},
		[delay]
	);
}

/**
 * Web Worker 辅助函数
 * 将计算密集型任务移到 Worker 线程
 *
 * @param workerFn - Worker 中执行的函数
 * @returns Promise<结果>
 */
export function runInWorker<T, R>(workerFn: (data: T) => R, data: T): Promise<R> {
	return new Promise((resolve, reject) => {
		const workerCode = `
      self.onmessage = function(e) {
        try {
          const fn = ${workerFn.toString()};
          const result = fn(e.data);
          self.postMessage({ success: true, result });
        } catch (error) {
          self.postMessage({ success: false, error: error.message });
        }
      };
    `;

		const blob = new Blob([workerCode], { type: "application/javascript" });
		const workerUrl = URL.createObjectURL(blob);
		const worker = new Worker(workerUrl);

		worker.onmessage = (e) => {
			URL.revokeObjectURL(workerUrl);
			worker.terminate();

			if (e.data.success) {
				resolve(e.data.result);
			} else {
				reject(new Error(e.data.error));
			}
		};

		worker.onerror = (error) => {
			URL.revokeObjectURL(workerUrl);
			worker.terminate();
			reject(error);
		};

		worker.postMessage(data);
	});
}

/**
 * 惰性初始化 Hook
 * 延迟初始化昂贵的计算或资源
 *
 * @param initializer - 初始化函数
 * @returns 初始化值
 */
export function useLazyInit<T>(initializer: () => T): T {
	const ref = useRef<T | undefined>(undefined);
	if (ref.current === undefined) {
		ref.current = initializer();
	}
	return ref.current;
}

/**
 * 性能测量工具
 * 使用 Performance API 测量代码执行时间
 */
export class PerformanceMonitor {
	private marks = new Map<string, number>();

	start(label: string): void {
		this.marks.set(label, performance.now());
	}

	end(label: string): number | undefined {
		const startTime = this.marks.get(label);
		if (startTime === undefined) return undefined;

		const duration = performance.now() - startTime;
		this.marks.delete(label);

		// 在开发环境打印性能数据
		if (import.meta.env.DEV) {
			console.log(`[Perf] ${label}: ${duration.toFixed(2)}ms`);
		}

		return duration;
	}

	measure(label: string, fn: () => void): number {
		this.start(label);
		fn();
		return this.end(label) ?? 0;
	}

	async measureAsync(label: string, fn: () => Promise<void>): Promise<number> {
		this.start(label);
		await fn();
		return this.end(label) ?? 0;
	}
}

export const perfMonitor = new PerformanceMonitor();

/**
 * 资源预加载工具
 * 预加载图片、字体等资源
 */
export function preloadImage(src: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const img = new Image();
		img.onload = () => resolve();
		img.onerror = reject;
		img.src = src;
	});
}

export function preloadFont(fontFamily: string, src: string): Promise<void> {
	const font = new FontFace(fontFamily, `url(${src})`);
	return font.load().then(() => {
		document.fonts.add(font);
	});
}

/**
 * 请求空闲时间执行
 * 利用浏览器空闲时间执行低优先级任务
 */
export function requestIdleCallback(callback: () => void, options?: { timeout?: number }): number {
	if ("requestIdleCallback" in window) {
		return window.requestIdleCallback(callback, options);
	}
	// Fallback for browsers without requestIdleCallback
	return globalThis.setTimeout(callback, 1) as unknown as number;
}

export function cancelIdleCallback(handle: number): void {
	if ("cancelIdleCallback" in window) {
		window.cancelIdleCallback(handle);
	} else {
		globalThis.clearTimeout(handle);
	}
}

/**
 * 长列表优化：分批渲染
 * 将大量数据分批渲染，避免阻塞主线程
 */
export function useBatchRender<T>(items: T[], batchSize: number = 20): [T[], boolean, () => void] {
	const [displayCount, setDisplayCount] = React.useState(batchSize);
	const [isLoading, setIsLoading] = React.useState(false);

	const loadMore = useCallback(() => {
		if (displayCount >= items.length) return;

		setIsLoading(true);
		requestIdleCallback(() => {
			setDisplayCount((prev) => Math.min(prev + batchSize, items.length));
			setIsLoading(false);
		});
	}, [displayCount, items.length, batchSize]);

	const visibleItems = items.slice(0, displayCount);
	const hasMore = displayCount < items.length;

	return [visibleItems, hasMore && isLoading, loadMore];
}

// TypeScript 声明
declare global {
	interface Window {
		requestIdleCallback(
			callback: (deadline: { timeRemaining: () => number; didTimeout: boolean }) => void,
			options?: { timeout?: number }
		): number;
		cancelIdleCallback(handle: number): void;
	}
}

// 需要添加 React import
import * as React from "react";
