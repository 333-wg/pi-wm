import { estimateTokens, type AgentSession, type AgentSessionEvent } from "@earendil-works/pi-coding-agent";

/**
 * Pi 0.84.3 exposes the safe between-turn hook, but not its non-aborting
 * compaction entry point. Keep this version-bound bridge isolated and covered
 * by real SDK/provider-wire tests. Never call manual compact() inside the loop:
 * it aborts and waits for the very run that is awaiting this hook.
 */
interface CompactionBridge {
	_runAutoCompaction(reason: "threshold", willRetry: boolean): Promise<boolean>;
	_checkCompaction(...args: unknown[]): Promise<boolean>;
}

export function installLoopCompaction(session: AgentSession): void {
	const bridge = session as unknown as CompactionBridge;
	if (typeof bridge._runAutoCompaction !== "function" || typeof bridge._checkCompaction !== "function")
		throw new Error("Unsupported Pi compaction lifecycle; update the loop-compaction adapter before upgrading Pi");
	const previous = session.agent.prepareNextTurnWithContext;
	const check = bridge._checkCompaction.bind(session);
	let failedInRun = false;
	// A failed boundary compaction must not immediately cause another paid summary
	// in Pi's post-run error recovery. The next user request may explicitly retry.
	bridge._checkCompaction = (...args) => (failedInRun ? Promise.resolve(false) : check(...args));
	session.subscribe((event) => {
		if (event.type === "agent_start") failedInRun = false;
	});
	session.agent.prepareNextTurnWithContext = async (turn, signal) => {
		const update = await previous?.(turn, signal);
		if (
			!session.autoCompactionEnabled ||
			signal?.aborted ||
			turn.message.stopReason === "error" ||
			turn.message.stopReason === "aborted" ||
			(turn.toolResults.length === 0 && !session.agent.hasQueuedMessages())
		)
			return update;
		const model = session.model;
		if (!model || model.contextWindow <= 0) return update;
		const settings = session.settingsManager.getCompactionSettings();
		// getContextUsage includes results added after the last usage-bearing reply.
		// Output reservation is bounded, like Wuming's prompt preflight, rather than
		// reserving a model's entire (potentially enormous) output capability.
		const reserve =
			Math.max(settings.reserveTokens, Math.min(model.maxTokens, 8192)) + Math.ceil(model.contextWindow * 0.05);
		const limit = Math.max(1, model.contextWindow - reserve);
		const estimate = () => {
			const usage = session.getContextUsage();
			const hasReportedUsage = session.agent.state.messages.some(
				(message) =>
					message.role === "assistant" &&
					message.stopReason !== "error" &&
					message.stopReason !== "aborted" &&
					message.usage.input + message.usage.output + message.usage.cacheRead + message.usage.cacheWrite > 0
			);
			if (hasReportedUsage && usage?.tokens !== null && usage?.tokens !== undefined) return usage.tokens;
			// Kept assistant usage is stale after compaction. Estimate the rebuilt
			// messages and the request's fixed overhead instead of reusing that usage.
			return (
				session.agent.state.messages.reduce((sum, message) => sum + estimateTokens(message), 0) +
				Math.ceil(
					(session.agent.state.systemPrompt.length +
						JSON.stringify(
							session.agent.state.tools.map((tool) => ({
								name: tool.name,
								description: tool.description,
								parameters: tool.parameters,
							}))
						).length) /
						3
				)
			);
		};
		if (estimate() <= limit) return update;

		let completed = false;
		let failure: string | undefined;
		const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
			if (event.type === "compaction_start" && signal?.aborted) {
				// Pi creates its summary controller just after emitting this event.
				queueMicrotask(() => session.abortCompaction());
			}
			if (event.type !== "compaction_end") return;
			completed = !event.aborted && Boolean(event.result?.summary.trim());
			failure = event.errorMessage;
		});
		const abort = () => session.abortCompaction();
		signal?.addEventListener("abort", abort, { once: true });
		// Pi's cut-point search looks forward from the retention boundary. If
		// that boundary lands in the trailing tool results, there is no later
		// legal cut and Pi retains the whole history. Retain the entire trailing
		// batch so the boundary reaches its assistant, never an orphan result.
		const getSettings = session.settingsManager.getCompactionSettings.bind(session.settingsManager);
		const trailingResults = turn.toolResults.reduce((sum, message) => sum + estimateTokens(message), 0);
		session.settingsManager.getCompactionSettings = () => ({
			...getSettings(),
			keepRecentTokens: Math.max(getSettings().keepRecentTokens, trailingResults + 1),
		});
		try {
			await bridge._runAutoCompaction("threshold", false);
			signal?.throwIfAborted();
			if (!completed)
				throw new Error(
					failure ?? "Automatic context compaction did not complete; task paused before the next model request"
				);
			if (estimate() > limit)
				throw new Error(
					"Context remains over budget after compaction; task paused rather than repeatedly compacting or sending an oversized request"
				);
			return {
				...update,
				context: {
					...(update?.context ?? turn.context),
					messages: session.agent.state.messages.slice(),
				},
			};
		} catch (error) {
			failedInRun = true;
			throw error;
		} finally {
			session.settingsManager.getCompactionSettings = getSettings;
			unsubscribe();
			signal?.removeEventListener("abort", abort);
		}
	};
}
