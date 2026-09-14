import { Check, CircleAlert, Copy, Download, Plus, RefreshCw, ShieldCheck, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import type {
	ArtifactRef,
	EvaluationAttestation,
	EvaluationDataset,
	EvaluationGrader,
	JsonValue,
	RunEvaluation,
	RunSummary,
} from "@wuming/protocol";
import { useFocusTrap } from "../use-focus-trap.js";

type GraderType = EvaluationGrader["type"];
type ArtifactAssertionKind = Extract<EvaluationGrader, { type: "artifact" }>["assertion"]["kind"];

type DraftGrader =
	| {
			id: string;
			label: string;
			type: "trajectory";
			requireIntegrity: boolean;
			minStructuralScore: string;
	  }
	| {
			id: string;
			label: string;
			type: "artifact";
			artifactId: string;
			assertionKind: ArtifactAssertionKind;
			value: string;
			caseSensitive: boolean;
			pointer: string;
			expectedJson: string;
	  }
	| {
			id: string;
			label: string;
			type: "command";
			command: string;
			expectedExitCode: string;
			stdoutContains: string;
			stderrNotContains: string;
			timeoutMs: string;
	  };

interface EvaluationDialogProps {
	run: RunSummary;
	workspaceId: string;
	datasets: EvaluationDataset[];
	artifacts: ArtifactRef[];
	enabled: boolean;
	onRefreshDatasets: (workspaceId: string) => Promise<EvaluationDataset[]>;
	onCreateDataset: (name: string, graders: EvaluationGrader[]) => Promise<EvaluationDataset>;
	onDeleteDataset: (datasetId: string) => Promise<void>;
	onListEvaluations: (runId: string) => Promise<RunEvaluation[]>;
	onEvaluate: (
		runId: string,
		input: { datasetId?: string; name?: string; graders?: EvaluationGrader[] }
	) => Promise<RunEvaluation>;
	onAttest: (runId: string, evaluationId: string) => Promise<EvaluationAttestation>;
	onCopyDiagnostic: () => Promise<void>;
	onClose: () => void;
}

function draft(type: GraderType, index: number): DraftGrader {
	const id = `${type}-${crypto.randomUUID()}`;
	if (type === "trajectory")
		return {
			id,
			label: `轨迹检查 ${index}`,
			type,
			requireIntegrity: true,
			minStructuralScore: "70",
		};
	if (type === "artifact")
		return {
			id,
			label: `产物检查 ${index}`,
			type,
			artifactId: "",
			assertionKind: "exists",
			value: "",
			caseSensitive: false,
			pointer: "",
			expectedJson: "null",
		};
	return {
		id,
		label: `命令检查 ${index}`,
		type,
		command: "",
		expectedExitCode: "0",
		stdoutContains: "",
		stderrNotContains: "",
		timeoutMs: "120000",
	};
}

function integer(value: string, label: string, minimum: number, maximum: number): number | undefined {
	if (!value.trim()) return undefined;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum)
		throw new Error(`${label}必须是 ${minimum}-${maximum} 的整数`);
	return parsed;
}

function toGrader(value: DraftGrader): EvaluationGrader {
	const label = value.label.trim();
	if (!label) throw new Error("检查名称不能为空");
	if (value.type === "trajectory") {
		const minStructuralScore = integer(value.minStructuralScore, "最低结构分", 0, 100);
		if (!value.requireIntegrity && minStructuralScore === undefined) throw new Error("轨迹检查至少需要一项断言");
		return {
			id: value.id,
			label,
			type: value.type,
			requireIntegrity: value.requireIntegrity,
			...(minStructuralScore === undefined ? {} : { minStructuralScore }),
		};
	}
	if (value.type === "artifact") {
		const artifactId = value.artifactId.trim();
		if (!artifactId) throw new Error("产物检查必须选择或填写产物 ID");
		if (value.assertionKind === "exists")
			return { id: value.id, label, type: value.type, artifactId, assertion: { kind: "exists" } };
		if (value.assertionKind === "sha256") {
			const expected = value.value
				.trim()
				.toLowerCase()
				.replace(/^sha256:/, "");
			if (!/^[a-f0-9]{64}$/.test(expected)) throw new Error("SHA-256 必须是 64 位十六进制值");
			return {
				id: value.id,
				label,
				type: value.type,
				artifactId,
				assertion: { kind: "sha256", expected },
			};
		}
		if (value.assertionKind === "json_equals") {
			let expected: JsonValue;
			try {
				expected = JSON.parse(value.expectedJson) as JsonValue;
			} catch {
				throw new Error("JSON 期望值不是有效 JSON");
			}
			const pointer = value.pointer.trim();
			if (pointer !== "" && !pointer.startsWith("/")) throw new Error("JSON Pointer 必须为空或以 / 开头");
			return {
				id: value.id,
				label,
				type: value.type,
				artifactId,
				assertion: { kind: "json_equals", pointer, expected },
			};
		}
		if (!value.value) throw new Error("文本断言值不能为空");
		return {
			id: value.id,
			label,
			type: value.type,
			artifactId,
			assertion: {
				kind: value.assertionKind,
				value: value.value,
				caseSensitive: value.caseSensitive,
			},
		};
	}
	const command = value.command.trim();
	if (!command) throw new Error("命令不能为空");
	const expectedExitCode = integer(value.expectedExitCode, "退出码", 0, 255);
	const timeoutMs = integer(value.timeoutMs, "超时时间", 100, 300_000);
	return {
		id: value.id,
		label,
		type: value.type,
		command,
		...(expectedExitCode === undefined ? {} : { expectedExitCode }),
		...(value.stdoutContains ? { stdoutContains: value.stdoutContains } : {}),
		...(value.stderrNotContains ? { stderrNotContains: value.stderrNotContains } : {}),
		...(timeoutMs === undefined ? {} : { timeoutMs }),
	};
}

function graderDescription(grader: EvaluationGrader): string {
	if (grader.type === "trajectory")
		return `轨迹${grader.requireIntegrity === false ? "" : "完整"}${grader.minStructuralScore === undefined ? "" : ` · >= ${grader.minStructuralScore}`}`;
	if (grader.type === "artifact") return `产物 · ${grader.assertion.kind}`;
	return `命令 · exit ${grader.expectedExitCode ?? 0}`;
}

function downloadJson(filename: string, value: unknown): void {
	const url = URL.createObjectURL(new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: "application/json" }));
	try {
		const anchor = document.createElement("a");
		anchor.href = url;
		anchor.download = filename;
		anchor.click();
	} finally {
		setTimeout(() => URL.revokeObjectURL(url), 0);
	}
}

function statusLabel(status: RunEvaluation["status"]): string {
	return status === "pass" ? "通过" : status === "fail" ? "未通过" : "检查错误";
}

function DraftEditor({
	value,
	onChange,
	onRemove,
}: {
	value: DraftGrader;
	onChange: (value: DraftGrader) => void;
	onRemove: () => void;
}) {
	const changeType = (type: GraderType) => onChange(draft(type, 1));
	return (
		<div className="evaluation-grader-editor">
			<div className="evaluation-grader-head">
				<select
					aria-label="检查类型"
					value={value.type}
					onChange={(event) => changeType(event.target.value as GraderType)}
				>
					<option value="trajectory">执行轨迹</option>
					<option value="artifact">产物断言</option>
					<option value="command">隔离命令</option>
				</select>
				<input
					aria-label="检查名称"
					value={value.label}
					onChange={(event) => onChange({ ...value, label: event.target.value })}
				/>
				<button type="button" title="移除检查" aria-label="移除检查" onClick={onRemove}>
					<Trash2 size={14} />
				</button>
			</div>
			{value.type === "trajectory" && (
				<div className="evaluation-fields compact">
					<label className="evaluation-checkbox">
						<input
							type="checkbox"
							checked={value.requireIntegrity}
							onChange={(event) => onChange({ ...value, requireIntegrity: event.target.checked })}
						/>
						校验哈希链完整性
					</label>
					<label>
						<span>最低结构分</span>
						<input
							type="number"
							min="0"
							max="100"
							value={value.minStructuralScore}
							onChange={(event) => onChange({ ...value, minStructuralScore: event.target.value })}
						/>
					</label>
				</div>
			)}
			{value.type === "artifact" && (
				<div className="evaluation-fields">
					<label>
						<span>产物 ID</span>
						<input
							list="evaluation-artifacts"
							value={value.artifactId}
							onChange={(event) => onChange({ ...value, artifactId: event.target.value })}
						/>
					</label>
					<label>
						<span>断言</span>
						<select
							value={value.assertionKind}
							onChange={(event) => onChange({ ...value, assertionKind: event.target.value as ArtifactAssertionKind })}
						>
							<option value="exists">存在且完整</option>
							<option value="sha256">SHA-256 相等</option>
							<option value="text_contains">文本包含</option>
							<option value="text_not_contains">文本不包含</option>
							<option value="json_equals">JSON 值相等</option>
						</select>
					</label>
					{value.assertionKind === "sha256" && (
						<label className="evaluation-wide">
							<span>期望 SHA-256</span>
							<input value={value.value} onChange={(event) => onChange({ ...value, value: event.target.value })} />
						</label>
					)}
					{(value.assertionKind === "text_contains" || value.assertionKind === "text_not_contains") && (
						<>
							<label className="evaluation-wide">
								<span>文本值</span>
								<input value={value.value} onChange={(event) => onChange({ ...value, value: event.target.value })} />
							</label>
							<label className="evaluation-checkbox evaluation-wide">
								<input
									type="checkbox"
									checked={value.caseSensitive}
									onChange={(event) => onChange({ ...value, caseSensitive: event.target.checked })}
								/>
								区分大小写
							</label>
						</>
					)}
					{value.assertionKind === "json_equals" && (
						<>
							<label>
								<span>JSON Pointer</span>
								<input
									placeholder="/checks/0/status"
									value={value.pointer}
									onChange={(event) => onChange({ ...value, pointer: event.target.value })}
								/>
							</label>
							<label>
								<span>期望 JSON</span>
								<input
									value={value.expectedJson}
									onChange={(event) => onChange({ ...value, expectedJson: event.target.value })}
								/>
							</label>
						</>
					)}
				</div>
			)}
			{value.type === "command" && (
				<div className="evaluation-fields">
					<label className="evaluation-wide">
						<span>命令</span>
						<input
							placeholder="npm test"
							value={value.command}
							onChange={(event) => onChange({ ...value, command: event.target.value })}
						/>
					</label>
					<label>
						<span>期望退出码</span>
						<input
							type="number"
							min="0"
							max="255"
							value={value.expectedExitCode}
							onChange={(event) => onChange({ ...value, expectedExitCode: event.target.value })}
						/>
					</label>
					<label>
						<span>超时（ms）</span>
						<input
							type="number"
							min="100"
							max="300000"
							value={value.timeoutMs}
							onChange={(event) => onChange({ ...value, timeoutMs: event.target.value })}
						/>
					</label>
					<label>
						<span>stdout 包含</span>
						<input
							value={value.stdoutContains}
							onChange={(event) => onChange({ ...value, stdoutContains: event.target.value })}
						/>
					</label>
					<label>
						<span>stderr 不包含</span>
						<input
							value={value.stderrNotContains}
							onChange={(event) => onChange({ ...value, stderrNotContains: event.target.value })}
						/>
					</label>
				</div>
			)}
		</div>
	);
}

export function EvaluationDialog(props: EvaluationDialogProps) {
	const dialog = useFocusTrap<HTMLDivElement>();
	const [tab, setTab] = useState<"run" | "datasets">("run");
	const [selectedDatasetId, setSelectedDatasetId] = useState("");
	const [evaluations, setEvaluations] = useState<RunEvaluation[]>([]);
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState<string>();
	const [error, setError] = useState<string>();
	const [copied, setCopied] = useState(false);
	const [lastKeyId, setLastKeyId] = useState<string>();
	const [datasetName, setDatasetName] = useState("");
	const [drafts, setDrafts] = useState<DraftGrader[]>([draft("trajectory", 1)]);
	const [addType, setAddType] = useState<GraderType>("trajectory");
	const [pendingDeleteId, setPendingDeleteId] = useState<string>();
	const terminal = props.run.status !== "queued" && props.run.status !== "running";
	const selectedDataset = props.datasets.find((dataset) => dataset.id === selectedDatasetId);
	const artifactNames = useMemo(
		() => new Map(props.artifacts.map((artifact) => [artifact.id, artifact.name])),
		[props.artifacts]
	);

	useEffect(() => {
		let active = true;
		setLoading(true);
		Promise.all([
			props.enabled ? props.onRefreshDatasets(props.workspaceId) : Promise.resolve([]),
			props.enabled ? props.onListEvaluations(props.run.id) : Promise.resolve([]),
		])
			.then(([, values]) => {
				if (active) setEvaluations(values);
			})
			.catch((reason) => {
				if (active) setError(reason instanceof Error ? reason.message : String(reason));
			})
			.finally(() => {
				if (active) setLoading(false);
			});
		return () => {
			active = false;
		};
	}, [props.enabled, props.onListEvaluations, props.onRefreshDatasets, props.run.id, props.workspaceId]);

	useEffect(() => {
		if (selectedDatasetId && props.datasets.some((dataset) => dataset.id === selectedDatasetId)) return;
		setSelectedDatasetId(props.datasets[0]?.id ?? "");
	}, [props.datasets, selectedDatasetId]);

	useEffect(() => {
		const close = (event: KeyboardEvent) => {
			if (event.key === "Escape" && !busy) props.onClose();
		};
		document.addEventListener("keydown", close);
		return () => document.removeEventListener("keydown", close);
	}, [busy, props.onClose]);

	const evaluate = async () => {
		setBusy("evaluate");
		setError(undefined);
		try {
			const evaluation = await props.onEvaluate(
				props.run.id,
				selectedDataset
					? { datasetId: selectedDataset.id }
					: {
							name: "即时结构检查",
							graders: [
								{
									id: "trajectory-default",
									label: "轨迹完整性与结构分",
									type: "trajectory",
									requireIntegrity: true,
									minStructuralScore: 70,
								},
							],
						}
			);
			setEvaluations((current) => [evaluation, ...current.filter((candidate) => candidate.id !== evaluation.id)]);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setBusy(undefined);
		}
	};

	const createDataset = async (event: FormEvent) => {
		event.preventDefault();
		setBusy("create");
		setError(undefined);
		try {
			const name = datasetName.trim();
			if (!name) throw new Error("数据集名称不能为空");
			const graders = drafts.map(toGrader);
			const created = await props.onCreateDataset(name, graders);
			setDatasetName("");
			setDrafts([draft("trajectory", 1)]);
			setSelectedDatasetId(created.id);
			setTab("run");
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setBusy(undefined);
		}
	};

	const removeDataset = async (datasetId: string) => {
		if (pendingDeleteId !== datasetId) {
			setPendingDeleteId(datasetId);
			return;
		}
		setBusy(datasetId);
		setError(undefined);
		try {
			await props.onDeleteDataset(datasetId);
			setPendingDeleteId(undefined);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setBusy(undefined);
		}
	};

	const attest = async (evaluation: RunEvaluation) => {
		setBusy(evaluation.id);
		setError(undefined);
		try {
			const attestation = await props.onAttest(props.run.id, evaluation.id);
			downloadJson(`wuming-evaluation-${props.run.id.slice(0, 8)}-${evaluation.id.slice(0, 8)}.json`, {
				evaluation,
				attestation,
			});
			setLastKeyId(attestation.keyId);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setBusy(undefined);
		}
	};

	const copyDiagnostic = async () => {
		await props.onCopyDiagnostic();
		setCopied(true);
		window.setTimeout(() => setCopied(false), 1600);
	};

	return (
		<div
			className="modal-backdrop evaluation-backdrop"
			role="presentation"
			onMouseDown={() => !busy && props.onClose()}
		>
			<div
				className="evaluation-dialog"
				role="dialog"
				aria-modal="true"
				aria-labelledby="evaluation-title"
				ref={dialog}
				tabIndex={-1}
				onMouseDown={(event) => event.stopPropagation()}
			>
				<datalist id="evaluation-artifacts">
					{props.artifacts.map((artifact) => (
						<option value={artifact.id} key={artifact.id}>
							{artifact.name}
						</option>
					))}
				</datalist>
				<div className="dialog-header evaluation-header">
					<div>
						<h2 id="evaluation-title">运行评测</h2>
						<span>
							{props.run.id} · {props.run.status}
						</span>
					</div>
					<div className="evaluation-header-actions">
						<button
							className="icon-button"
							type="button"
							title={copied ? "诊断已复制" : "复制脱敏诊断"}
							onClick={() => void copyDiagnostic()}
						>
							{copied ? <Check size={16} /> : <Copy size={16} />}
						</button>
						<button className="icon-button" type="button" title="关闭" onClick={props.onClose}>
							<X size={18} />
						</button>
					</div>
				</div>
				<div className="evaluation-tabs" role="tablist" aria-label="评测视图">
					<button type="button" role="tab" aria-selected={tab === "run"} onClick={() => setTab("run")}>
						执行与结果
					</button>
					<button type="button" role="tab" aria-selected={tab === "datasets"} onClick={() => setTab("datasets")}>
						回归数据集
					</button>
				</div>
				{error && (
					<div className="evaluation-error" role="alert">
						<CircleAlert size={14} />
						{error}
					</div>
				)}
				{!props.enabled && <div className="evaluation-empty">当前网关未启用评测能力。</div>}
				{tab === "run" && props.enabled && (
					<div className="evaluation-scroll">
						<section className="evaluation-run-config">
							<div className="evaluation-section-heading">
								<div>
									<h3>检查方案</h3>
									<span>结构检查不等同于语义正确性；数据集可加入产物与命令断言。</span>
								</div>
								<button
									type="button"
									title="刷新数据集和评测历史"
									aria-label="刷新数据集和评测历史"
									disabled={Boolean(busy)}
									onClick={() => {
										setLoading(true);
										Promise.all([props.onRefreshDatasets(props.workspaceId), props.onListEvaluations(props.run.id)])
											.then(([, values]) => setEvaluations(values))
											.catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)))
											.finally(() => setLoading(false));
									}}
								>
									<RefreshCw className={loading ? "spin" : ""} size={14} />
								</button>
							</div>
							<div className="evaluation-run-controls">
								<label>
									<span>数据集</span>
									<select value={selectedDatasetId} onChange={(event) => setSelectedDatasetId(event.target.value)}>
										<option value="">即时结构检查</option>
										{props.datasets.map((dataset) => (
											<option value={dataset.id} key={dataset.id}>
												{dataset.name}
											</option>
										))}
									</select>
								</label>
								<button
									className="evaluation-primary"
									type="button"
									disabled={!terminal || Boolean(busy)}
									onClick={() => void evaluate()}
								>
									<ShieldCheck size={15} />
									{busy === "evaluate" ? "检查中..." : "运行评测"}
								</button>
							</div>
							{selectedDataset && (
								<div className="evaluation-spec">
									{selectedDataset.graders.map((grader) => (
										<span key={grader.id}>
											{grader.label} · {graderDescription(grader)}
										</span>
									))}
								</div>
							)}
							{!terminal && <p className="evaluation-note">运行结束后才能评测，当前状态为 {props.run.status}。</p>}
						</section>
						<section>
							<div className="evaluation-section-heading">
								<div>
									<h3>评测历史</h3>
									<span>{evaluations.length} 条</span>
								</div>
							</div>
							{loading && <div className="evaluation-empty">正在读取评测...</div>}
							{!loading && evaluations.length === 0 && <div className="evaluation-empty">暂无评测记录</div>}
							<div className="evaluation-results">
								{evaluations.map((evaluation) => (
									<div className={`evaluation-result result-${evaluation.status}`} key={evaluation.id}>
										<div className="evaluation-result-head">
											<div>
												<strong>{evaluation.name}</strong>
												<span>
													{statusLabel(evaluation.status)} · {new Date(evaluation.finishedAt).toLocaleString("zh-CN")}
												</span>
											</div>
											<button
												type="button"
												title="生成签名并导出 JSON"
												aria-label="生成签名并导出 JSON"
												disabled={Boolean(busy)}
												onClick={() => void attest(evaluation)}
											>
												<Download size={14} />
											</button>
										</div>
										{evaluation.checks.map((check) => (
											<div className={`evaluation-check check-${check.status}`} key={check.graderId}>
												<div>
													<span className="evaluation-check-mark">
														{check.status === "pass" ? "✓" : check.status === "fail" ? "×" : "!"}
													</span>
													<strong>{check.label}</strong>
													<time>{check.durationMs}ms</time>
												</div>
												<p>{check.evidence}</p>
												{check.artifactId && (
													<small title={check.artifactId}>
														产物 {artifactNames.get(check.artifactId) ?? check.artifactId}
													</small>
												)}
												{check.outputDigest && (
													<small title={check.outputDigest}>输出摘要 {check.outputDigest.slice(0, 20)}...</small>
												)}
											</div>
										))}
										<div className="evaluation-digests">
											<span title={evaluation.digest}>评测 {evaluation.digest.slice(0, 20)}...</span>
											<span title={evaluation.trajectoryHeadDigest ?? "无轨迹摘要"}>
												轨迹 {evaluation.trajectoryHeadDigest?.slice(0, 20) ?? "无"}...
											</span>
										</div>
									</div>
								))}
							</div>
							{lastKeyId && (
								<p className="evaluation-note" title={lastKeyId}>
									最近导出签名密钥：{lastKeyId.slice(0, 24)}...
								</p>
							)}
						</section>
					</div>
				)}
				{tab === "datasets" && props.enabled && (
					<div className="evaluation-scroll evaluation-dataset-layout">
						<section>
							<div className="evaluation-section-heading">
								<div>
									<h3>已保存数据集</h3>
									<span>{props.datasets.length} 个</span>
								</div>
							</div>
							{props.datasets.length === 0 && <div className="evaluation-empty">暂无回归数据集</div>}
							<div className="evaluation-dataset-list">
								{props.datasets.map((dataset) => (
									<div className="evaluation-dataset-row" key={dataset.id}>
										<div>
											<strong>{dataset.name}</strong>
											<span>
												{dataset.graders.length} 项检查 · {new Date(dataset.updatedAt).toLocaleString("zh-CN")}
											</span>
										</div>
										<button
											className={pendingDeleteId === dataset.id ? "confirm-delete" : ""}
											type="button"
											title={pendingDeleteId === dataset.id ? "再次点击确认删除" : "删除数据集"}
											aria-label={pendingDeleteId === dataset.id ? "确认删除数据集" : "删除数据集"}
											disabled={Boolean(busy)}
											onClick={() => void removeDataset(dataset.id)}
										>
											<Trash2 size={14} />
										</button>
									</div>
								))}
							</div>
						</section>
						<form className="evaluation-dataset-form" onSubmit={(event) => void createDataset(event)}>
							<div className="evaluation-section-heading">
								<div>
									<h3>新建数据集</h3>
									<span>保存到当前工作区</span>
								</div>
							</div>
							<label className="evaluation-name">
								<span>名称</span>
								<input maxLength={300} value={datasetName} onChange={(event) => setDatasetName(event.target.value)} />
							</label>
							<div className="evaluation-graders">
								{drafts.map((value, index) => (
									<DraftEditor
										key={value.id}
										value={value}
										onChange={(next) =>
											setDrafts((current) =>
												current.map((candidate, candidateIndex) => (candidateIndex === index ? next : candidate))
											)
										}
										onRemove={() =>
											setDrafts((current) => current.filter((_, candidateIndex) => candidateIndex !== index))
										}
									/>
								))}
							</div>
							<div className="evaluation-form-actions">
								<div>
									<select
										aria-label="要添加的检查类型"
										value={addType}
										onChange={(event) => setAddType(event.target.value as GraderType)}
									>
										<option value="trajectory">执行轨迹</option>
										<option value="artifact">产物断言</option>
										<option value="command">隔离命令</option>
									</select>
									<button
										type="button"
										title="添加检查"
										aria-label="添加检查"
										disabled={drafts.length >= 20}
										onClick={() => setDrafts((current) => [...current, draft(addType, current.length + 1)])}
									>
										<Plus size={14} />
									</button>
								</div>
								<button className="evaluation-primary" type="submit" disabled={Boolean(busy) || drafts.length === 0}>
									<Check size={15} />
									{busy === "create" ? "保存中..." : "保存数据集"}
								</button>
							</div>
						</form>
					</div>
				)}
			</div>
		</div>
	);
}
