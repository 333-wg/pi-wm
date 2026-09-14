import { useEffect, useState } from "react";
import { Image, Video, Save, Trash2, RefreshCw, ListFilter, Star } from "lucide-react";
import type {
	CustomModelCandidate,
	MediaKind,
	MediaModelConfig,
	MediaModelDiscoveryConnection,
	MediaModelSettings as SavedModel,
} from "@wuming/protocol";

interface Props {
	connected: boolean;
	onList: () => Promise<SavedModel[]>;
	onSave: (config: MediaModelConfig) => Promise<SavedModel[]>;
	onRemove: (kind: MediaKind) => Promise<SavedModel[]>;
	onDiscover: (connection: MediaModelDiscoveryConnection) => Promise<CustomModelCandidate[]>;
}

function ModelForm({
	kind,
	saved,
	connected,
	onSave,
	onRemove,
	onDiscover,
}: Omit<Props, "onList"> & { kind: MediaKind; saved?: SavedModel | undefined }) {
	const [baseUrl, setBaseUrl] = useState(saved?.baseUrl ?? "");
	const [model, setModel] = useState(saved?.model ?? "");
	const [apiKey, setApiKey] = useState("");
	const [busy, setBusy] = useState(false);
	const [notice, setNotice] = useState("");
	const [error, setError] = useState("");
	const [candidates, setCandidates] = useState<CustomModelCandidate[]>([]);
	const savedModelsKey = JSON.stringify(saved?.models ?? (saved?.model ? [saved.model] : []));
	const [selectedModels, setSelectedModels] = useState<string[]>(saved?.models ?? (saved?.model ? [saved.model] : []));
	const [search, setSearch] = useState("");
	const imageModels = [...new Set([...selectedModels, model.trim()].filter(Boolean))];
	const imageOptions = new Map(candidates.map((candidate) => [candidate.id, candidate]));
	for (const id of [...(JSON.parse(savedModelsKey) as string[]), ...imageModels])
		if (!imageOptions.has(id)) imageOptions.set(id, { id, name: id });
	function toggleImageModel(id: string, checked: boolean) {
		const next = checked ? [...new Set([...imageModels, id])] : imageModels.filter((value) => value !== id);
		setSelectedModels(next);
		if (!model.trim() || !next.includes(model.trim())) setModel(next[0] ?? "");
	}
	const kindLabel = kind === "image" ? "生图" : "生视频";
	const canDiscover = Boolean(
		baseUrl.trim() && (apiKey.trim() || (saved?.authenticated && baseUrl.trim().replace(/\/+$/, "") === saved.baseUrl))
	);
	function invalidateDiscovery() {
		setCandidates([]);
		setNotice("");
		setError("");
		setSearch("");
	}
	const dirty =
		baseUrl.trim().replace(/\/+$/, "") !== saved?.baseUrl ||
		model.trim() !== saved?.model ||
		Boolean(apiKey) ||
		(kind === "image" &&
			JSON.stringify([...imageModels].sort()) !== JSON.stringify([...(JSON.parse(savedModelsKey) as string[])].sort()));
	useEffect(() => {
		setBaseUrl(saved?.baseUrl ?? "");
		setModel(saved?.model ?? "");
		setApiKey("");
		setNotice("");
		setError("");
		setCandidates([]);
		setSelectedModels(JSON.parse(savedModelsKey) as string[]);
		setSearch("");
	}, [saved?.baseUrl, saved?.model, savedModelsKey]);
	async function perform(action: () => Promise<void>) {
		setBusy(true);
		setNotice("");
		setError("");
		try {
			await action();
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : "操作失败");
		} finally {
			setBusy(false);
		}
	}
	return (
		<form
			className="media-model-form"
			onSubmit={(event) => {
				event.preventDefault();
				void perform(async () => {
					await onSave({
						kind,
						baseUrl: baseUrl.trim(),
						model: model.trim(),
						...(kind === "image" ? { models: imageModels } : {}),
						...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
					});
					setApiKey("");
				});
			}}
		>
			<div className="media-model-heading">
				{kind === "image" ? <Image size={18} /> : <Video size={18} />}
				<h4>{kind === "image" ? "默认生图模型" : "默认生视频模型"}</h4>
				<span>{saved ? (kind === "image" ? `已配置 ${saved.models?.length ?? 1} 个` : "已配置") : "未配置"}</span>
			</div>
			<fieldset disabled={!connected || busy}>
				<label>
					接口协议
					<input
						readOnly
						value={kind === "image" ? "OpenAI Images（官方 / 兼容中转）" : "视频任务接口（OpenAI / Agnes v2.0）"}
					/>
				</label>
				<label>
					Base URL
					<input
						type="url"
						required
						value={baseUrl}
						placeholder="https://api.openai.com/v1"
						autoComplete="off"
						onChange={(event) => {
							setBaseUrl(event.target.value);
							invalidateDiscovery();
						}}
					/>
				</label>
				<label>
					{kind === "image" ? "默认模型 ID" : "模型 ID"}
					<input
						required
						maxLength={200}
						value={model}
						autoComplete="off"
						onChange={(event) => setModel(event.target.value)}
					/>
				</label>
				<label>
					API Key
					<input
						type="password"
						value={apiKey}
						autoComplete="new-password"
						placeholder={saved ? "已保存，留空不修改" : "输入 API Key"}
						onChange={(event) => {
							setApiKey(event.target.value);
							invalidateDiscovery();
						}}
					/>
				</label>
				{kind === "image" && imageOptions.size > 0 && (
					<div className="media-image-models" role="group" aria-label="生图模型多选">
						<div className="media-image-models-heading">
							<span>生图模型</span>
							<span>已选 {imageModels.length} / 50</span>
						</div>
						{imageOptions.size > 8 && (
							<input
								type="search"
								aria-label="筛选生图模型"
								placeholder="筛选模型"
								value={search}
								onChange={(event) => setSearch(event.target.value)}
							/>
						)}
						<div className="media-image-model-list">
							{[...imageOptions.values()]
								.filter((candidate) => `${candidate.id} ${candidate.name}`.toLowerCase().includes(search.toLowerCase()))
								.map((candidate) => (
									<div className="media-image-model-row" key={candidate.id}>
										<label>
											<input
												type="checkbox"
												checked={imageModels.includes(candidate.id)}
												disabled={imageModels.length >= 50 && !imageModels.includes(candidate.id)}
												onChange={(event) => toggleImageModel(candidate.id, event.target.checked)}
											/>
											<span>
												{candidate.id}
												{candidate.name !== candidate.id && <small>{candidate.name}</small>}
											</span>
										</label>
										<button
											type="button"
											className="icon-button"
											disabled={!imageModels.includes(candidate.id)}
											aria-label={`设为默认：${candidate.id}`}
											title={candidate.id === model.trim() ? "默认生图模型" : "设为默认生图模型"}
											aria-pressed={candidate.id === model.trim()}
											onClick={() => {
												setSelectedModels(imageModels);
												setModel(candidate.id);
											}}
										>
											<Star size={15} fill={candidate.id === model.trim() ? "currentColor" : "none"} />
										</button>
									</div>
								))}
						</div>
					</div>
				)}
				{kind === "video" && candidates.length > 0 && (
					<label className="media-model-candidates">
						已获取的{kindLabel}模型
						<select
							value={candidates.some((candidate) => candidate.id === model) ? model : ""}
							onChange={(event) => {
								if (event.target.value) setModel(event.target.value);
							}}
						>
							<option value="" disabled>
								选择模型
							</option>
							{candidates.map((candidate) => (
								<option key={candidate.id} value={candidate.id}>
									{candidate.name === candidate.id ? candidate.id : `${candidate.name} (${candidate.id})`}
								</option>
							))}
						</select>
					</label>
				)}
				<div className="media-model-actions">
					<button
						type="button"
						className="secondary-button"
						disabled={!canDiscover}
						onClick={() =>
							void perform(async () => {
								setCandidates([]);
								const values = await onDiscover({
									kind,
									baseUrl: baseUrl.trim(),
									...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
								});
								setCandidates(values);
								setNotice(
									values.length
										? `已获取 ${values.length} 个${kindLabel}候选模型，实际生成能力尚未验证`
										: `模型列表已返回，但未识别到${kindLabel}模型；请确认该 Key 的模型权限，或手动填写模型 ID`
								);
							})
						}
					>
						<ListFilter size={14} />
						获取模型
					</button>
					<button
						type="submit"
						className="primary-button"
						disabled={!baseUrl.trim() || !model.trim() || !dirty || (kind === "image" && imageModels.length > 50)}
					>
						<Save size={14} />
						保存
					</button>
					<button
						type="button"
						className="icon-button"
						title="移除默认模型"
						aria-label="移除默认模型"
						disabled={!saved}
						onClick={() => {
							if (window.confirm(`移除${kind === "image" ? "生图" : "生视频"}默认模型配置？`))
								void perform(async () => {
									await onRemove(kind);
								});
						}}
					>
						<Trash2 size={14} />
					</button>
				</div>
			</fieldset>
			{busy && <div role="status">处理中…</div>}
			{kind === "image" && imageModels.length > 50 && (
				<div className="media-model-error" role="alert">
					最多选择 50 个生图模型
				</div>
			)}
			{notice && (
				<div className="media-model-notice" role="status">
					{notice}
				</div>
			)}
			{error && (
				<div className="media-model-error" role="alert">
					{error}
				</div>
			)}
		</form>
	);
}

export function MediaModelSettings(props: Props) {
	const [settings, setSettings] = useState<SavedModel[]>([]);
	const [loaded, setLoaded] = useState(false);
	const [error, setError] = useState("");
	const [revision, setRevision] = useState(0);
	useEffect(() => {
		let disposed = false;
		setLoaded(false);
		setError("");
		if (props.connected)
			void props
				.onList()
				.then((values) => {
					if (!disposed) {
						setSettings(values);
						setLoaded(true);
					}
				})
				.catch((failure) => {
					if (!disposed) setError(failure instanceof Error ? failure.message : "读取生成模型失败");
				});
		return () => {
			disposed = true;
		};
	}, [props.connected, props.onList, revision]);
	return (
		<section className="media-model-settings" aria-label="图片与视频生成模型">
			<h3>图片与视频生成</h3>
			{error ? (
				<div role="alert">
					{error}
					<button
						type="button"
						className="icon-button"
						title="重新加载"
						onClick={() => setRevision((value) => value + 1)}
					>
						<RefreshCw size={14} />
					</button>
				</div>
			) : null}
			{(["image", "video"] as const).map((kind) => (
				<ModelForm
					key={kind}
					kind={kind}
					saved={settings.find((value) => value.kind === kind)}
					connected={props.connected && loaded}
					onSave={async (config) => {
						const values = await props.onSave(config);
						setSettings(values);
						return values;
					}}
					onRemove={async (value) => {
						const values = await props.onRemove(value);
						setSettings(values);
						return values;
					}}
					onDiscover={props.onDiscover}
				/>
			))}
		</section>
	);
}
