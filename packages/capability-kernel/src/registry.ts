import { createHash } from "node:crypto";
import { HOOK_POINTS } from "./types.js";
import type {
	CapabilityJson,
	CapabilityManifest,
	CapabilityPermission,
	CapabilityPlan,
	CapabilityRegisterOptions,
	CapabilityRegistration,
	CapabilityResolutionContext,
	CapabilityResolveOptions,
} from "./types.js";

interface RegisteredCapability {
	manifest: CapabilityManifest;
	when?: NonNullable<CapabilityRegisterOptions["when"]>;
	disposed: boolean;
}

function canonicalize(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
		.join(",")}}`;
}

function cloneJson<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function deepFreeze<T>(value: T): T {
	if (value && typeof value === "object" && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
	}
	return value;
}

function assertIdentifier(value: string, label: string): void {
	if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(value)) throw new Error(`${label} is invalid: ${value}`);
}

function normalizedStrings(values: readonly string[] | undefined, label: string): string[] | undefined {
	if (!values || values.length === 0) return undefined;
	const result = [...new Set(values)];
	for (const value of result) assertIdentifier(value, label);
	return result.sort();
}

export function normalizeCapabilityManifest(input: CapabilityManifest): CapabilityManifest {
	assertIdentifier(input.id, "Capability id");
	assertIdentifier(input.provider, "Capability provider");
	if (!input.version || input.version.length > 100) throw new Error(`Capability ${input.id} has an invalid version`);
	if (
		input.priority !== undefined &&
		(!Number.isSafeInteger(input.priority) || input.priority < -10_000 || input.priority > 10_000)
	) {
		throw new Error(`Capability ${input.id} has an invalid priority`);
	}
	if (input.kind === "tool" && !input.tool) throw new Error(`Tool capability ${input.id} is missing its tool contract`);
	if (input.tool && input.kind !== "tool")
		throw new Error(`Capability ${input.id} has a tool contract but kind is ${input.kind}`);
	if (input.tool) assertIdentifier(input.tool.name, `Tool name for ${input.id}`);
	if (input.kind === "hook" && !input.hook) throw new Error(`Hook capability ${input.id} is missing its hook contract`);
	if (input.hook && input.kind !== "hook")
		throw new Error(`Capability ${input.id} has a hook contract but kind is ${input.kind}`);
	if (input.hook) {
		if (input.hook.points.length === 0) throw new Error(`Hook capability ${input.id} has no hook points`);
		if (
			new Set(input.hook.points).size !== input.hook.points.length ||
			input.hook.points.some((point) => !HOOK_POINTS.includes(point))
		) {
			throw new Error(`Hook capability ${input.id} has invalid hook points`);
		}
		if (
			input.hook.timeoutMs !== undefined &&
			(!Number.isSafeInteger(input.hook.timeoutMs) || input.hook.timeoutMs < 1 || input.hook.timeoutMs > 60_000)
		) {
			throw new Error(`Hook capability ${input.id} has an invalid timeout`);
		}
	}
	const dependencies = normalizedStrings(input.dependencies, `Dependency for ${input.id}`);
	const conflicts = normalizedStrings(input.conflicts, `Conflict for ${input.id}`);
	const { dependencies: _dependencies, conflicts: _conflicts, ...base } = cloneJson(input);
	const manifest: CapabilityManifest = {
		...base,
		...(dependencies ? { dependencies } : {}),
		...(conflicts ? { conflicts } : {}),
	};
	return deepFreeze(manifest);
}

function permissionKey(permission: CapabilityPermission): string {
	return canonicalize(permission);
}

function manifestOrder(left: CapabilityManifest, right: CapabilityManifest): number {
	return (right.priority ?? 0) - (left.priority ?? 0) || left.id.localeCompare(right.id);
}

export function verifyCapabilityPlan(plan: CapabilityPlan): boolean {
	if (plan.schemaVersion !== 1 || !/^sha256:[a-f0-9]{64}$/.test(plan.digest)) return false;
	const { digest: _digest, ...unsigned } = plan;
	return plan.digest === `sha256:${createHash("sha256").update(canonicalize(unsigned)).digest("hex")}`;
}

export class CapabilityRegistry {
	readonly #parent: CapabilityRegistry | undefined;
	readonly #registrations = new Map<string, RegisteredCapability[]>();

	constructor(parent?: CapabilityRegistry) {
		this.#parent = parent;
	}

	createScope(): CapabilityRegistry {
		return new CapabilityRegistry(this);
	}

	register(input: CapabilityManifest, options: CapabilityRegisterOptions = {}): CapabilityRegistration {
		const manifest = normalizeCapabilityManifest(input);
		const entry: RegisteredCapability = {
			manifest,
			disposed: false,
			...(options.when ? { when: options.when } : {}),
		};
		const registrations = this.#registrations.get(manifest.id) ?? [];
		registrations.push(entry);
		this.#registrations.set(manifest.id, registrations);
		return {
			id: manifest.id,
			get disposed() {
				return entry.disposed;
			},
			dispose: () => {
				if (entry.disposed) return;
				entry.disposed = true;
			},
		};
	}

	#effective(context: CapabilityResolutionContext): Map<string, CapabilityManifest> {
		const effective = this.#parent ? this.#parent.#effective(context) : new Map<string, CapabilityManifest>();
		for (const [id, registrations] of this.#registrations) {
			const entry = [...registrations]
				.reverse()
				.find((candidate) => !candidate.disposed && (!candidate.when || candidate.when(context)));
			if (entry) effective.set(id, entry.manifest);
		}
		return effective;
	}

	resolve(contextInput: CapabilityResolutionContext, options: CapabilityResolveOptions = {}): CapabilityPlan {
		const context = deepFreeze(cloneJson(contextInput));
		const available = this.#effective(context);
		const denied = new Set(options.denied ?? []);
		const requested = new Set(options.requested ?? []);
		for (const id of [...denied, ...requested]) assertIdentifier(id, "Capability selection");

		const selected = new Map<string, CapabilityManifest>();
		const visiting = new Set<string>();
		const select = (id: string, reason: "activation" | "request" | "dependency"): void => {
			if (selected.has(id)) return;
			if (denied.has(id)) throw new Error(`Capability ${id} is denied but required by ${reason}`);
			const manifest = available.get(id);
			if (!manifest) throw new Error(`Capability ${id} is not registered`);
			if (visiting.has(id)) throw new Error(`Capability dependency cycle includes ${id}`);
			visiting.add(id);
			for (const dependency of manifest.dependencies ?? []) select(dependency, "dependency");
			visiting.delete(id);
			selected.set(id, manifest);
		};

		for (const manifest of available.values()) {
			if ((manifest.activation ?? "always") === "always" && !denied.has(manifest.id)) select(manifest.id, "activation");
		}
		for (const id of requested) select(id, "request");
		for (const manifest of available.values()) {
			if (manifest.required && denied.has(manifest.id)) throw new Error(`Required capability ${manifest.id} is denied`);
		}

		const capabilities = [...selected.values()].sort(manifestOrder);
		for (const manifest of capabilities) {
			for (const conflict of manifest.conflicts ?? []) {
				if (selected.has(conflict)) throw new Error(`Capability ${manifest.id} conflicts with ${conflict}`);
			}
		}
		const tools = capabilities
			.filter((manifest) => manifest.modelVisible !== false && manifest.tool && manifest.tool.exposure === "direct")
			.map((manifest) => manifest.tool!.name);
		const promptFragments = capabilities
			.filter((manifest) => manifest.modelVisible !== false && manifest.promptFragment)
			.map((manifest) => manifest.promptFragment!);
		const permissionMap = new Map<string, CapabilityPermission>();
		for (const manifest of capabilities) {
			for (const permission of manifest.permissions ?? [])
				permissionMap.set(permissionKey(permission), cloneJson(permission));
		}
		const unsigned = {
			schemaVersion: 1 as const,
			context,
			capabilities: cloneJson(capabilities),
			modelVisible: { tools, promptFragments },
			permissions: [...permissionMap.entries()]
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([, permission]) => permission),
		};
		const digest = `sha256:${createHash("sha256").update(canonicalize(unsigned)).digest("hex")}`;
		return deepFreeze({ ...unsigned, digest });
	}
}

export function asCapabilityJson(value: unknown): CapabilityJson {
	const serialized = JSON.stringify(value);
	if (serialized === undefined) throw new Error("Capability value is not JSON serializable");
	return JSON.parse(serialized) as CapabilityJson;
}
