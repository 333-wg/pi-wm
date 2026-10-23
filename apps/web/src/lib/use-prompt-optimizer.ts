import { useEffect, useRef, useState } from "react";
import type { ModelRef, PromptOptimizeRequest, PromptOptimizeResult, ThinkingLevel } from "@wuming/protocol";

export function usePromptOptimizer(options: {
	token: string;
	workspaceId: string | undefined;
	model: ModelRef | undefined;
	thinkingLevel: ThinkingLevel;
	disabled: boolean;
	text: string;
	editKey: unknown;
	onApply: (text: string) => void;
	failureMessage: string;
}) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	const [undo, setUndo] = useState<{ original: string; optimized: string }>();
	const request = useRef<AbortController | undefined>(undefined);
	const latest = useRef(options);
	latest.current = options;
	const cancel = () => {
		request.current?.abort();
		request.current = undefined;
		setBusy(false);
	};
	useEffect(() => {
		cancel();
		setError(undefined);
		setUndo(undefined);
		return () => {
			request.current?.abort();
			request.current = undefined;
		};
	}, [
		options.token,
		options.workspaceId,
		options.model?.provider,
		options.model?.id,
		options.thinkingLevel,
		options.disabled,
		options.editKey,
	]);
	useEffect(() => {
		setUndo((current) => (current && current.optimized !== options.text ? undefined : current));
	}, [options.text]);
	const optimize = async () => {
		if (
			request.current ||
			options.disabled ||
			!options.model ||
			!options.workspaceId ||
			!options.text.trim() ||
			options.text.length > 16000 ||
			options.text.trimStart().startsWith("/")
		)
			return;
		const snapshot = options;
		const controller = new AbortController();
		request.current = controller;
		setBusy(true);
		setError(undefined);
		setUndo(undefined);
		const timeout = setTimeout(() => {
			if (request.current !== controller) return;
			controller.abort();
			request.current = undefined;
			setBusy(false);
			setError(snapshot.failureMessage);
		}, 125000);
		try {
			const input: PromptOptimizeRequest = {
				text: snapshot.text,
				model: snapshot.model!,
				workspaceId: snapshot.workspaceId!,
				thinkingLevel: snapshot.thinkingLevel,
			};
			const response = await fetch("/api/prompt/optimize", {
				method: "POST",
				headers: { Authorization: `Bearer ${snapshot.token}`, "Content-Type": "application/json" },
				body: JSON.stringify(input),
				signal: controller.signal,
			});
			if (!response.ok) throw new Error(snapshot.failureMessage);
			const result = (await response.json()) as PromptOptimizeResult;
			const current = latest.current;
			if (
				request.current !== controller ||
				controller.signal.aborted ||
				current.text !== snapshot.text ||
				current.workspaceId !== snapshot.workspaceId ||
				current.editKey !== snapshot.editKey ||
				current.model?.id !== snapshot.model?.id ||
				current.model?.provider !== snapshot.model?.provider
			)
				return;
			if (typeof result.text !== "string" || !result.text.trim() || result.text.length > 32000)
				throw new Error(snapshot.failureMessage);
			setUndo({ original: snapshot.text, optimized: result.text });
			current.onApply(result.text);
		} catch {
			if (request.current === controller && !controller.signal.aborted) setError(snapshot.failureMessage);
		} finally {
			clearTimeout(timeout);
			if (request.current === controller) {
				request.current = undefined;
				setBusy(false);
			}
		}
	};
	return {
		busy,
		error,
		optimize,
		cancel,
		canUndo: undo?.optimized === options.text,
		undo: () => {
			if (undo?.optimized === latest.current.text) latest.current.onApply(undo.original);
			setUndo(undefined);
		},
	};
}
