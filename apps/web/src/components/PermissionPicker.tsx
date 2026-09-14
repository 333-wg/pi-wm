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

const OPTIONS: PermissionOption[] = [
	{
		id: "ask",
		label: "请求批准",
		description: "每次使用工具前都请求你的批准",
		sandboxMode: "workspace_write",
		approvalPolicy: "always",
		icon: <Hand size={18} />,
	},
	{
		id: "agent",
		label: "帮我批准",
		description: "仅对检测到的风险操作请求批准",
		sandboxMode: "workspace_write",
		approvalPolicy: "on_risk",
		icon: <ShieldCheck size={18} />,
	},
	{
		id: "full",
		label: "完全访问权限",
		description: "放宽沙箱限制并自动批准工具调用",
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

function optionFor(value: PermissionValue): PermissionOption {
	return OPTIONS.find((option) => option.id === permissionMode(value)) ?? OPTIONS[1]!;
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
	const [open, setOpen] = useState(false);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string>();
	const root = useRef<HTMLDivElement>(null);
	const selected = optionFor(value);

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
				aria-label={`权限模式：${selected.label}`}
				aria-haspopup="menu"
				aria-expanded={open}
				aria-busy={saving}
				title={disabled ? "会话空闲时可更改权限" : selected.description}
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
				<div className="permission-menu" role="menu" aria-label="工具权限模式">
					<div className="permission-menu-heading">
						<span>应如何批准 Wuming 操作？</span>
						<span>所有项目和对话</span>
					</div>
					<div className="permission-options">
						{OPTIONS.map((option) => (
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
