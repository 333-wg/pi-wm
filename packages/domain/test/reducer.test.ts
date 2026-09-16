import type { ApprovalRequest, SessionSummary } from "@wuming/protocol";
import { describe, expect, it } from "vitest";
import {
	EMPTY_USAGE,
	reduceSessionEvent,
	replaySessionEvents,
	SessionInvariantError,
	type SessionEvent,
} from "../src/index.js";

const session: SessionSummary = {
	id: "session-1",
	workspaceId: "workspace-1",
	name: "First session",
	phase: "idle",
	createdAt: 10,
	updatedAt: 10,
};

const created: SessionEvent = {
	type: "session.created",
	eventId: "event-1",
	sessionId: session.id,
	revision: 1,
	timestamp: 10,
	session,
	model: { provider: "anthropic", id: "claude" },
	thinkingLevel: "medium",
	sandboxMode: "workspace_write",
	approvalPolicy: "on_risk",
	usage: EMPTY_USAGE,
};

const approval: ApprovalRequest = {
	id: "approval-1",
	sessionId: session.id,
	workspaceId: session.workspaceId,
	toolCallId: "tool-1",
	risk: "high",
	summary: "Install a package",
	capabilities: [{ type: "network.connect", hosts: ["registry.npmjs.org"] }],
	status: "pending",
	createdAt: 20,
	expiresAt: 120,
};

describe("session reducer", () => {
	it("seeds live request accounting from legacy turns without importing transcript or billing usage", () => {
		const oldRequest = {
			requestId: "old",
			model: created.model,
			usage: { ...EMPTY_USAGE, inputTokens: 10, totalTokens: 10 },
		};
		const legacy = {
			...reduceSessionEvent(undefined, created),
			usageByTurn: [
				{
					turnId: "old-turn",
					mode: "prompt" as const,
					model: created.model,
					attempts: 1,
					usage: oldRequest.usage,
					tools: [],
					requests: [oldRequest],
				},
			],
		};
		const request = { ...oldRequest, requestId: "live" };
		const next = reduceSessionEvent(legacy, {
			type: "session.request.usage.updated",
			eventId: "live-event",
			sessionId: session.id,
			revision: 2,
			timestamp: 20,
			request,
		});
		expect(next.usageRequests).toEqual([oldRequest, request]);
		expect(next.usageByTurn).toEqual(legacy.usageByTurn);
		expect(next.usage).toEqual(EMPTY_USAGE);
		const corrected = { ...request, usage: { ...request.usage, cacheReadTokens: 5, inputTokens: 5 } };
		const updated = reduceSessionEvent(next, {
			type: "session.request.usage.updated",
			eventId: "correction",
			sessionId: session.id,
			revision: 3,
			timestamp: 30,
			request: corrected,
		});
		expect(updated.usageRequests).toEqual([oldRequest, corrected]);
	});
	it("replays item updates without duplicating item identity", () => {
		const events: SessionEvent[] = [
			created,
			{
				type: "session.item.upserted",
				eventId: "event-2",
				sessionId: session.id,
				revision: 2,
				timestamp: 20,
				item: {
					id: "assistant-1",
					type: "assistant",
					createdAt: 20,
					status: "streaming",
					content: [{ type: "text", text: "Hel" }],
					model: created.model,
				},
			},
			{
				type: "session.item.upserted",
				eventId: "event-3",
				sessionId: session.id,
				revision: 3,
				timestamp: 30,
				item: {
					id: "assistant-1",
					type: "assistant",
					createdAt: 20,
					status: "complete",
					content: [{ type: "text", text: "Hello" }],
					model: created.model,
				},
			},
		];
		const snapshot = replaySessionEvents(events);
		expect(snapshot.revision).toBe(3);
		expect(snapshot.transcript).toHaveLength(1);
		expect(snapshot.transcript[0]).toMatchObject({ id: "assistant-1", status: "complete" });
	});

	it("rejects a revision gap", () => {
		const snapshot = reduceSessionEvent(undefined, created);
		expect(() =>
			reduceSessionEvent(snapshot, {
				type: "session.phase.changed",
				eventId: "event-3",
				sessionId: session.id,
				revision: 3,
				timestamp: 30,
				phase: "turn",
			})
		).toThrowError(SessionInvariantError);
	});

	it("settles an approval exactly once", () => {
		const initial = reduceSessionEvent(undefined, created);
		const pending = reduceSessionEvent(initial, {
			type: "approval.requested",
			eventId: "event-2",
			sessionId: session.id,
			revision: 2,
			timestamp: 20,
			approval,
		});
		const settled = reduceSessionEvent(pending, {
			type: "approval.settled",
			eventId: "event-3",
			sessionId: session.id,
			revision: 3,
			timestamp: 30,
			approval: { ...approval, status: "approved", decidedAt: 30, decidedBy: "user-1" },
		});
		expect(settled.pendingApprovals).toEqual([]);
		expect(() =>
			reduceSessionEvent(settled, {
				type: "approval.settled",
				eventId: "event-4",
				sessionId: session.id,
				revision: 4,
				timestamp: 40,
				approval: { ...approval, status: "denied", decidedAt: 40, decidedBy: "user-1" },
			})
		).toThrowError(SessionInvariantError);
	});

	it("replays session rename, archive, and restore metadata", () => {
		const initial = reduceSessionEvent(undefined, created);
		const renamed = reduceSessionEvent(initial, {
			type: "session.renamed",
			eventId: "event-2",
			sessionId: session.id,
			revision: 2,
			timestamp: 20,
			name: "Release review",
		});
		const archived = reduceSessionEvent(renamed, {
			type: "session.archived",
			eventId: "event-3",
			sessionId: session.id,
			revision: 3,
			timestamp: 30,
			archivedAt: 30,
		});
		expect(archived.session).toMatchObject({ name: "Release review", archivedAt: 30 });
		const restored = reduceSessionEvent(archived, {
			type: "session.archived",
			eventId: "event-4",
			sessionId: session.id,
			revision: 4,
			timestamp: 40,
		});
		expect(restored.session.name).toBe("Release review");
		expect(restored.session.archivedAt).toBeUndefined();
	});

	it("updates budget fields independently and removes explicit null budgets", () => {
		const initial = reduceSessionEvent(undefined, {
			...created,
			costBudgetUsd: 2,
			tokenBudget: 10_000,
			budgetWarningThreshold: 0.8,
		});
		const thresholdChanged = reduceSessionEvent(initial, {
			type: "session.budget.changed",
			eventId: "event-2",
			sessionId: session.id,
			revision: 2,
			timestamp: 20,
			budgetWarningThreshold: 0.9,
		});
		expect(thresholdChanged).toMatchObject({
			costBudgetUsd: 2,
			tokenBudget: 10_000,
			budgetWarningThreshold: 0.9,
		});
		const removed = reduceSessionEvent(thresholdChanged, {
			type: "session.budget.changed",
			eventId: "event-3",
			sessionId: session.id,
			revision: 3,
			timestamp: 30,
			costBudgetUsd: null,
		});
		expect(removed.costBudgetUsd).toBeUndefined();
		expect(removed.tokenBudget).toBe(10_000);
	});
});
