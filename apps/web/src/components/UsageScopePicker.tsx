import { useEffect, useId, useRef, useState } from "react";
import { Check, ChevronDown, Folder, Layers } from "lucide-react";
import "./usage-scope-picker.css";

type ScopeOption = { value: string; label: string };

export function UsageScopePicker({
	value,
	options,
	label,
	onChange,
}: {
	value: string;
	options: ScopeOption[];
	label: string;
	onChange: (value: string) => void;
}) {
	const id = useId();
	const root = useRef<HTMLDivElement>(null);
	const [open, setOpen] = useState(false);
	const [active, setActive] = useState(0);
	const selectedIndex = Math.max(
		0,
		options.findIndex((option) => option.value === value)
	);
	const selected = options[selectedIndex];
	const Icon = value ? Folder : Layers;
	const show = () => {
		setActive(selectedIndex);
		setOpen(true);
	};
	const choose = (option: ScopeOption) => {
		onChange(option.value);
		setOpen(false);
	};

	useEffect(() => {
		if (!open) return;
		const dismiss = (event: PointerEvent) => {
			if (!root.current?.contains(event.target as Node)) setOpen(false);
		};
		document.addEventListener("pointerdown", dismiss);
		return () => document.removeEventListener("pointerdown", dismiss);
	}, [open]);

	useEffect(() => {
		if (open) root.current?.querySelector(`#${CSS.escape(id)}-option-${active}`)?.scrollIntoView({ block: "nearest" });
	}, [active, open, id]);

	return (
		<div
			className="usage-scope-picker"
			ref={root}
			onBlur={(event) => {
				if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
			}}
		>
			<button
				type="button"
				id="usage-workspace-scope"
				className="usage-scope-trigger"
				role="combobox"
				aria-label={label}
				aria-haspopup="listbox"
				aria-expanded={open}
				aria-controls={open ? `${id}-list` : undefined}
				aria-activedescendant={open ? `${id}-option-${active}` : undefined}
				title={selected?.label}
				onClick={() => (open ? setOpen(false) : show())}
				onKeyDown={(event) => {
					if (event.key === "Escape" && open) {
						event.preventDefault();
						event.stopPropagation();
						setOpen(false);
					} else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
						event.preventDefault();
						if (!open) show();
						else
							setActive((index) =>
								event.key === "Home"
									? 0
									: event.key === "End"
										? options.length - 1
										: Math.max(0, Math.min(options.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))
							);
					} else if ((event.key === "Enter" || event.key === " ") && open) {
						event.preventDefault();
						if (options[active]) choose(options[active]);
					} else if (event.key === "Tab") setOpen(false);
				}}
			>
				<Icon size={15} aria-hidden="true" />
				<span>{selected?.label}</span>
				<ChevronDown size={14} className="usage-scope-chevron" aria-hidden="true" />
			</button>
			{open && (
				<div className="usage-scope-menu" id={`${id}-list`} role="listbox" aria-label={label}>
					{options.map((option, index) => {
						const OptionIcon = option.value ? Folder : Layers;
						return (
							<div
								key={option.value}
								id={`${id}-option-${index}`}
								role="option"
								aria-selected={value === option.value}
								className={`usage-scope-option${active === index ? " is-active" : ""}${!option.value ? " is-all" : ""}`}
								title={option.label}
								onPointerMove={() => setActive(index)}
								onMouseDown={(event) => event.preventDefault()}
								onClick={() => choose(option)}
							>
								<OptionIcon size={15} aria-hidden="true" />
								<span>{option.label}</span>
								{value === option.value && <Check size={14} aria-hidden="true" />}
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
}
