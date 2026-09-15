import { access, cp, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { runtimeFiles, verifyRuntimeFiles } from "./runtime-inventory.mjs";

export function releaseEnvironment(parent) {
	const env = Object.fromEntries(
		Object.entries(parent).filter(([key]) => !/^(path|node_path|node_options|electron_run_as_node)$/i.test(key))
	);
	env.PATH = `${parent.SystemRoot}\\System32;${parent.SystemRoot}`;
	return env;
}

export async function prepareDesktopRelease(executable, repositoryRoot) {
	const source = dirname(await realpath(resolve(executable)));
	await verifyRuntimeFiles(join(source, "resources", "runtime"));
	await runtimeFiles(source);
	const temporaryRoot = await realpath(tmpdir());
	const temporary = await mkdtemp(join(temporaryRoot, "wuming-release-"));
	const dispose = async () => {
		if (dirname(temporary) !== temporaryRoot || !basename(temporary).startsWith("wuming-release-"))
			throw new Error("Unsafe release verification cleanup path");
		if ((await realpath(temporary)) !== temporary) throw new Error("Release verification directory was redirected");
		await rm(temporary, { recursive: true, force: true });
	};
	try {
		const rel = relative(await realpath(repositoryRoot), temporary);
		if (!rel.startsWith("..") && !isAbsolute(rel)) throw new Error("Release checks must run outside the repository");
		// A parent node_modules would mask missing bundled packages just as the source checkout did.
		for (let ancestor = temporary; ; ancestor = dirname(ancestor)) {
			let exists = true;
			try {
				await access(join(ancestor, "node_modules"));
			} catch (error) {
				if (error.code === "ENOENT") exists = false;
				else throw error;
			}
			if (exists) throw new Error(`Release test ancestor contains node_modules: ${ancestor}`);
			if (dirname(ancestor) === ancestor) break;
		}
		const destination = join(temporary, "Wuming app");
		await cp(source, destination, { recursive: true });
		await verifyRuntimeFiles(join(destination, "resources", "runtime"));
		console.log(`Testing relocated release outside source checkout: ${destination}`);
		return { executable: join(destination, basename(executable)), directory: destination, dispose };
	} catch (error) {
		await dispose();
		throw error;
	}
}
