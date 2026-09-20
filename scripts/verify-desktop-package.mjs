import { join } from "node:path";
import { runtimeFiles, verifyRuntimeFiles } from "./lib/runtime-inventory.mjs";
import { verifyDesktopPathBudget } from "./lib/desktop-path-budget.mjs";

export default async function verifyDesktopPackage(context) {
	const count = await verifyRuntimeFiles(join(context.appOutDir, "resources", "runtime"));
	const paths = verifyDesktopPathBudget(await runtimeFiles(context.appOutDir));
	console.log(`Packaged runtime inventory passed: ${count} files`);
	console.log(`Packaged path budget passed: ${JSON.stringify(paths)}`);
}
