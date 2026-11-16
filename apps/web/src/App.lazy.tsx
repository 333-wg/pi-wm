import { lazy } from "react";

// Local Suspense boundaries keep the conversation visible while a panel loads.
export const TerminalWorkbench = lazy(() =>
	import("./terminal-view.js").then((module) => ({ default: module.TerminalWorkbench }))
);
export const EvaluationDialog = lazy(() =>
	import("./components/EvaluationDialog.js").then((module) => ({ default: module.EvaluationDialog }))
);
export const ShortcutsDialog = lazy(() =>
	import("./components/ShortcutsDialog.js").then((module) => ({ default: module.ShortcutsDialog }))
);
export const SkillManagerDialog = lazy(() =>
	import("./components/SkillManagerDialog.js").then((module) => ({ default: module.SkillManagerDialog }))
);
export const CommandPalette = lazy(() =>
	import("./components/CommandPalette.js").then((module) => ({ default: module.CommandPalette }))
);
export const PhoneAccessSettings = lazy(() =>
	import("./components/PhoneAccessSettings.js").then((module) => ({ default: module.PhoneAccessSettings }))
);
export const AgentTemplateSettings = lazy(() =>
	import("./components/AgentTemplateSettings.js").then((module) => ({ default: module.AgentTemplateSettings }))
);
export const MediaModelSettings = lazy(() =>
	import("./components/MediaModelSettings.js").then((module) => ({ default: module.MediaModelSettings }))
);
export const OfficialAccountSettings = lazy(() =>
	import("./components/OfficialAccountSettings.js").then((module) => ({ default: module.OfficialAccountSettings }))
);
