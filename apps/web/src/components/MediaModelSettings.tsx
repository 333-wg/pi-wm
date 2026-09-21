import { useEffect, useState } from "react";
import { Image, Video, Save, Trash2, RefreshCw, ListFilter, Star, Pencil } from "lucide-react";
import type {
	CustomModelCandidate,
	CustomModelConfig,
	CustomModelSettings,
	ModelRef,
	MediaKind,
	MediaModelConfig,
	MediaModelDiscoveryConnection,
	MediaModelSettings as SavedModel,
	VideoProtocolPreference,
} from "@wuming/protocol";

interface Props {
	onSetDefaultVideo: (model: ModelRef) => Promise<SavedModel[]>;
	onRemoveVideo: (model: ModelRef) => Promise<SavedModel[]>;
	onSetDefaultImage: (model: ModelRef) => Promise<SavedModel[]>;
	onRemoveImage: (model: ModelRef) => Promise<SavedModel[]>;
	revision: number;
	onListCatalog: () => Promise<CustomModelSettings[]>;
	onRemoveCatalog: (model: ModelRef) => Promise<void>;
	onConfigureCatalog: (configs: CustomModelConfig[]) => Promise<unknown>;
	connected: boolean;
	onList: () => Promise<SavedModel[]>;
	onSave: (config: MediaModelConfig) => Promise<SavedModel[]>;
	onRemove: (kind: MediaKind) => Promise<SavedModel[]>;
	onDiscover: (connection: MediaModelDiscoveryConnection) => Promise<CustomModelCandidate[]>;
}

const nativeVideoPresets = {
	"google-veo": {
		label: "Google Veo",
		baseUrl: "https://generativelanguage.googleapis.com/v1beta",
		model: "veo-3.1-generate-preview",
	},
	"google-omni": {
		label: "Google Gemini Omni",
		baseUrl: "https://generativelanguage.googleapis.com/v1beta",
		model: "gemini-omni-1.1-flash",
	},
	grok: { label: "Grok Imagine Video", baseUrl: "https://api.x.ai/v1", model: "grok-imagine-video-1.5" },
	seedance: {
		label: "豆包 / Seedance（火山方舟）",
		baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
		model: "doubao-seedance-1-5-pro-251215",
	},
	jimeng: { label: "即梦（火山视觉 API）", baseUrl: "https://visual.volcengineapi.com", model: "jimeng_ti2v_v30_pro" },
	kling: { label: "可灵 Kling", baseUrl: "https://api-beijing.klingai.com/v1", model: "kling-v2-6" },
	wan: { label: "通义万相 Wan", baseUrl: "https://dashscope.aliyuncs.com/api/v1", model: "wan2.6-t2v" },
	minimax: { label: "MiniMax / 海螺", baseUrl: "https://api.minimaxi.com/v1", model: "MiniMax-Hailuo-2.3" },
	vidu: { label: "Vidu", baseUrl: "https://api.vidu.cn/ent/v2", model: "viduq2" },
};
type NativeVideoProtocol = keyof typeof nativeVideoPresets;
function nativeProtocol(
	protocol: VideoProtocolPreference,
	baseUrl: string,
	model: string
): NativeVideoProtocol | undefined {
	if (protocol in nativeVideoPresets) return protocol as NativeVideoProtocol;
	if (protocol !== "auto") return undefined;
	try {
		const host = new URL(baseUrl).hostname;
		if (host === "generativelanguage.googleapis.com" && model.startsWith("gemini-omni-")) return "google-omni";
		return Object.keys(nativeVideoPresets).find((key) => {
			const expected = new URL(nativeVideoPresets[key as NativeVideoProtocol].baseUrl).hostname;
			return (
				host === expected ||
				(
					{
						seedance: ["ark.ap-southeast.bytepluses.com"],
						kling: ["api.klingai.com", "api-singapore.klingai.com"],
						wan: ["dashscope-intl.aliyuncs.com", "dashscope-us.aliyuncs.com"],
						minimax: ["api.minimax.io", "api.minimax.chat"],
						vidu: ["api.vidu.com"],
					} as Record<string, string[]>
				)[key]?.includes(host)
			);
		}) as NativeVideoProtocol | undefined;
	} catch {
		return undefined;
	}
}

function ModelForm({
	kind,
	saved,
	managed = false,
	connected,
	onSave,
	onRemove,
	onDiscover,
}: Pick<Props, "connected" | "onSave" | "onRemove" | "onDiscover"> & {
	kind: MediaKind;
	saved?: SavedModel | undefined;
	managed?: boolean;
}) {
	const [baseUrl, setBaseUrl] = useState(saved?.baseUrl ?? "");
	const [model, setModel] = useState(saved?.model ?? "");
	const [apiKey, setApiKey] = useState("");
	const [apiSecret, setApiSecret] = useState("");
	const [videoProtocol, setVideoProtocol] = useState<VideoProtocolPreference>(saved?.videoProtocol ?? "auto");
	const [base64Reference, setBase64Reference] = useState(saved?.videoReferenceFormat === "data-url");
	const native = kind === "video" ? nativeProtocol(videoProtocol, baseUrl, model) : undefined;
	const pairCredentials = native === "jimeng" || native === "kling";
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
		!native &&
		baseUrl.trim() &&
		(apiKey.trim() || (saved?.authenticated && baseUrl.trim().replace(/\/+$/, "") === saved.baseUrl))
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
		Boolean(apiSecret) ||
		(kind === "video" &&
			(videoProtocol !== (saved?.videoProtocol ?? "auto") ||
				base64Reference !== (saved?.videoReferenceFormat === "data-url"))) ||
		(kind === "image" &&
			JSON.stringify([...imageModels].sort()) !== JSON.stringify([...(JSON.parse(savedModelsKey) as string[])].sort()));
	useEffect(() => {
		setBaseUrl(saved?.baseUrl ?? "");
		setModel(saved?.model ?? "");
		setApiKey("");
		setApiSecret("");
		setVideoProtocol(saved?.videoProtocol ?? "auto");
		setBase64Reference(saved?.videoReferenceFormat === "data-url");
		setNotice("");
		setError("");
		setCandidates([]);
		setSelectedModels(JSON.parse(savedModelsKey) as string[]);
		setSearch("");
	}, [saved?.baseUrl, saved?.model, saved?.videoProtocol, saved?.videoReferenceFormat, savedModelsKey]);
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
						...(kind === "video" && saved?.provider ? { provider: saved.provider } : {}),
						baseUrl: baseUrl.trim(),
						model: model.trim(),
						...(kind === "image" ? { models: imageModels } : {}),
						...(kind === "video"
							? { videoProtocol, videoReferenceFormat: base64Reference ? ("data-url" as const) : ("auto" as const) }
							: {}),
						...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
						...(pairCredentials && apiSecret.trim() ? { apiSecret: apiSecret.trim() } : {}),
					});
					setApiKey("");
					setApiSecret("");
				});
			}}
		>
			<div className="media-model-heading">
				{kind === "image" ? <Image size={18} /> : <Video size={18} />}
				<h4>{kind === "image" ? "添加生图服务" : saved ? "视频模型配置" : "添加视频服务"}</h4>
				<span>{saved ? (kind === "image" ? `已配置 ${saved.models?.length ?? 1} 个` : "已配置") : "未配置"}</span>
			</div>
			<fieldset disabled={!connected || busy}>
				<label>
					接口协议
					{kind === "image" ? (
						<input readOnly value="OpenAI Images（官方 / 兼容中转）" />
					) : (
						<select
							value={videoProtocol}
							onChange={(event) => {
								const next = event.target.value as VideoProtocolPreference;
								setVideoProtocol(next);
								setBase64Reference(false);
								invalidateDiscovery();
								if (!saved && next in nativeVideoPresets) {
									const preset = nativeVideoPresets[next as NativeVideoProtocol];
									setBaseUrl(preset.baseUrl);
									setModel("");
									setApiKey("");
									setApiSecret("");
								}
							}}
						>
							<option value="auto">自动识别</option>
							<option value="openai">OpenAI Videos / 兼容中转</option>
							<option value="openai-json">OpenAI Videos / JSON 中转</option>
							<option value="agnes-v2.5">Agnes 2.5 / Flash</option>
							<option value="agnes">Agnes v2.0</option>
							{Object.entries(nativeVideoPresets).map(([value, preset]) => (
								<option key={value} value={value}>
									{preset.label}
								</option>
							))}
						</select>
					)}
				</label>
				{kind === "video" && !native && (
					<label
						className="media-reference-format"
						title="默认按模型自动选择传图方式；官方 Agnes 2.5 Flash 已自动使用 Base64。仅在其他服务支持时强制启用。"
					>
						<input
							type="checkbox"
							checked={base64Reference}
							onChange={(event) => setBase64Reference(event.target.checked)}
						/>
						强制参考图使用 Base64 Data URL
					</label>
				)}
				<label>
					Base URL
					<input
						type="url"
						required
						value={baseUrl}
						readOnly={kind === "video" && Boolean(saved?.provider)}
						placeholder="https://api.openai.com/v1"
						autoComplete="off"
						onChange={(event) => {
							setBaseUrl(event.target.value);
							invalidateDiscovery();
						}}
					/>
				</label>
				<label>
					{native === "jimeng" ? "模型 req_key" : "模型 ID"}
					<input
						required
						maxLength={200}
						value={model}
						placeholder={native ? nativeVideoPresets[native].model : undefined}
						readOnly={kind === "video" && Boolean(saved?.provider)}
						autoComplete="off"
						onChange={(event) => setModel(event.target.value)}
					/>
				</label>
				<label>
					{pairCredentials ? "Access Key" : "API Key"}
					<input
						type="password"
						value={apiKey}
						readOnly={managed}
						autoComplete="new-password"
						placeholder={saved ? "已保存，留空不修改" : "输入 API Key"}
						onChange={(event) => {
							setApiKey(event.target.value);
							invalidateDiscovery();
						}}
					/>
				</label>
				{pairCredentials && (
					<label>
						Secret Key
						<input
							type="password"
							value={apiSecret}
							autoComplete="new-password"
							placeholder={saved ? "已保存时留空不修改" : "输入 Secret Key"}
							onChange={(event) => setApiSecret(event.target.value)}
						/>
					</label>
				)}
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
						title={native ? "原生服务请填写控制台模型 ID；即梦填写 req_key" : undefined}
						disabled={!canDiscover || (kind === "video" && Boolean(saved?.provider))}
						onClick={() =>
							void perform(async () => {
								setCandidates([]);
								const values = await onDiscover({
									kind,
									...(saved?.provider ? { provider: saved.provider } : {}),
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
						title="移除此模型"
						aria-label="移除此模型"
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
	const [catalog, setCatalog] = useState<CustomModelSettings[]>([]);
	const [catalogBusy, setCatalogBusy] = useState(false);
	const [catalogError, setCatalogError] = useState("");
	const [loaded, setLoaded] = useState(false);
	const [error, setError] = useState("");
	const [revision, setRevision] = useState(0);
	const [addImageOpen, setAddImageOpen] = useState(false);
	const [addVideoOpen, setAddVideoOpen] = useState(false);
	const [editingVideo, setEditingVideo] = useState<ModelRef>();
	const imageSettings = settings.find((value) => value.kind === "image");
	const videoSettings = settings.find((value) => value.kind === "video");
	const videoToEdit = videoSettings?.availableModels?.find(
		(item) => item.provider === editingVideo?.provider && item.id === editingVideo.id
	);
	useEffect(() => {
		let disposed = false;
		setLoaded(false);
		setError("");
		if (props.connected)
			void Promise.all([props.onList(), props.onListCatalog()])
				.then(([values, models]) => {
					if (!disposed) {
						setSettings(values);
						setCatalog(models);
						setLoaded(true);
					}
				})
				.catch((failure) => {
					if (!disposed) setError(failure instanceof Error ? failure.message : "读取生成模型失败");
				});
		return () => {
			disposed = true;
		};
	}, [props.connected, props.onList, props.onListCatalog, props.revision, revision]);
	async function catalogAction(action: () => Promise<unknown>) {
		setCatalogBusy(true);
		setCatalogError("");
		try {
			await action();
		} catch (failure) {
			setCatalogError(failure instanceof Error ? failure.message : "操作失败");
		} finally {
			setCatalogBusy(false);
		}
	}
	async function saveVideo(config: MediaModelConfig) {
		const values = await props.onSave(config);
		setSettings(values);
		return values;
	}
	return (
		<section className="media-model-settings" aria-label="图片与视频生成模型">
			<h3>图片与视频生成</h3>
			{catalogError && (
				<div className="media-model-error" role="alert">
					{catalogError}
				</div>
			)}
			<div className="media-imported-models">
				<div className="saved-models-heading">
					<strong>已添加生图模型</strong>
					<span>{imageSettings?.availableModels?.length ?? 0}</span>
				</div>
				{(imageSettings?.availableModels ?? []).map((item) => {
					const active = imageSettings?.provider === item.provider && imageSettings.model === item.id;
					const original = catalog.find(
						(candidate) => candidate.model.provider === item.provider && candidate.model.id === item.id
					);
					return (
						<div className="custom-model-row" key={`${item.provider}/${item.id}`} data-provider={item.provider}>
							<span className="custom-model-copy">
								<strong>{item.name}</strong>
								<small>{item.id}</small>
								<small>{item.baseUrl}</small>
							</span>
							<div className="custom-model-row-actions">
								{original && (
									<select
										className="model-kind-select"
										aria-label={`模型类型：${item.id}`}
										value="image"
										disabled={catalogBusy || !props.connected || !loaded}
										onChange={(event) => {
											const { model, thinkingLevels: _levels, ...config } = original;
											void catalogAction(() =>
												props.onConfigureCatalog([
													{
														...config,
														provider: model.provider,
														id: model.id,
														kind: event.target.value as "chat" | "image" | "video",
													},
												])
											);
										}}
									>
										<option value="chat">对话</option>
										<option value="image">生图</option>
										<option value="video">视频</option>
									</select>
								)}
								<button
									type="button"
									className="icon-button"
									title={active ? "当前默认模型" : "设为默认模型"}
									aria-label={`启用默认模型：${item.id}`}
									aria-pressed={active}
									disabled={catalogBusy || !props.connected || !loaded || active}
									onClick={() =>
										void catalogAction(async () =>
											setSettings(await props.onSetDefaultImage({ provider: item.provider, id: item.id }))
										)
									}
								>
									<Star size={15} fill={active ? "currentColor" : "none"} />
								</button>
								<button
									type="button"
									className="icon-button"
									title="移除已添加模型"
									aria-label={`移除模型：${item.id}`}
									disabled={catalogBusy || !props.connected || !loaded}
									onClick={() => {
										if (window.confirm(`移除已添加的模型 ${item.name}？`))
											void catalogAction(async () => {
												const ref = { provider: item.provider, id: item.id };
												if (item.custom) await props.onRemoveCatalog(ref);
												else setSettings(await props.onRemoveImage(ref));
											});
									}}
								>
									<Trash2 size={15} />
								</button>
							</div>
						</div>
					);
				})}
			</div>
			<details
				className="media-add-image-service"
				open={addImageOpen}
				onToggle={(event) => setAddImageOpen(event.currentTarget.open)}
			>
				<summary>手动添加生图服务</summary>
				{addImageOpen && (
					<ModelForm
						kind="image"
						connected={props.connected && loaded}
						onDiscover={props.onDiscover}
						onRemove={props.onRemove}
						onSave={async (config) => {
							let values = await props.onSave(config);
							if (
								imageSettings?.provider &&
								values.some((value) =>
									value.availableModels?.some(
										(item) => item.provider === imageSettings.provider && item.id === imageSettings.model
									)
								)
							)
								values = await props.onSetDefaultImage({ provider: imageSettings.provider, id: imageSettings.model });
							setSettings(values);
							setAddImageOpen(false);
							return values;
						}}
					/>
				)}
			</details>
			{(() => {
				const items = videoSettings?.availableModels ?? [];
				return (
					<div className="media-imported-models">
						<div className="saved-models-heading">
							<strong>已添加视频模型</strong>
							<span>{items.length}</span>
						</div>
						{items.map((item) => {
							const active = videoSettings?.provider === item.provider && videoSettings.model === item.id;
							const original = catalog.find(
								(candidate) => candidate.model.provider === item.provider && candidate.model.id === item.id
							);
							return (
								<div className="custom-model-row" key={`${item.provider}/${item.id}`} data-provider={item.provider}>
									<span className="custom-model-copy">
										<strong>{item.name}</strong>
										<small>{item.id}</small>
										<small>{item.baseUrl}</small>
									</span>
									<div className="custom-model-row-actions">
										{original && (
											<select
												className="model-kind-select"
												aria-label={`模型类型：${item.id}`}
												value="video"
												disabled={catalogBusy || !props.connected}
												onChange={(event) => {
													const nextKind = event.target.value as "chat" | "image" | "video";
													const { model, thinkingLevels: _levels, ...config } = original;
													void catalogAction(() =>
														props.onConfigureCatalog([
															{ ...config, provider: model.provider, id: model.id, kind: nextKind },
														])
													);
												}}
											>
												<option value="chat">对话</option>
												<option value="image">生图</option>
												<option value="video">视频</option>
											</select>
										)}
										<button
											type="button"
											className="icon-button"
											title="视频模型配置"
											aria-label={`配置视频模型：${item.id}`}
											aria-expanded={videoToEdit?.provider === item.provider && videoToEdit.id === item.id}
											disabled={catalogBusy || !props.connected || !loaded}
											onClick={() =>
												setEditingVideo(
													videoToEdit?.provider === item.provider && videoToEdit.id === item.id
														? undefined
														: { provider: item.provider, id: item.id }
												)
											}
										>
											<Pencil size={15} />
										</button>
										<button
											type="button"
											className="icon-button"
											title={active ? "当前默认模型" : "设为默认模型"}
											aria-label={`启用默认模型：${item.id}`}
											aria-pressed={active}
											disabled={catalogBusy || !props.connected || active}
											onClick={() =>
												void catalogAction(async () =>
													setSettings(await props.onSetDefaultVideo({ provider: item.provider, id: item.id }))
												)
											}
										>
											<Star size={15} fill={active ? "currentColor" : "none"} />
										</button>
										<button
											type="button"
											className="icon-button"
											title="移除已添加模型"
											aria-label={`移除模型：${item.id}`}
											disabled={catalogBusy || !props.connected}
											onClick={() => {
												if (window.confirm(`移除已添加的模型 ${item.name}？`))
													void catalogAction(async () => {
														const ref = { provider: item.provider, id: item.id };
														if (item.custom) await props.onRemoveCatalog(ref);
														else setSettings(await props.onRemoveVideo(ref));
													});
											}}
										>
											<Trash2 size={15} />
										</button>
									</div>
								</div>
							);
						})}
					</div>
				);
			})()}
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
			{videoToEdit && (
				<ModelForm
					key={`${videoToEdit.provider}/${videoToEdit.id}`}
					kind="video"
					managed={videoToEdit.custom}
					saved={{
						kind: "video",
						provider: videoToEdit.provider,
						baseUrl: videoToEdit.baseUrl,
						model: videoToEdit.id,
						authenticated: true,
						...(videoToEdit.videoProtocol ? { videoProtocol: videoToEdit.videoProtocol } : {}),
						...(videoToEdit.videoReferenceFormat ? { videoReferenceFormat: videoToEdit.videoReferenceFormat } : {}),
					}}
					connected={props.connected && loaded}
					onSave={saveVideo}
					onDiscover={props.onDiscover}
					onRemove={async () => {
						const ref = { provider: videoToEdit.provider, id: videoToEdit.id };
						if (videoToEdit.custom) await props.onRemoveCatalog(ref);
						else await props.onRemoveVideo(ref);
						const values = await props.onList();
						setSettings(values);
						setEditingVideo(undefined);
						return values;
					}}
				/>
			)}
			<details
				className="media-add-image-service"
				open={addVideoOpen}
				onToggle={(event) => setAddVideoOpen(event.currentTarget.open)}
			>
				<summary>手动添加视频服务</summary>
				{addVideoOpen && (
					<ModelForm
						kind="video"
						connected={props.connected && loaded}
						onDiscover={props.onDiscover}
						onRemove={props.onRemove}
						onSave={async (config) => {
							const values = await saveVideo(config);
							setAddVideoOpen(false);
							return values;
						}}
					/>
				)}
			</details>
		</section>
	);
}
