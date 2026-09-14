import { ArrowLeft, Bot, Check, ChevronDown, ChevronRight, Info } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import type { ModelMetadata, ModelRef, ThinkingLevel } from "@wuming/protocol";
import { THINKING_LEVELS } from "../lib/thinking-preference.js";

interface ThinkingOption {
	id: ThinkingLevel;
	label: string;
	description: string;
	strength: number;
}

const OPTIONS: ThinkingOption[] = [
	{ id: "off", label: "关闭", description: "不额外推理，直接作答，最快也最省", strength: 0 },
	{ id: "minimal", label: "极简", description: "只留一点推理余量，适合改一行字这类小活", strength: 1 },
	{ id: "low", label: "低", description: "轻量推理，适合明确的小改动", strength: 2 },
	{ id: "medium", label: "中", description: "默认档，多数任务在这里最划算", strength: 3 },
	{ id: "high", label: "高", description: "更长的推理，适合排查问题与方案设计", strength: 4 },
	{ id: "xhigh", label: "极高", description: "接近上限的推理预算，明显更慢更贵", strength: 5 },
	{ id: "max", label: "最大", description: "用满模型的推理上限，留给真正难的题", strength: 6 },
];

const BY_ID = new Map(OPTIONS.map((option) => [option.id, option]));

export function thinkingLabel(level: ThinkingLevel): string {
	return BY_ID.get(level)?.label ?? level;
}

export function thinkingOptions(): readonly ThinkingOption[] {
	return THINKING_LEVELS.map((level) => BY_ID.get(level)).filter(
		(option): option is ThinkingOption => option !== undefined
	);
}

export function modelThinkingDescription(model: ModelMetadata): string {
	if (!model.authenticated) return "模型未认证，暂不可用";
	const mode = model.thinking?.mode;
	if (mode === "unknown") return "思考能力未识别";
	if (!model.reasoning) return "该模型不支持思考强度";
	const description =
		mode === "budget"
			? "支持思考预算"
			: mode === "adaptive"
				? "支持自适应思考强度"
				: mode === "toggle"
					? "支持推理，不分强度档位"
					: "支持 Effort 思考强度";
	return model.thinking?.source === "catalog" ? description + " · 接口待确认" : description;
}

export function ThinkingPicker({
	level,
	supported,
	supportedLevels,
	disabled,
	models,
	selectedModel,
	modelSelectionDisabled,
	onSelectModel,
	onChange,
}: {
	level: ThinkingLevel;
	supported: boolean;
	supportedLevels: readonly ThinkingLevel[];
	disabled: boolean;
	models: readonly ModelMetadata[];
	selectedModel: ModelMetadata | undefined;
	modelSelectionDisabled: boolean;
	onSelectModel: (model: ModelRef) => void;
	onChange: (level: ThinkingLevel) => Promise<void>;
}) {
	const [open, setOpen] = useState(false);
	const [showEffortMenu, setShowEffortMenu] = useState(false);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string>();
	const root = useRef<HTMLDivElement>(null);
	const effortMenu = useRef<HTMLDivElement>(null);
	const [effortPosition, setEffortPosition] = useState<CSSProperties>({});
	const toggleOnly = selectedModel?.thinking?.mode === "toggle";
	const options = thinkingOptions()
		.filter((option) => supportedLevels === undefined || supportedLevels.includes(option.id))
		.map((option) =>
			toggleOnly && option.id !== "off" ? { ...option, label: "开启", description: "启用模型推理" } : option
		);
	const selected = options.find((option) => option.id === level) ?? BY_ID.get(level) ?? OPTIONS[0]!;
	const valueLabel = selectedModel?.thinking?.mode === "unknown" ? "未识别" : selected.label;
	const controlLabel = selectedModel?.thinking?.mode === "budget" ? "思考预算" : toggleOnly ? "推理" : "Effort";
	const locked = modelSelectionDisabled || models.length === 0;
	const effortLocked = disabled || !supported;

	useEffect(() => {
		if (!open) {
			setShowEffortMenu(false);
			return;
		}
		const closeOutside = (event: PointerEvent) => {
			if (!root.current?.contains(event.target as Node)) {
				setOpen(false);
				setShowEffortMenu(false);
			}
		};
		const closeWithEscape = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				if (showEffortMenu) {
					setShowEffortMenu(false);
				} else {
					setOpen(false);
				}
			}
		};
		document.addEventListener("pointerdown", closeOutside);
		document.addEventListener("keydown", closeWithEscape);
		return () => {
			document.removeEventListener("pointerdown", closeOutside);
			document.removeEventListener("keydown", closeWithEscape);
		};
	}, [open, showEffortMenu]);

	useEffect(() => {
		if (locked) {
			setOpen(false);
			setShowEffortMenu(false);
		}
	}, [locked]);

	useEffect(() => {
		setShowEffortMenu(false);
		setError(undefined);
	}, [selectedModel?.model.provider, selectedModel?.model.id, supported]);

	useLayoutEffect(() => {
		if (!showEffortMenu) return;
		const place = () => {
			const anchor = root.current?.querySelector(".thinking-menu")?.getBoundingClientRect();
			const menu = effortMenu.current;
			if (!anchor || !menu) return;
			const margin = 12;
			const width = Math.min(470, window.innerWidth - margin * 2);
			const height = Math.min(menu.scrollHeight + 2, window.innerHeight - margin * 2);
			const preferredLeft =
				anchor.right + width + margin <= window.innerWidth ? anchor.right + 8 : anchor.left - width - 8;
			setEffortPosition({
				position: "fixed",
				width,
				left: Math.max(margin, Math.min(preferredLeft, window.innerWidth - width - margin)),
				top: Math.max(margin, Math.min(anchor.top, window.innerHeight - height - margin)),
				right: "auto",
				transform: "none",
				marginTop: 0,
				maxHeight: window.innerHeight - margin * 2,
				overflowY: "auto",
			});
		};
		place();
		window.addEventListener("resize", place);
		return () => window.removeEventListener("resize", place);
	}, [showEffortMenu, options.length]);

	const select = async (option: ThinkingOption) => {
		if (saving || effortLocked) return;
		if (option.id === level) {
			setOpen(false);
			setShowEffortMenu(false);
			return;
		}
		setSaving(true);
		setError(undefined);
		try {
			await onChange(option.id);
			setOpen(false);
			setShowEffortMenu(false);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setSaving(false);
		}
	};

	const modelLabel = selectedModel?.name ?? "选择模型";
	const hint = locked
		? "请先在设置中添加可用模型"
		: effortLocked
			? supported
				? "会话空闲时可更改思考强度"
				: selectedModel
					? modelThinkingDescription(selectedModel)
					: "思考能力未识别"
			: selected.description;

	return (
		<div className={`thinking-picker level-${selected.id}`} ref={root}>
			<button
				className="thinking-trigger"
				type="button"
				disabled={locked || saving}
				aria-label={`模型：${modelLabel}，思考强度：${valueLabel}`}
				aria-haspopup="menu"
				aria-expanded={open}
				aria-busy={saving}
				title={hint}
				onClick={() => {
					setError(undefined);
					setOpen((current) => !current);
				}}
			>
				<Bot size={14} />
				<span className="thinking-trigger-label">{modelLabel}</span>
				<span className="thinking-trigger-effort">{valueLabel}</span>
				<ChevronDown className="thinking-trigger-icon" size={14} />
			</button>
			{open && (
				<div className="thinking-menu-wrapper">
					<div className="thinking-menu" role="menu" aria-label="模型设置">
						<div className="thinking-model-options">
							{models.map((model) => (
								<button
									className="thinking-model-option"
									type="button"
									role="menuitemradio"
									aria-checked={
										model.model.provider === selectedModel?.model.provider && model.model.id === selectedModel?.model.id
									}
									disabled={modelSelectionDisabled || !model.authenticated}
									key={`${model.model.provider}/${model.model.id}`}
									onClick={() => onSelectModel(model.model)}
								>
									<span className="thinking-model-option-copy">
										<span className="thinking-model-option-name">
											<Bot size={15} />
											<strong>{model.name}</strong>
										</span>
										<span className="thinking-model-option-desc">{modelThinkingDescription(model)}</span>
									</span>
									{model.model.provider === selectedModel?.model.provider &&
										model.model.id === selectedModel?.model.id && <Check className="thinking-check" size={20} />}
								</button>
							))}
							{models.length === 0 && <div className="thinking-menu-empty">请在设置中添加模型</div>}
						</div>
						<div className="thinking-menu-divider" />
						<button
							className="thinking-menu-item"
							type="button"
							disabled={effortLocked || saving}
							onMouseEnter={() => {
								if (!effortLocked) setShowEffortMenu(true);
							}}
							onClick={() => {
								if (!effortLocked) setShowEffortMenu(true);
							}}
						>
							<span className="thinking-menu-item-label">{controlLabel}</span>
							<span className="thinking-menu-item-value">
								{valueLabel}
								<ChevronRight size={16} />
							</span>
						</button>
					</div>
					{showEffortMenu && (
						<div
							className="thinking-effort-menu"
							role="menu"
							aria-label="思考强度"
							ref={effortMenu}
							style={effortPosition}
						>
							<button
								className="icon-button"
								type="button"
								aria-label="返回模型设置"
								title="返回模型设置"
								onClick={() => setShowEffortMenu(false)}
							>
								<ArrowLeft size={16} />
							</button>
							{!toggleOnly && (
								<div className="thinking-menu-intro">更高的思考强度意味着更全面的回答，但会更慢并更快消耗额度。</div>
							)}
							<div className="thinking-options">
								{options.map((option) => (
									<button
										className="thinking-option"
										type="button"
										role="menuitemradio"
										aria-checked={option.id === level}
										disabled={saving}
										key={option.id}
										onClick={() => void select(option)}
									>
										<span className="thinking-option-content">
											<span className="thinking-option-header">
												<strong>{option.label}</strong>
												{option.id === "medium" && <span className="thinking-badge">默认</span>}
												{option.id === "max" && <Info size={14} className="thinking-info" />}
											</span>
											<span className="thinking-option-desc">{option.description}</span>
										</span>
										{option.id === level && <Check className="thinking-check" size={20} />}
									</button>
								))}
							</div>
							{error && (
								<div className="thinking-error" role="alert">
									{error}
								</div>
							)}
						</div>
					)}
				</div>
			)}
		</div>
	);
}
