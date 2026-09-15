import { join } from "node:path";
import { verifyRuntimeFiles } from "./lib/runtime-inventory.mjs";

export default async function verifyDesktopPackage(context) {
	const count = await verifyRuntimeFiles(join(context.appOutDir, "resources", "runtime"));
	console.log(`Packaged runtime inventory passed: ${count} files`);
}
