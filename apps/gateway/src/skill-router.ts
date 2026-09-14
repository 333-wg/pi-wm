import type { SkillSummary } from "@wuming/protocol";

export interface SkillRoutingOptions {
	maxSkills?: number;
	minScore?: number;
}

export interface SkillRoute {
	readonly skill: SkillSummary;
	readonly score: number;
	readonly reasons: readonly string[];
}

const STOP_WORDS = new Set(
	"the a an and or for to of in on with from this that task please help need make create fix implement review latest current use build run".split(
		" "
	)
);

function tokens(value: string): string[] {
	return (
		value
			.toLowerCase()
			.match(/[a-z0-9\u4e00-\u9fff]+/g)
			?.filter((token) => token.length > 1 && !STOP_WORDS.has(token)) ?? []
	);
}

/** Selects skills only when the task has evidence for them; explicit skills stay authoritative. */
export function routeSkills(
	query: string,
	skills: readonly SkillSummary[],
	options: SkillRoutingOptions = {}
): SkillRoute[] {
	const queryTokens = new Set(tokens(query));
	const maxSkills = options.maxSkills ?? 3;
	const minScore = options.minScore ?? 2;
	return skills
		.filter((skill) => skill.allowImplicitInvocation !== false)
		.map((skill) => {
			const terms = new Set(tokens(`${skill.id} ${skill.name} ${skill.description}`));
			const matches = [...queryTokens].filter((token) => terms.has(token));
			const score = matches.length + (query.toLowerCase().includes(skill.id.toLowerCase()) ? 2 : 0);
			return { skill, score, reasons: matches.map((match) => `匹配关键词：${match}`) };
		})
		.filter((route) => route.score >= minScore)
		.sort((a, b) => b.score - a.score || a.skill.id.localeCompare(b.skill.id))
		.slice(0, maxSkills);
}

export type RecoveryAction = "retry_same" | "change_strategy" | "ask_user";

export function recoveryAction(attempt: number, retryable: boolean, hasFallback: boolean): RecoveryAction {
	if (!retryable) return "ask_user";
	if (attempt <= 1) return "retry_same";
	if (hasFallback) return "change_strategy";
	return "ask_user";
}
