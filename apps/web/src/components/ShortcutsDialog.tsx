import { X } from "lucide-react";
import { modifierLabel } from "./CommandPalette.js";

interface ShortcutRow {
	keys: readonly string[];
	label: string;
}

/** `$mod` renders as `⌘` on Apple keyboards and `Ctrl` everywhere else. */
const sections: readonly { title: string; rows: readonly ShortcutRow[] }[] = [
	{
		title: "外壳",
		rows: [
			{ keys: ["$mod", "K"], label: "打开命令面板" },
			{ keys: ["$mod", "B"], label: "展开或收起侧边栏" },
			{ keys: ["$mod", "Shift", "B"], label: "显示或隐藏运行面板" },
			{ keys: ["$mod", "/"], label: "查看快捷键" },
			{ keys: ["Esc"], label: "关闭浮层，或停止当前任务" },
		],
	},
	{
		title: "输入框",
		rows: [
			{ keys: ["Enter"], label: "发送" },
			{ keys: ["Shift", "Enter"], label: "换行" },
			{ keys: ["@"], label: "引用工作区文件" },
			{ keys: ["/"], label: "调用快捷命令" },
			{ keys: ["↑", "↓"], label: "在候选中移动" },
			{ keys: ["Tab"], label: "接受候选" },
		],
	},
];

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
	const modifier = modifierLabel();
	return (
		<div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
			<div className="shortcuts-dialog" role="dialog" aria-modal="true" aria-labelledby="shortcuts-title" onMouseDown={(event) => event.stopPropagation()}>
				<div className="dialog-header">
					<h2 id="shortcuts-title">快捷键</h2>
					<button className="icon-button" type="button" title="关闭" onClick={onClose}><X size={18} /></button>
				</div>
				{sections.map((section) => (
					<section className="shortcut-section" key={section.title}>
						<h3>{section.title}</h3>
						<dl>
							{section.rows.map((row) => (
								<div className="shortcut-row" key={row.label}>
									<dt>{row.keys.map((key, index) => <kbd key={`${key}-${index}`}>{key === "$mod" ? modifier : key}</kbd>)}</dt>
									<dd>{row.label}</dd>
								</div>
							))}
						</dl>
					</section>
				))}
			</div>
		</div>
	);
}
