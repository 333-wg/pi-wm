import type { Page } from "playwright";
import { Type, type Static } from "typebox";
import { SandboxError } from "./errors.js";

export const browserWorkflowStep = Type.Object(
	{
		action: Type.Union([
			Type.Literal("click"),
			Type.Literal("hover"),
			Type.Literal("fill"),
			Type.Literal("type"),
			Type.Literal("check"),
			Type.Literal("uncheck"),
			Type.Literal("press"),
			Type.Literal("select"),
			Type.Literal("wait"),
		]),
		selector: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
		role: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
		name: Type.Optional(Type.String({ maxLength: 2000 })),
		text: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
		value: Type.Optional(Type.String({ maxLength: 32000 })),
		key: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
		values: Type.Optional(Type.Array(Type.String({ maxLength: 2000 }), { minItems: 1, maxItems: 100 })),
		state: Type.Optional(
			Type.Union([Type.Literal("attached"), Type.Literal("detached"), Type.Literal("visible"), Type.Literal("hidden")])
		),
	},
	{ additionalProperties: false }
);

export type BrowserWorkflowStep = Static<typeof browserWorkflowStep>;

export interface BrowserWorkflowProgress {
	completedSteps: number;
	steps: Array<{ index: number; action: string; durationMs: number }>;
	failedStep?: number;
	error?: string;
}

export function validateBrowserWorkflow(steps: BrowserWorkflowStep[]): void {
	if (steps.length < 1 || steps.length > 12)
		throw new SandboxError("process_failed", "A browser batch requires 1-12 steps");
	for (const [index, step] of steps.entries()) {
		const invalid = (reason: string): never => {
			throw new SandboxError("process_failed", `Batch step ${index + 1}: ${reason}`);
		};
		if (
			!(["click", "hover", "fill", "type", "check", "uncheck", "press", "select", "wait"] as string[]).includes(
				step.action
			)
		)
			invalid("unsupported action");
		if ("ref" in step || [step.selector, step.role, step.text].filter(Boolean).length !== 1)
			invalid("use exactly one stable selector, role, or text target; refs are not supported");
		if (step.name !== undefined && !step.role) invalid("name requires role");
		if ((step.action === "fill" || step.action === "type") && typeof step.value !== "string")
			invalid("value is required");
		if (step.action === "press" && !step.key) invalid("key is required");
		if (step.action === "select" && !step.values?.length) invalid("values are required");
	}
}

/** Execute known dependent steps without asking the model to re-plan between them. */
export async function runBrowserWorkflow(
	page: Page,
	steps: BrowserWorkflowStep[],
	options: { timeoutMs?: number; stepTimeoutMs?: number; signal?: AbortSignal; isActive: () => boolean }
): Promise<BrowserWorkflowProgress> {
	validateBrowserWorkflow(steps);
	const deadline = Date.now() + Math.min(60_000, Math.max(1, options.timeoutMs ?? 30_000));
	const progress: BrowserWorkflowProgress = { completedSteps: 0, steps: [] };
	let closing: Promise<void> | undefined;
	// Closing cancels Playwright's in-flight auto-wait so an aborted click cannot fire later.
	const abort = () => {
		closing = page.close().catch(() => undefined);
	};
	options.signal?.throwIfAborted();
	options.signal?.addEventListener("abort", abort, { once: true });
	try {
		for (const [index, step] of steps.entries()) {
			options.signal?.throwIfAborted();
			const startedAt = Date.now();
			try {
				if (!options.isActive())
					throw new Error("Active tab or origin changed; inspect and authorize the new page before continuing");
				const remaining = deadline - Date.now();
				if (remaining <= 0) throw new Error("Browser batch time budget exhausted");
				const timeout = Math.max(1, Math.min(remaining, options.stepTimeoutMs ?? 5000));
				const target = step.selector
					? page.locator(step.selector)
					: step.role
						? page.getByRole(step.role as Parameters<Page["getByRole"]>[0], {
								...(step.name === undefined ? {} : { name: step.name }),
								exact: true,
							})
						: page.getByText(step.text!, { exact: true });
				switch (step.action) {
					case "click":
						await target.click({ timeout });
						break;
					case "hover":
						await target.hover({ timeout });
						break;
					case "fill":
						await target.fill(step.value!, { timeout });
						break;
					case "type":
						await target.pressSequentially(step.value!, { timeout });
						break;
					case "check":
						await target.check({ timeout });
						break;
					case "uncheck":
						await target.uncheck({ timeout });
						break;
					case "press":
						await target.press(step.key!, { timeout });
						break;
					case "select":
						await target.selectOption(step.values!, { timeout });
						break;
					case "wait":
						await target.waitFor({ state: step.state ?? "visible", timeout });
						break;
				}
				options.signal?.throwIfAborted();
				progress.completedSteps++;
				progress.steps.push({ index: index + 1, action: step.action, durationMs: Date.now() - startedAt });
			} catch (error) {
				options.signal?.throwIfAborted();
				progress.failedStep = index + 1;
				progress.error = error instanceof Error ? error.message : String(error);
				break;
			}
		}
		return progress;
	} finally {
		options.signal?.removeEventListener("abort", abort);
		await closing;
	}
}
