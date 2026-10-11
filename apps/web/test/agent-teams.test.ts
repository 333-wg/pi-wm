import { createElement } from "react";
import { describe, expect, it } from "vitest";
import type { GoalSummary, SessionSnapshot, SubagentSummary } from "@wuming/protocol";
import { buildTeamFrame, layoutTeamTasks, teamTaskState, type TeamTask } from "../src/lib/agent-teams";
import { AgentTeamsWorkbench } from "../src/components/AgentTeamsWorkbench";
import { AgentTeamsCanvas } from "../src/components/AgentTeamsCanvas";
import { teamText } from "../src/components/agent-teams-messages";
import { renderLocalized } from "./render-localized";

const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, costUsd: 0 };
const snapshot: SessionSnapshot = {
	session: { id: "parent", workspaceId: "workspace", phase: "idle", createdAt: 1, updatedAt: 1 },
	revision: 1,
	model: { provider: "test", id: "model" },
	thinkingLevel: "off",
	sandboxMode: "read_only",
	approvalPolicy: "never",
	transcript: [],
	pendingApprovals: [],
	queuedSteerCount: 0,
	queuedFollowUpCount: 0,
	usage,
};
function child(id = "child"): SubagentSummary {
	return {
		id,
		parentSessionId: "parent",
		sessionId: id,
		operationId: `${id}-operation`,
		name: "Engineer",
		task: "Inspect files",
		depth: 1,
		status: "completed",
		createdAt: 10,
		updatedAt: 30,
		startedAt: 20,
		finishedAt: 30,
		model: snapshot.model,
		thinkingLevel: "off",
		sandboxMode: "read_only",
		approvalPolicy: "never",
		usage,
		pendingApprovals: [],
		result: "Inspection complete",
	};
}
function goal(id = "plan"): GoalSummary {
	return {
		id,
		parentSessionId: "parent",
		title: "Release",
		objective: "Ship",
		status: "running",
		createdAt: 1,
		updatedAt: 30,
		usage,
		pendingApprovals: [],
		plan: {
			phase: "running",
			maxParallel: 2,
			failurePolicy: "fail_fast",
			steps: [
				{
					id: "a",
					title: "Inspect",
					objective: "Inspect files",
					dependsOn: [],
					status: "completed",
					runSessionId: "child",
					startedAt: 20,
					finishedAt: 30,
					result: "Inspection complete",
					usage,
					pendingApprovals: [],
				},
				{
					id: "b",
					title: "Ship",
					objective: "Publish changes",
					dependsOn: ["a"],
					status: "blocked",
					usage,
					pendingApprovals: [],
				},
			],
		},
	};
}

describe("team execution projection", () => {
	it("deduplicates plan-owned sessions and never fabricates members or messages for blocked tasks", () => {
		const frame = buildTeamFrame(snapshot, [child()], [goal()]);
		expect(frame.tasks).toHaveLength(2);
		expect(frame.members).toHaveLength(2);
		expect(frame.tasks[1]).toMatchObject({ id: "goal:plan:b", dependsOn: ["goal:plan:a"] });
		expect(frame.tasks[1]?.memberId).toBeUndefined();
		expect(frame.messages.map((message) => message.kind)).toEqual(["result", "dispatch"]);
		expect(frame.messages.every((message) => message.taskId === "goal:plan:a")).toBe(true);
	});
	it("keeps independent children and scopes every record to the attached parent", () => {
		const other = { ...child("other"), parentSessionId: "different" };
		const frame = buildTeamFrame(snapshot, [child(), other], [{ ...goal(), parentSessionId: "different" }]);
		expect(frame.tasks).toHaveLength(1);
		expect(frame.tasks[0]?.subagentId).toBe("child");
		expect(frame.members.map((member) => member.id)).toEqual(["parent", "child"]);
	});
	it("namespaces repeated step ids from separate plans", () => {
		const frame = buildTeamFrame(snapshot, [], [goal("first"), goal("second")]);
		expect(new Set(frame.tasks.map((task) => task.id)).size).toBe(4);
		expect(frame.tasks.find((task) => task.id === "goal:second:b")?.dependsOn).toEqual(["goal:second:a"]);
	});
	it("does not classify failure, cancellation, or skipped steps as successful completion", () => {
		for (const status of ["failed", "cancelled", "skipped", "awaiting_approval"] as const)
			expect(teamTaskState(status)).toBe("attention");
		expect(teamTaskState("blocked")).toBe("waiting");
		expect(teamTaskState("cancelling")).toBe("running");
		expect(teamTaskState("completed")).toBe("completed");
	});
	it("uses recorded clocks, not refresh time, and preserves empty results", () => {
		const frame = buildTeamFrame(snapshot, [{ ...child(), result: "" }], []);
		expect(frame.messages[0]).toMatchObject({ timestamp: 30, text: "", kind: "result" });
		expect(buildTeamFrame(snapshot, [{ ...child(), result: "" }], [])).toEqual(frame);
	});
	it("preserves all stages and coordinates when searching a downstream task", () => {
		const first = buildTeamFrame(snapshot, [child()], []).tasks[0]!;
		const tasks = [
			{ ...first, id: "a", dependsOn: [] },
			{ ...first, id: "b", dependsOn: ["a"] },
			{ ...first, id: "c", dependsOn: ["b"] },
		];
		const full = layoutTeamTasks(tasks);
		const filtered = layoutTeamTasks(tasks, new Set(["c"]));
		expect(filtered.columns).toBe(3);
		expect(filtered.positions).toEqual([full.positions[2]]);
		expect(filtered.links).toEqual([]);
		expect(layoutTeamTasks(tasks, new Set()).positions).toEqual([]);
	});
	it("shows later recorded member handoffs without inventing dependencies or serialising parallel tasks", () => {
		const first = buildTeamFrame(snapshot, [child()], []).tasks[0]!;
		const pending = { ...first };
		delete pending.finishedAt;
		const tasks: TeamTask[] = [
			{ ...first, id: "a", createdAt: 10, finishedAt: 30 },
			{ ...first, id: "parallel", createdAt: 20, finishedAt: 35 },
			{ ...first, id: "b", createdAt: 40, finishedAt: 50 },
			{ ...pending, id: "c", createdAt: 60, status: "running" },
			{ ...first, id: "other-member", memberId: "other", createdAt: 60 },
			{ ...first, id: "other-group", group: "another", createdAt: 60 },
		];
		const layout = layoutTeamTasks(tasks);
		expect(layout.positions.map((entry) => entry.column)).toEqual([0, 0, 1, 2, 0, 0]);
		expect(layout.links).toEqual([
			{ source: "parallel", target: "b", kind: "continuation" },
			{ source: "b", target: "c", kind: "continuation" },
		]);
		expect(tasks.every((task) => task.dependsOn.length === 0)).toBe(true);
		expect(layoutTeamTasks([...tasks].reverse()).links).toEqual([...layout.links].reverse());
	});
	it("requires terminal evidence for handoffs and prioritises explicit dependencies", () => {
		const first = buildTeamFrame(snapshot, [child()], []).tasks[0]!;
		const pending = { ...first };
		delete pending.finishedAt;
		const unfinished = { ...first, id: "a", status: "running" as const, createdAt: 10, finishedAt: 20 };
		expect(layoutTeamTasks([unfinished, { ...first, id: "b", createdAt: 40 }]).columns).toBe(1);
		expect(
			layoutTeamTasks([
				{ ...pending, id: "a" },
				{ ...first, id: "b", createdAt: 40 },
			]).columns
		).toBe(1);
		const layout = layoutTeamTasks([
			{ ...first, id: "a" },
			{ ...first, id: "b", createdAt: 40, dependsOn: ["a"] },
		]);
		expect(layout.links).toEqual([{ source: "a", target: "b", kind: "dependency" }]);
	});
	it("renders stage navigation, distinct handoffs and active flow without altering task state", () => {
		const first = buildTeamFrame(snapshot, [child()], []).tasks[0]!;
		const pending = { ...first };
		delete pending.finishedAt;
		const tasks: TeamTask[] = [
			{ ...first, id: "a", createdAt: 10, finishedAt: 30 },
			{ ...pending, id: "b", createdAt: 40, status: "running" },
		];
		const html = renderLocalized(
			createElement(AgentTeamsCanvas, {
				tasks,
				members: [],
				selected: "b",
				onSelect: () => {},
				zoom: 1,
				t: teamText("zh"),
			})
		);
		expect(html).toContain('aria-label="阶段导航"');
		expect(html).toContain('data-stage="2"');
		expect(html).toContain('data-link-kind="continuation"');
		expect(html).not.toContain("data-dependency");
		expect(html).toContain('class="teams-link-pulse"');
		expect(html).toContain("highlighted");
	});
	it("lays out fan-in deterministically and tolerates missing references and corrupt cycles", () => {
		const first = buildTeamFrame(snapshot, [child()], []).tasks[0]!;
		const tasks: TeamTask[] = [
			{ ...first, id: "root", dependsOn: [] },
			{ ...first, id: "branch", dependsOn: [] },
			{ ...first, id: "join", dependsOn: ["root", "branch"] },
			{ ...first, id: "end", dependsOn: ["join", "missing"] },
		];
		const layout = layoutTeamTasks(tasks);
		expect(layout.positions.map((position) => position.column)).toEqual([0, 0, 1, 2]);
		expect(new Set(layout.positions.map((position) => position.y)).size).toBe(4);
		expect(() =>
			layoutTeamTasks([
				{ ...first, id: "x", dependsOn: ["y"] },
				{ ...first, id: "y", dependsOn: ["x"] },
			])
		).not.toThrow();
	});
});

describe("team workbench rendering", () => {
	const props = {
		snapshot,
		subagents: [child()],
		goals: [goal()],
		connected: true,
		canCreate: true,
		canPlan: true,
		onCreateMember: async () => child(),
		onCreatePlan: async () => goal(),
		onStartPlan: async () => {},
		onStopPlan: async () => {},
		onStopMember: async () => {},
		onOpen: async () => {},
		onRefresh: async () => {},
		onApprove: async () => {},
	};
	it("renders real members, dependency links and accessible controls", () => {
		const html = renderLocalized(createElement(AgentTeamsWorkbench, props));
		expect(html).toContain('aria-label="对话子任务"');
		expect(html).toContain('data-dependency="goal:plan:a:goal:plan:b"');
		expect(html).toContain("等待依赖");
		expect(html).toContain("Engineer");
		expect(html).toContain("本次观察记录");
	});
	it("renders English controls and disables creation for archived sessions", () => {
		const html = renderLocalized(
			createElement(AgentTeamsWorkbench, {
				...props,
				snapshot: { ...snapshot, session: { ...snapshot.session, archivedAt: 50 } },
			}),
			"en"
		);
		expect(html).toContain("Collaboration workbench");
		expect(html).toContain("Archived / read only");
		expect(html).toMatch(/<button[^>]*disabled=""[^>]*><svg[^]*?New member<\/button>/);
	});
});
