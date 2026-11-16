import { describe, expect, it } from "vitest";
import type { AgentTeam, AgentTeamTask, AgentTeamMessage } from "@wuming/protocol";
import { layoutStudioTasks, readableTeamMessage, teamObjective, modelKey } from "../src/lib/team-studio";
const task = (id: string, dependsOn: string[] = []): AgentTeamTask => ({
	id,
	title: id,
	description: id,
	status: "pending",
	dependsOn,
	writePaths: [],
	createdAt: 1,
	updatedAt: 1,
});
describe("team studio layout and readable events", () => {
	it("packs ten tasks by dependency column instead of giving each a global row", () => {
		const first = Array.from({ length: 5 }, (_, i) => task(`a${i}`));
		const second = Array.from({ length: 4 }, (_, i) => task(`b${i}`, [`a${i}`]));
		const layout = layoutStudioTasks([
			...first,
			...second,
			task(
				"final",
				second.map((value) => value.id)
			),
		]);
		expect(layout.columns.map((value) => value.length)).toEqual([5, 4, 1]);
		expect(layout.height).toBeLessThan(750);
		for (const position of layout.positions) {
			expect(position.y + position.height).toBeLessThanOrEqual(layout.height);
			for (const other of layout.positions.filter((value) => value.column === position.column && value !== position))
				expect(position.y + position.height <= other.y || other.y + other.height <= position.y).toBe(true);
		}
	});
	it("reserves room for inline model assignment without overlapping adjacent work", () => {
		const layout = layoutStudioTasks(
			[task("plan"), task("scene", ["plan"]), task("ui", ["plan"]), task("verify", ["scene", "ui"])],
			new Set(["scene", "ui"])
		);
		const scene = layout.positions.find((value) => value.task.id === "scene")!;
		const ui = layout.positions.find((value) => value.task.id === "ui")!;
		expect(scene.height).toBeGreaterThan(150);
		expect(ui.y).toBeGreaterThan(scene.y + scene.height);
		expect(ui.y + ui.height).toBeLessThan(layout.height);
	});
	it("keeps authored dependency direction and tolerates legacy missing links", () => {
		const layout = layoutStudioTasks([
			task("end", ["middle"]),
			task("middle", ["start"]),
			task("start"),
			task("old", ["missing"]),
		]);
		expect(layout.positions.find((value) => value.task.id === "end")?.column).toBe(2);
		expect(layout.positions.find((value) => value.task.id === "old")?.column).toBe(0);
	});
	it("uses explicit summaries and never infers completion from free-form technical text", () => {
		const message: AgentTeamMessage = {
			id: "message",
			from: "a",
			to: "lead",
			kind: "message",
			text: "API ready; integration still failing. Task completed? No.",
			createdAt: 1,
			delivery: "delivered",
		};
		const team = { tasks: [], objective: "Build" } as unknown as AgentTeam;
		expect(readableTeamMessage(message, team)).toBe(message.text);
		expect(readableTeamMessage({ ...message, summary: "接口已准备好，集成仍有问题。" }, team)).toBe(
			"接口已准备好，集成仍有问题。"
		);
	});
	it("summarizes an assignment as an assignment even after the task completes", () => {
		const value = { ...task("one"), title: "定义接口", status: "completed" as const };
		const team = { tasks: [value] } as unknown as AgentTeam;
		const message: AgentTeamMessage = {
			id: "message",
			from: "scheduler",
			to: "worker",
			kind: "assignment",
			text: "Task one: 定义接口\nLong instructions",
			createdAt: 1,
			delivery: "delivered",
		};
		expect(readableTeamMessage(message, team)).toBe("分配任务：定义接口");
	});
	it("displays the current objective separately from quoted launch history", () => {
		expect(
			teamObjective(
				'Current explicit team objective:\nBuild a site\n\nPrior conversation reference (quoted):\n[{"text":"history"}]'
			)
		).toBe("Build a site");
		expect(modelKey({ provider: "one", id: "model" })).not.toBe(modelKey({ provider: "two", id: "model" }));
	});
});
