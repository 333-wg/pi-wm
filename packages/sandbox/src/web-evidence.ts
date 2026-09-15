import type { WebEvidence } from "@wuming/protocol";
import { load } from "cheerio";

/** Reports what was retrieved, never whether the page or its claims are true. */
export function pageEvidence(text: string, status = 200, minimumCharacters = 60): WebEvidence {
	if ([401, 403, 429].includes(status))
		return {
			level: "access_blocked",
			note: "HTTP " + status + "; respect the access restriction. No page evidence was obtained.",
		};
	if (status >= 400)
		return {
			level: "insufficient_content",
			note: "HTTP " + status + "; this error page does not establish that the requested information is absent.",
		};
	const normalized = text.replace(/\s+/g, " ").trim();
	if (normalized.length < minimumCharacters || /^(loading|please wait|加载中|正在加载)[.\s…]*$/i.test(normalized)) {
		return {
			level: "insufficient_content",
			note: "Little readable content is available. This may be a loading shell, navigation/footer, or a short page, not proof that results do not exist. Inspect the page and use a bounded wait_for snapshot when appropriate.",
		};
	}
	return {
		level: "page_content",
		note: "Page text was retrieved. Relevance, dates and claims still require inspection; this is not video playback or transcript verification.",
	};
}

export function htmlEvidence(html: string, status: number): WebEvidence {
	const dom = load(html);
	dom("script, style, noscript, nav, header, footer, [hidden], [aria-hidden=true]").remove();
	const main = dom("main, article, [role=main]").first();
	return pageEvidence((main.length ? main : dom("body")).text(), status);
}

export function searchEvidence(count: number): WebEvidence {
	return count > 0
		? {
				level: "candidate_links",
				note: "Candidate links and snippets only. Check relevance and open selected pages before claiming their contents were read.",
			}
		: {
				level: "insufficient_content",
				note: "This tool returned no candidate links. It may be blocked, still loading or unable to parse the page; this is not proof that matching content does not exist.",
			};
}
