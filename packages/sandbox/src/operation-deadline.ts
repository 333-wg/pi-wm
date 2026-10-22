import { SandboxError } from "./errors.js";

/** Reject promptly on cancellation while also stopping the underlying browser operation. */
export async function withAbort<T>(
	signal: AbortSignal | undefined,
	operation: () => Promise<T>,
	onAbort?: () => Promise<unknown>
): Promise<T> {
	signal?.throwIfAborted();
	if (!signal) return operation();
	let abort!: () => void;
	const cancelled = new Promise<never>((_, reject) => {
		abort = () => {
			if (onAbort) void onAbort().catch(() => undefined);
			reject(signal.reason);
		};
		signal.addEventListener("abort", abort, { once: true });
	});
	try {
		return await Promise.race([operation(), cancelled]);
	} finally {
		signal.removeEventListener("abort", abort);
	}
}

export async function withDeadline<T>(
	deadline: number,
	signal: AbortSignal | undefined,
	operation: (signal: AbortSignal) => Promise<T>
): Promise<T> {
	signal?.throwIfAborted();
	const remaining = deadline - Date.now();
	const timeoutError = new SandboxError(
		"process_timeout",
		"Browser evidence time budget exhausted; report missing evidence without replaying completed steps"
	);
	if (remaining <= 0) throw timeoutError;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(timeoutError), remaining);
	const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
	try {
		return await withAbort(combined, () => operation(combined));
	} finally {
		clearTimeout(timer);
	}
}
