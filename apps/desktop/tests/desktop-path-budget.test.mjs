import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyDesktopPathBudget, MAX_DESKTOP_RELATIVE_PATH } from "../../../scripts/lib/desktop-path-budget.mjs";

test("packaged paths leave room for installation roots and reject traversal", () => {
	const path = "resources/" + "a".repeat(MAX_DESKTOP_RELATIVE_PATH - 10);
	assert.equal(verifyDesktopPathBudget([path]).maxRelativeLength, MAX_DESKTOP_RELATIVE_PATH);
	assert.throws(() => verifyDesktopPathBudget([path + "b"]), /exceeds/);
	for (const invalid of ["../file", "C:/file", "/file", "a//file", "a/./file", "a\\..\\file"])
		assert.throws(() => verifyDesktopPathBudget([invalid]), /Invalid/);
	assert.equal(verifyDesktopPathBudget(["resources\\file.js"]).longestPath, "resources/file.js");
});
