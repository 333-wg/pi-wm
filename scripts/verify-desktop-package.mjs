import { join } from "node:path";
import { runtimeFiles, verifyRuntimeFiles } from "./lib/runtime-inventory.mjs";
import { verifyDesktopPathBudget } from "./lib/desktop-path-budget.mjs";

export default async function verifyDesktopPackage(context) {
	const platform = context.electronPlatformName;
	const resources =
		platform === "darwin"
			? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents", "Resources")
			: join(context.appOutDir, "resources");
	const count = await verifyRuntimeFiles(join(resources, "runtime"), platform);
	console.log(`Packaged runtime inventory passed: ${count} files`);
	if (platform === "win32") {
		const paths = verifyDesktopPathBudget(await runtimeFiles(context.appOutDir));
		console.log(`Packaged path budget passed: ${JSON.stringify(paths)}`);
	}
}
