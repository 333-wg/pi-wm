import { describe, expect, it } from "vitest";
import { htmlEvidence, pageEvidence, searchEvidence } from "../src/web-evidence.js";

describe("web evidence classification", () => {
	it("does not mistake boilerplate or loading shells for readable content", () => {
		expect(
			htmlEvidence("<body><nav>" + "Navigation ".repeat(30) + "</nav><footer>About Privacy</footer></body>", 200).level
		).toBe("insufficient_content");
		expect(pageEvidence("Loading...").level).toBe("insufficient_content");
		expect(htmlEvidence("<main>" + "Actual article content. ".repeat(10) + "</main>", 200).level).toBe("page_content");
		expect(pageEvidence("42", 200, 1).level).toBe("page_content");
	});
	it("keeps access errors and missing evidence distinct from absence", () => {
		for (const status of [401, 403, 429]) expect(pageEvidence("", status).level).toBe("access_blocked");
		expect(pageEvidence("Not found", 404).level).toBe("insufficient_content");
		expect(searchEvidence(0).level).toBe("insufficient_content");
		expect(searchEvidence(3).level).toBe("candidate_links");
	});
});
