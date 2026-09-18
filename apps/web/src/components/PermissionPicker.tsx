import { useT, type Translate } from "../lib/locale.js";
import { Check, ChevronDown, Hand, ShieldAlert, ShieldCheck } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ApprovalPolicy, SandboxMode } from "@wuming/protocol";

export type PermissionMode = "ask" | "agent" | "full";

export interface PermissionValue {
	sandboxMode: SandboxMode;
	approvalPolicy: ApprovalPolicy;
}

interface PermissionOption extends PermissionValue {
	id: PermissionMode;
	label: string;
	description: string;
	icon: ReactNode;
}

const permissionOptions = (t: Translate): PermissionOption[] => [
	{
		id: "ask",
		label: t("permissionAsk"),
		description: t("permissionAskHint"),
		sandboxMode: "workspace_write",
		approvalPolicy: "always",
		icon: <Hand size={18} />,
	},
	{
		id: "agent",
		label: t("permissionAgent"),
		description: t("permissionAgentHint"),
		sandboxMode: "workspace_write",
		approvalPolicy: "on_risk",
		icon: <ShieldCheck size={18} />,
	},
	{
		id: "full",
		label: t("permissionFull"),
		description: t("permissionFullHint"),
		sandboxMode: "unrestricted",
		approvalPolicy: "never",
		icon: <ShieldAlert size={18} />,
	},
];

export function permissionMode(value: PermissionValue): PermissionMode {
	if (value.sandboxMode === "unrestricted" && value.approvalPolicy === "never") return "full";
	if (value.approvalPolicy === "always") return "ask";
	return "agent";
}

function optionFor(value: PermissionValue, options: PermissionOption[]): PermissionOption {
	return options.find((option) => option.id === permissionMode(value)) ?? options[1]!;
}

export function PermissionPicker({
	value,
	disabled,
	onChange,
}: {
	value: PermissionValue;
	disabled: boolean;
	onChange: (value: PermissionValue) => Promise<void>;
}) {
	const t = useT();
	const options = permissionOptions(t);
	const [open, setOpen] = useState(false);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string>();
	const root = useRef<HTMLDivElement>(null);
	const selected = optionFor(value, options);

	useEffect(() => {
		if (!open) return;
		const closeOutside = (event: PointerEvent) => {
			if (!root.current?.contains(event.target as Node)) setOpen(false);
		};
		const closeWithEscape = (event: KeyboardEvent) => {
			if (event.key === "Escape") setOpen(false);
		};
		document.addEventListener("pointerdown", closeOutside);
		document.addEventListener("keydown", closeWithEscape);
		return () => {
			document.removeEventListener("pointerdown", closeOutside);
			document.removeEventListener("keydown", closeWithEscape);
		};
	}, [open]);

	useEffect(() => {
		if (disabled) setOpen(false);
	}, [disabled]);

	const select = async (option: PermissionOption) => {
		if (saving) return;
		if (option.sandboxMode === value.sandboxMode && option.approvalPolicy === value.approvalPolicy) {
			setOpen(false);
			return;
		}
		setSaving(true);
		setError(undefined);
		try {
			await onChange({ sandboxMode: option.sandboxMode, approvalPolicy: option.approvalPolicy });
			setOpen(false);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setSaving(false);
		}
	};

	return (
		<div className={`permission-picker mode-${selected.id}`} ref={root}>
			<button
				className="permission-trigger"
				type="button"
				disabled={disabled || saving}
				aria-label={t("permissionMode", { label: selected.label })}
				aria-haspopup="menu"
				aria-expanded={open}
				aria-busy={saving}
				title={disabled ? t("permissionLocked") : selected.description}
				onClick={() => {
					setError(undefined);
					setOpen((current) => !current);
				}}
			>
				<span className="permission-trigger-icon">{selected.icon}</span>
				<span className="permission-trigger-label">{selected.label}</span>
				<ChevronDown className="permission-chevron" size={13} />
			</button>
			{open && (
				<div className="permission-menu" role="menu" aria-label={t("permissionMenu")}>
					<div className="permission-menu-heading">
						<span>{t("permissionQuestion")}</span>
						<span>{t("allProjectsChats")}</span>
					</div>
					<div className="permission-options">
						{options
							.filter((option) => option.id !== "ask")
							.map((option) => (
								<button
									className={`permission-option mode-${option.id}`}
									type="button"
									role="menuitemradio"
									aria-checked={option.id === selected.id}
									disabled={saving}
									key={option.id}
									onClick={() => void select(option)}
								>
									<span className="permission-option-icon">{option.icon}</span>
									<span className="permission-option-copy">
										<strong>{option.label}</strong>
										<span>{option.description}</span>
									</span>
									{option.id === selected.id && <Check className="permission-check" size={17} />}
								</button>
							))}
					</div>
					{error && (
						<div className="permission-error" role="alert">
							{error}
						</div>
					)}
				</div>
			)}
		</div>
	);
}
