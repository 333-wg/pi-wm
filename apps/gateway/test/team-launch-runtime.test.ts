import { describe, expect, it, vi } from "vitest";
import type { AgentRuntime, TurnOperationPayload } from "@wuming/orchestrator";
import type { SessionSnapshot } from "@wuming/protocol";
import { isTeamLaunch, teamCommandGoal, teamLaunchInput, withTeamLaunch } from "../src/team-launch-runtime.js";

const payload = (text: string, skills?: string[]): TurnOperationPayload => ({
	type: "turn",
	mode: "prompt",
	userItemId: "current",
	content: [{ type: "text", text }],
	...(skills ? { skills } : {}),
});

describe("explicit team launch routing", () => {
	it("recognizes only a selected team skill or an anchored team command", () => {
		for (const text of [
			"Explain agent teams",
			"The document says /team build",
			"> /team build",
			"```\n/team build\n```",
			"/teams",
			"/team:review",
			"Use agent team to build this project",
			"Do not use agent team for this task",
			"用 team 帮我开发图书管理系统",
			"不要调用 agent team，只解释这个功能",
		])
			expect(isTeamLaunch(payload(text))).toBe(false);
		expect(isTeamLaunch(payload("Build a library manager", ["team"]))).toBe(true);
		expect(isTeamLaunch(payload("/team Build a library manager"))).toBe(true);
		expect(isTeamLaunch({ ...payload("Build", ["team"]), goalId: "goal" })).toBe(false);
		expect(isTeamLaunch({ ...payload("Build", ["team"]), mode: "steer" })).toBe(false);
		expect(teamCommandGoal(payload(" /team\nBuild a library manager ").content)).toBe("Build a library manager");
	});
	it.each(["Use agent team to build this project", "Explain team", "Do not use team", "用 agent team 开发"])(
		"leaves natural-language intent to the model runtime: %s",
		async (text) => {
			const executeTurn = vi.fn(async () => ({ items: [] }));
			const getTeams = vi.fn(() => undefined);
			const wrapped = withTeamLaunch({ executeTurn }, getTeams, async () => {});
			await wrapped.executeTurn({ operation: { payload: payload(text) } } as Parameters<
				AgentRuntime["executeTurn"]
			>[0]);
			expect(executeTurn).toHaveBeenCalledOnce();
			expect(getTeams).not.toHaveBeenCalled();
		}
	);
	it("rejects oversized context instead of silently dropping requirements", () => {
		const snapshot = { transcript: [] } as unknown as SessionSnapshot;
		expect(() => teamLaunchInput(snapshot, payload("x".repeat(20_001), ["team"]))).toThrow("20000");
		expect(() => teamLaunchInput(snapshot, payload("  ", ["team"]))).toThrow("目标");
	});
	it("preserves normal runtime method receivers and optional capabilities", async () => {
		const executeTurn = vi.fn(async function (this: AgentRuntime) {
			expect(this).toBe(base);
			return { items: [] };
		});
		const forceTerminate = vi.fn(async function (this: AgentRuntime) {
			expect(this).toBe(base);
		});
		const dispose = vi.fn(async function (this: AgentRuntime) {
			expect(this).toBe(base);
		});
		const base: AgentRuntime & AsyncDisposable = { executeTurn, forceTerminate, [Symbol.asyncDispose]: dispose };
		const wrapped = withTeamLaunch(
			base,
			() => undefined,
			async () => {}
		);
		await wrapped.executeTurn({ operation: { payload: payload("ordinary work") } } as Parameters<
			AgentRuntime["executeTurn"]
		>[0]);
		await wrapped.forceTerminate!("source");
		await wrapped[Symbol.asyncDispose]!();
		expect(executeTurn).toHaveBeenCalledOnce();
		expect(forceTerminate).toHaveBeenCalledOnce();
		expect(dispose).toHaveBeenCalledOnce();
		expect(wrapped.injectTurn).toBeUndefined();
	});
});
