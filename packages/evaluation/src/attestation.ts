import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EvaluationAttestation, RunEvaluation } from "@wuming/protocol";
import { trajectoryDigest } from "@wuming/trajectory";

interface AttestationPayload {
	schemaVersion: 1;
	id: string;
	evaluationId: string;
	evaluationDigest: string;
	sessionId: string;
	runId: string;
	trajectoryHeadDigest: string | null;
	issuedAt: number;
	algorithm: "ed25519";
	keyId: string;
	publicKey: string;
}

function payload(attestation: EvaluationAttestation): AttestationPayload {
	return {
		schemaVersion: attestation.schemaVersion,
		id: attestation.id,
		evaluationId: attestation.evaluationId,
		evaluationDigest: attestation.evaluationDigest,
		sessionId: attestation.sessionId,
		runId: attestation.runId,
		trajectoryHeadDigest: attestation.trajectoryHeadDigest,
		issuedAt: attestation.issuedAt,
		algorithm: attestation.algorithm,
		keyId: attestation.keyId,
		publicKey: attestation.publicKey,
	};
}

export class AttestationSigner {
	readonly #privateKey: ReturnType<typeof createPrivateKey>;
	readonly publicKey: string;
	readonly keyId: string;

	constructor(privateKeyPem: string | Buffer) {
		this.#privateKey = createPrivateKey(privateKeyPem);
		const publicDer = createPublicKey(this.#privateKey).export({ type: "spki", format: "der" });
		this.publicKey = publicDer.toString("base64");
		this.keyId = trajectoryDigest(this.publicKey);
	}

	static async open(directory: string): Promise<AttestationSigner> {
		await mkdir(directory, { recursive: true });
		const privatePath = join(directory, "attestation-ed25519-private.pem");
		let privatePem: Buffer;
		try {
			privatePem = await readFile(privatePath);
		} catch (error) {
			if (!error || typeof error !== "object" || (error as { code?: unknown }).code !== "ENOENT") throw error;
			const generated = generateKeyPairSync("ed25519");
			const candidate = Buffer.from(generated.privateKey.export({ type: "pkcs8", format: "pem" }));
			try {
				await writeFile(privatePath, candidate, { flag: "wx", mode: 0o600 });
				privatePem = candidate;
			} catch (writeError) {
				if (!writeError || typeof writeError !== "object" || (writeError as { code?: unknown }).code !== "EEXIST")
					throw writeError;
				privatePem = await readFile(privatePath);
			}
		}
		const signer = new AttestationSigner(privatePem);
		await writeFile(join(directory, "attestation-ed25519-public.txt"), `${signer.publicKey}\n`, {
			mode: 0o644,
		});
		return signer;
	}

	create(input: { id: string; evaluation: RunEvaluation; issuedAt: number }): EvaluationAttestation {
		const unsigned: AttestationPayload = {
			schemaVersion: 1,
			id: input.id,
			evaluationId: input.evaluation.id,
			evaluationDigest: input.evaluation.digest,
			sessionId: input.evaluation.sessionId,
			runId: input.evaluation.runId,
			trajectoryHeadDigest: input.evaluation.trajectoryHeadDigest,
			issuedAt: input.issuedAt,
			algorithm: "ed25519",
			keyId: this.keyId,
			publicKey: this.publicKey,
		};
		const payloadDigest = trajectoryDigest(unsigned);
		const signature = sign(null, Buffer.from(payloadDigest), this.#privateKey).toString("base64");
		return Object.freeze({ ...unsigned, payloadDigest, signature });
	}
}

export function verifyEvaluationAttestation(attestation: EvaluationAttestation): boolean {
	try {
		if (attestation.algorithm !== "ed25519") return false;
		const publicDer = Buffer.from(attestation.publicKey, "base64");
		if (trajectoryDigest(attestation.publicKey) !== attestation.keyId) return false;
		const expectedDigest = trajectoryDigest(payload(attestation));
		if (expectedDigest !== attestation.payloadDigest) return false;
		return verify(
			null,
			Buffer.from(attestation.payloadDigest),
			{ key: publicDer, type: "spki", format: "der" },
			Buffer.from(attestation.signature, "base64")
		);
	} catch {
		return false;
	}
}
