import { test, expect } from "@playwright/test";
import { startPhonePreview } from "../apps/gateway/test/phone-preview.mjs";

let fixture: Awaited<ReturnType<typeof startPhonePreview>>;
test.beforeAll(async () => {
	fixture = await startPhonePreview();
	await fixture.control("enable", { mode: "proxy", origin: fixture.origin, port: fixture.remotePort });
});
test.afterAll(async () => {
	await fixture.close();
});
test.use({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 } });

test("phone clears team selection, handles busy/background phases, and shows desktop-only approval and team status", async ({
	page,
}, testInfo) => {
	let snapshot = structuredClone(fixture.snapshot());
	const background = { ...snapshot.session, id: "background-session", name: "后台任务" };
	const prompts: any[] = [];
	const requests: string[] = [];
	const errors: string[] = [];
	let push: (message: unknown) => void = () => {};
	let failSnapshot = false;
	let failTeams = false;
	let teamStatus = "running";
	page.on("pageerror", (e) => errors.push(e.message));
	await page.route("**/api/phone/session", (route) =>
		route.fulfill({ json: { authenticated: true, workbench: true } })
	);
	await page.routeWebSocket("**/api/ws", (socket) => {
		push = (message) => socket.send(JSON.stringify(message));
		socket.onMessage((raw) => {
			const message = JSON.parse(String(raw));
			if (message.type === "hello") {
				push({ type: "hello" });
				return;
			}
			const command = message.command;
			requests.push(command.type);
			let result: any;
			let failure: string | undefined;
			switch (command.type) {
				case "workspace.list":
					result = { type: "workspace.list", workspaces: [{ id: "phone-project", name: "验收项目" }] };
					break;
				case "model.list":
					result = { type: "model.list", models: [{ model: snapshot.model, name: "演示模型", authenticated: true }] };
					break;
				case "session.list":
					result = { type: "session.list", sessions: [snapshot.session, background] };
					break;
				case "skill.list":
					result = {
						type: "skill.list",
						skills: [{ id: "team", name: "团队协作", description: "隔离模拟，不启动真实团队" }],
					};
					break;
				case "session.attach":
					result = { type: "session.attached", snapshot };
					break;
				case "session.snapshot.get":
					if (failSnapshot) {
						failure = "演示同步失败";
						failSnapshot = false;
					}
					result = { type: "session.snapshot", snapshot };
					break;
				case "turn.prompt":
					prompts.push(command);
					snapshot.transcript.push({
						id: "receipt",
						type: "tool",
						toolCallId: "start",
						toolName: "team_start",
						status: "complete",
						isError: false,
						input: {},
						content: [{ type: "text", text: "团队启动回执" }],
						createdAt: 1,
					});
					snapshot = { ...snapshot, revision: snapshot.revision + 1 };
					failSnapshot = true;
					result = { type: "turn.accepted" };
					break;
				case "team.list":
					if (failTeams) failure = "演示团队同步失败";
					result = { type: "team.list", teams: [{ id: "demo-team", sourceSessionId: snapshot.session.id }] };
					break;
				case "team.get":
					result = {
						type: "team.snapshot",
						team: {
							id: "demo-team",
							name: "隔离验收团队",
							status: teamStatus,
							members: [],
							tasks: [
								{ id: "task", title: "检查手机流程", status: teamStatus === "completed" ? "completed" : "in_progress" },
							],
							...(teamStatus === "completed" ? { result: "演示任务已完成，无真实模型调用" } : {}),
						},
					};
					break;
				default:
					result = { type: "ok" };
			}
			push({
				type: "response",
				requestId: message.requestId,
				ok: !failure,
				...(failure ? { error: { message: failure } } : { result }),
			});
		});
	});
	await page.goto(fixture.phoneUrl);
	await expect(page.getByRole("status")).toHaveText("已连接");
	await page.getByRole("button", { name: "打开会话列表" }).click();
	await page.getByRole("button", { name: /电脑与手机接续测试/ }).click();
	await page.getByLabel("继续这段对话").fill("/team");
	await page.getByRole("option", { name: /团队协作/ }).click();
	await page.getByLabel("继续这段对话").fill("测试团队任务");
	await page.getByRole("button", { name: "发送", exact: true }).click();
	await expect(page.getByRole("button", { name: "移除技能 团队协作" })).toHaveCount(0);
	await expect(page.getByLabel("继续这段对话")).toHaveValue("");
	expect(prompts[0].skills).toEqual(["team"]);
	expect(await page.evaluate((id) => sessionStorage.getItem(`phone-skills:${id}`), snapshot.session.id)).toBe("[]");
	await expect(page.getByRole("alert")).toContainText("操作已提交，状态同步失败");
	push({
		type: "event",
		cursor: "1",
		event: { type: "session.phase.changed", sessionId: snapshot.session.id, phase: "idle" },
	});
	await expect(page.getByRole("region", { name: "团队状态" })).toBeVisible();
	await expect(page.getByText("隔离验收团队 · 执行中")).toBeVisible();
	await page.getByText("隔离验收团队 · 执行中").click();
	await page.screenshot({ path: testInfo.outputPath("team-mobile.png") });
	failTeams = true;
	await page.getByRole("button", { name: "刷新团队状态" }).click();
	await expect(page.getByRole("region", { name: "团队状态" }).getByRole("alert")).toContainText("同步失败");
	await expect(page.getByText("隔离验收团队 · 执行中")).toBeVisible();
	failTeams = false;
	teamStatus = "completed";
	await page.getByRole("button", { name: "刷新团队状态" }).click();
	await expect(page.getByText("隔离验收团队 · 已完成")).toBeVisible();
	await expect(page.getByText("演示任务已完成，无真实模型调用")).toBeVisible();
	await page.getByLabel("继续这段对话").fill("普通追问");
	await page.getByRole("button", { name: "发送", exact: true }).click();
	await expect.poll(() => prompts.length).toBe(2);
	expect(prompts[1].skills).toBeUndefined();
	snapshot = { ...snapshot, session: { ...snapshot.session, phase: "turn" }, revision: snapshot.revision + 1 };
	push({
		type: "event",
		cursor: "2",
		event: { type: "session.phase.changed", sessionId: snapshot.session.id, phase: "turn" },
	});
	await expect(page.getByText("电脑正在执行或等待处理，可先编辑草稿，空闲后再发送。")).toBeVisible();
	await page.getByLabel("继续这段对话").fill("执行时保留草稿");
	await expect(page.getByRole("button", { name: "发送", exact: true })).toBeDisabled();
	snapshot = {
		...snapshot,
		revision: snapshot.revision + 1,
		pendingApprovals: [
			{
				id: "approval",
				workspaceId: snapshot.session.workspaceId,
				expiresAt: Date.now() + 60000,
				sessionId: snapshot.session.id,
				toolCallId: "computer",
				risk: "high",
				summary: "桌面操作审批",
				capabilities: [{ type: "computer.use", action: "input" }],
				status: "pending",
				createdAt: 1,
			},
		],
	};
	push({ type: "event", cursor: "3", event: { type: "approval.requested", sessionId: snapshot.session.id } });
	await expect(page.getByText(/此操作需要在电脑端确认/)).toBeVisible();
	await expect(page.getByRole("button", { name: "批准此操作" })).toHaveCount(0);
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.screenshot({ path: testInfo.outputPath("team-approval-desktop.png") });
	await page.getByRole("button", { name: "打开会话列表" }).click();
	const count = requests.filter((type) => type === "session.snapshot.get").length;
	push({
		type: "event",
		cursor: "4",
		event: { type: "session.phase.changed", sessionId: background.id, phase: "turn" },
	});
	await expect(page.getByRole("button", { name: /后台任务.*执行中/ })).toBeVisible();
	push({
		type: "event",
		cursor: "5",
		event: { type: "session.phase.changed", sessionId: background.id, phase: "idle" },
	});
	await expect(page.getByRole("button", { name: "后台任务", exact: true })).toBeVisible();
	expect(requests.filter((type) => type === "session.snapshot.get").length).toBe(count);
	expect(errors).toEqual([]);
});
