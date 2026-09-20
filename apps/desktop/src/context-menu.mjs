export function externalLink(value) {
	try {
		const url = new URL(value);
		if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password) return url.href;
	} catch {
		// Only explicit web URLs may be handed to the operating system.
	}
	return undefined;
}

export function contextMenuTemplate(params, { clipboard, openExternal, onCopyError = console.error }) {
	const items = [];
	const flags = params.editFlags ?? {};
	const group = (entries) => {
		if (items.length) items.push({ type: "separator" });
		items.push(...entries);
	};
	const edit = (role, label, flag) => ({ role, label, enabled: Boolean(flags[flag]) });
	if (params.linkURL) {
		const url = externalLink(params.linkURL);
		group([
			...(url ? [{ label: "在外部浏览器打开", click: () => openExternal(url) }] : []),
			{
				label: "复制链接地址",
				click: async () => {
					try {
						await clipboard.writeText(params.linkURL);
					} catch (error) {
						onCopyError(error);
					}
				},
			},
		]);
	}
	if (params.isEditable) {
		group([edit("undo", "撤销", "canUndo"), edit("redo", "重做", "canRedo")]);
		group([
			edit("cut", "剪切", "canCut"),
			edit("copy", "复制", "canCopy"),
			edit("paste", "粘贴", "canPaste"),
			edit("pasteAndMatchStyle", "粘贴为纯文本", "canPaste"),
			edit("delete", "删除", "canDelete"),
		]);
		group([edit("selectAll", "全选", "canSelectAll")]);
	} else if (params.selectionText) {
		group([edit("copy", "复制", "canCopy")]);
	}
	return items;
}

export function installContextMenu(webContents, { window, Menu, clipboard, openExternal, onCopyError }) {
	webContents.on("context-menu", (_event, params) => {
		if (window.isDestroyed() || webContents.isDestroyed()) return;
		const template = contextMenuTemplate(params, { clipboard, openExternal, onCopyError });
		if (!template.length) return;
		// Native edit roles must target the originating preview, not the workbench.
		webContents.focus();
		Menu.buildFromTemplate(template).popup({ window, frame: params.frame, sourceType: params.menuSourceType });
	});
}
