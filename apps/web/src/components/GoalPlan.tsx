import { GitBranch, MessageSquareCode, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import type { GoalPlanSpec, GoalPlanSummary } from "@wuming/protocol";

export function newGoalPlan(): GoalPlanSpec {
	return {
		maxParallel: 2,
		failurePolicy: "fail_fast",
		steps: [{ id: "step-1", title: "", objective: "", dependsOn: [] }],
	};
}

export function GoalPlanEditor({
	value,
	onChange,
	disabled,
}: {
	value: GoalPlanSpec;
	onChange: (plan: GoalPlanSpec) => void;
	disabled: boolean;
}) {
	const update = (id: string, changes: Partial<GoalPlanSpec["steps"][number]>) =>
		onChange({
			...value,
			steps: value.steps.map((step) => (step.id === id ? { ...step, ...changes } : step)),
		});
	const remove = (id: string) =>
		onChange({
			...value,
			steps: value.steps
				.filter((step) => step.id !== id)
				.map((step) => ({
					...step,
					dependsOn: step.dependsOn.filter((dependency) => dependency !== id),
				})),
		});
	return (
		<fieldset className="goal-plan-editor" disabled={disabled}>
			<legend>步骤计划</legend>
			<label>
				<span>并发步骤</span>
				<select
					value={value.maxParallel ?? 2}
					onChange={(event) => onChange({ ...value, maxParallel: Number(event.target.value) })}
				>
					{[1, 2, 3, 4].map((count) => (
						<option key={count} value={count}>
							{count}
						</option>
					))}
				</select>
			</label>
			<label>
				<span>失败策略</span>
				<select
					value={value.failurePolicy ?? "fail_fast"}
					onChange={(event) =>
						onChange({
							...value,
							failurePolicy: event.target.value === "continue_independent" ? "continue_independent" : "fail_fast",
						})
					}
				>
					<option value="fail_fast">失败后停止</option>
					<option value="continue_independent">继续独立分支</option>
				</select>
			</label>
			{value.steps.map((step, index) => (
				<div className="goal-plan-edit-step" key={step.id}>
					<div className="goal-plan-heading">
						<strong>步骤 {index + 1}</strong>
						<button
							className="icon-button"
							type="button"
							title={"删除步骤 " + (index + 1)}
							disabled={value.steps.length === 1}
							onClick={() => remove(step.id)}
						>
							<Trash2 size={14} />
						</button>
					</div>
					<label>
						<span>步骤名称</span>
						<input
							required
							maxLength={500}
							value={step.title}
							onChange={(event) => update(step.id, { title: event.target.value })}
						/>
					</label>
					<label>
						<span>步骤任务</span>
						<textarea
							required
							rows={3}
							maxLength={20000}
							value={step.objective}
							onChange={(event) => update(step.id, { objective: event.target.value })}
						/>
					</label>
					{index > 0 && (
						<fieldset className="goal-plan-dependencies">
							<legend>前置步骤</legend>
							{value.steps.slice(0, index).map((dependency, dependencyIndex) => (
								<label key={dependency.id}>
									<input
										type="checkbox"
										checked={step.dependsOn.includes(dependency.id)}
										onChange={(event) =>
											update(step.id, {
												dependsOn: event.target.checked
													? [...step.dependsOn, dependency.id]
													: step.dependsOn.filter((id) => id !== dependency.id),
											})
										}
									/>
									<span>{dependency.title || "步骤 " + (dependencyIndex + 1)}</span>
								</label>
							))}
						</fieldset>
					)}
					<label>
						<span>步骤验收标准（可选）</span>
						<textarea
							rows={2}
							maxLength={4000}
							value={step.successCriteria ?? ""}
							onChange={(event) => {
								const { successCriteria: _criteria, maxRounds: _rounds, ...base } = step;
								onChange({
									...value,
									steps: value.steps.map((candidate) =>
										candidate.id === step.id
											? {
													...base,
													...(event.target.value
														? {
																successCriteria: event.target.value,
																maxRounds: step.maxRounds ?? 3,
															}
														: {}),
												}
											: candidate
									),
								});
							}}
						/>
					</label>
					{step.successCriteria && (
						<label>
							<span>验收最大轮次</span>
							<select
								value={step.maxRounds ?? 3}
								onChange={(event) => update(step.id, { maxRounds: Number(event.target.value) })}
							>
								{[1, 2, 3, 4, 5].map((count) => (
									<option key={count} value={count}>
										{count}
									</option>
								))}
							</select>
						</label>
					)}
				</div>
			))}
			<button
				className="subagent-secondary-action"
				type="button"
				disabled={value.steps.length >= 20}
				onClick={() =>
					onChange({
						...value,
						steps: [...value.steps, { id: crypto.randomUUID(), title: "", objective: "", dependsOn: [] }],
					})
				}
			>
				<Plus size={14} />
				添加步骤
			</button>
		</fieldset>
	);
}

const labels: Record<GoalPlanSummary["steps"][number]["status"], string> = {
	pending: "待启动",
	blocked: "等待依赖",
	skipped: "已跳过",
	queued: "排队中",
	running: "运行中",
	completed: "已完成",
	failed: "失败",
	cancelled: "已取消",
	cancelling: "取消中",
	paused: "已暂停",
	awaiting_approval: "等待审批",
};
const reviewLabels = {
	pending: "待验收",
	executing: "执行中",
	reviewing: "验收中",
	passed: "验收通过",
	failed: "验收失败",
	cancelled: "验收取消",
};

export function GoalPlanView({
	plan,
	onOpenSession,
}: {
	plan: GoalPlanSummary;
	onOpenSession: (sessionId: string) => Promise<void>;
}) {
	const [opening, setOpening] = useState<string>();
	const [error, setError] = useState<string>();
	const open = async (sessionId: string) => {
		if (opening) return;
		setOpening(sessionId);
		setError(undefined);
		try {
			await onOpenSession(sessionId);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setOpening(undefined);
		}
	};
	const names = new Map(plan.steps.map((step) => [step.id, step.title]));
	return (
		<section className="subagent-section goal-plan-view" aria-label="步骤执行状态">
			<h2>
				<GitBranch size={14} />
				步骤计划
			</h2>
			{error && (
				<p role="alert" className="workbench-error">
					{error}
				</p>
			)}
			<p>
				并发 {plan.maxParallel} · {plan.failurePolicy === "fail_fast" ? "失败后停止" : "继续独立分支"}
			</p>
			<ol>
				{plan.steps.map((step) => (
					<li key={step.id}>
						<div className="goal-plan-heading">
							<strong>{step.title}</strong>
							<span className={"subagent-status-label status-" + step.status}>{labels[step.status]}</span>
						</div>
						{step.dependsOn.length > 0 && (
							<p className="goal-plan-dependency-line">
								依赖：{step.dependsOn.map((id) => names.get(id) ?? id).join("、")}
							</p>
						)}
						<details>
							<summary>任务与结果</summary>
							<p>{step.objective}</p>
							{step.result !== undefined && <pre>{step.result || "无文本结果"}</pre>}
							{step.error && <p>{step.error}</p>}
							{step.skipReason && <p>{step.skipReason}</p>}
						</details>
						{step.successCriteria && (
							<details className="goal-plan-review">
								<summary>
									{step.reviewPhase ? reviewLabels[step.reviewPhase] : "待验收"} · {step.round ?? 0}/
									{step.maxRounds ?? 3} 轮
								</summary>
								<p>{step.successCriteria}</p>
								<ol aria-label={step.title + " 验收记录"}>
									{(step.reviewHistory ?? []).map((record) => (
										<li key={record.round}>
											<strong>
												第 {record.round} 轮 · {record.verdict === "pass" ? "通过" : "未通过"}
											</strong>
											<p>{record.feedback}</p>
											{record.checks?.map((check, index) => (
												<div key={index}>
													<strong>
														{check.status === "pass" ? "通过" : "未通过"}：{check.criterion}
													</strong>
													<p>{check.evidence}</p>
												</div>
											))}
											<p>
												工具记录：
												{record.toolsUsed?.length ? record.toolsUsed.join("、") : "未记录工具调用"}
											</p>
										</li>
									))}
								</ol>
							</details>
						)}
						{step.runSessionId && (
							<button
								className="automation-open-run"
								type="button"
								title={"打开步骤会话：" + step.title}
								disabled={opening !== undefined}
								onClick={() => void open(step.runSessionId!)}
							>
								<MessageSquareCode size={13} />
								{opening === step.runSessionId ? "正在打开" : "打开步骤会话"}
							</button>
						)}
					</li>
				))}
			</ol>
		</section>
	);
}
