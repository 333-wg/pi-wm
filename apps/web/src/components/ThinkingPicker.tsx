import { createTranslator, useT, type Translate } from "../lib/locale.js";
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

const getOptions = (t: Translate): ThinkingOption[] => [
	{ id: "off", label: t("thinkingOff"), description: t("thinkingOffHint"), strength: 0 },
	{ id: "minimal", label: t("thinkingMinimal"), description: t("thinkingMinimalHint"), strength: 1 },
	{ id: "low", label: t("thinkingLow"), description: t("thinkingLowHint"), strength: 2 },
	{ id: "medium", label: t("thinkingMedium"), description: t("thinkingMediumHint"), strength: 3 },
	{ id: "high", label: t("thinkingHigh"), description: t("thinkingHighHint"), strength: 4 },
	{ id: "xhigh", label: t("thinkingXhigh"), description: t("thinkingXhighHint"), strength: 5 },
	{ id: "max", label: t("thinkingMax"), description: t("thinkingMaxHint"), strength: 6 },
];

const byId = (t: Translate) => new Map(getOptions(t).map((option) => [option.id, option]));

export function thinkingLabel(level: ThinkingLevel, t: Translate = createTranslator("zh")): string {
	return byId(t).get(level)?.label ?? level;
}

export function thinkingOptions(t: Translate = createTranslator("zh")): readonly ThinkingOption[] {
	const options = byId(t);
	return THINKING_LEVELS.map((level) => options.get(level)).filter(
		(option): option is ThinkingOption => option !== undefined
	);
}

export function modelThinkingDescription(model: ModelMetadata, t: Translate = createTranslator("zh")): string {
	if (!model.authenticated) return t("modelUnauthenticated");
	const mode = model.thinking?.mode;
	if (mode === "unknown") return t("thinkingUnknown");
	if (!model.reasoning) return t("thinkingUnsupported");
	const description =
		mode === "budget"
			? t("thinkingBudgetSupported")
			: mode === "adaptive"
				? t("thinkingAdaptiveSupported")
				: mode === "toggle"
					? t("thinkingToggleSupported")
					: t("thinkingEffortSupported");
	const source = model.thinking?.source;
	return source === "catalog"
		? description + t("thinkingCatalogSource")
		: source === "family"
			? description + t("thinkingFamilySource")
			: source === "manual"
				? description + t("thinkingManualSource")
				: description;
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
	const t = useT();
	const [open, setOpen] = useState(false);
	const [showEffortMenu, setShowEffortMenu] = useState(false);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string>();
	const root = useRef<HTMLDivElement>(null);
	const effortMenu = useRef<HTMLDivElement>(null);
	const [effortPosition, setEffortPosition] = useState<CSSProperties>({});
	const toggleOnly = selectedModel?.thinking?.mode === "toggle";
	const options = thinkingOptions(t)
		.filter((option) => supportedLevels === undefined || supportedLevels.includes(option.id))
		.map((option) =>
			toggleOnly && option.id !== "off"
				? { ...option, label: t("thinkingOn"), description: t("thinkingEnable") }
				: option
		);
	const selected = options.find((option) => option.id === level) ?? byId(t).get(level) ?? getOptions(t)[0]!;
	const valueLabel = selectedModel?.thinking?.mode === "unknown" ? t("unrecognized") : selected.label;
	const controlLabel =
		selectedModel?.thinking?.mode === "budget" ? t("thinkingBudget") : toggleOnly ? t("thinkingReasoning") : "Effort";
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

	const modelLabel = selectedModel?.name ?? t("chooseModel");
	const hint = locked
		? t("addAvailableModel")
		: effortLocked
			? supported
				? t("thinkingLocked")
				: selectedModel
					? modelThinkingDescription(selectedModel, t)
					: t("thinkingUnknown")
			: selected.description;

	return (
		<div className={`thinking-picker level-${selected.id}`} ref={root}>
			<button
				className="thinking-trigger"
				type="button"
				disabled={locked || saving}
				aria-label={t("modelAndThinking", { model: modelLabel, effort: valueLabel })}
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
					<div className="thinking-menu" role="menu" aria-label={t("modelMenu")}>
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
										<span className="thinking-model-option-desc">{modelThinkingDescription(model, t)}</span>
									</span>
									{model.model.provider === selectedModel?.model.provider &&
										model.model.id === selectedModel?.model.id && <Check className="thinking-check" size={20} />}
								</button>
							))}
							{models.length === 0 && <div className="thinking-menu-empty">{t("addModelInSettings")}</div>}
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
							aria-label={t("thinkingEffort")}
							ref={effortMenu}
							style={effortPosition}
						>
							<button
								className="icon-button"
								type="button"
								aria-label={t("backToModelSettings")}
								title={t("backToModelSettings")}
								onClick={() => setShowEffortMenu(false)}
							>
								<ArrowLeft size={16} />
							</button>
							{!toggleOnly && <div className="thinking-menu-intro">{t("thinkingEffortHint")}</div>}
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
												{option.id === "medium" && <span className="thinking-badge">{t("default")}</span>}
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
