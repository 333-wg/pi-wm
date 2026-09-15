import { readFile, writeFile, mkdir, open, rm } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "@playwright/test";
import { MediaModelRegistry, readMediaBody } from "../apps/gateway/dist/media-models.js";
import { mediaErrorDetail } from "../apps/gateway/dist/media-errors.js";
import { SafeWebClient } from "@wuming/sandbox";
import { validateArtifact } from "@wuming/artifacts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, "test-results", "agnes-reference-2026-09-14");
const reportPath = join(output, "report.json");
const command = process.argv[2];
if (!["prepare", "submit-data-url", "submit-raw", "poll", "inspect"].includes(command))
	throw new Error(
		"Use prepare, submit-data-url, submit-raw, poll or inspect. Submission commands are explicit and limited to two total."
	);
await mkdir(output, { recursive: true });
const dataDir = process.env.WUMING_DATA_DIR || join(process.env.LOCALAPPDATA, "Wuming");
const models = new MediaModelRegistry({
	filePath: join(dataDir, "media-models.enc"),
	encryptionKey:
		process.env.WUMING_MODEL_CONFIG_KEY || (await readFile(join(dataDir, "custom-models.key"), "utf8")).trim(),
});
await models.load();
const config = models.resolve("video");
if (config.baseUrl.replace(/\/+$/, "") !== "https://apihub.agnes-ai.com/v1" || config.model !== "agnes-video-2.5-flash")
	throw new Error(
		"Saved video configuration is not the authorized official Agnes 2.5 Flash connection. Nothing submitted."
	);
let report;
try {
	report = JSON.parse(await readFile(reportPath, "utf8"));
} catch (error) {
	if (error.code !== "ENOENT") throw error;
}
const save = async () => writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
const safe = (payload) => mediaErrorDetail(payload, config);
const publicAttempt = (attempt) => ({
	format: attempt.format,
	state: attempt.state,
	httpStatus: attempt.httpStatus,
	videoId: attempt.videoId,
	error: attempt.error,
	updatedAt: attempt.updatedAt,
});

async function prepare() {
	if (report) {
		console.log(JSON.stringify({ reportPath, attempts: report.attempts.map(publicAttempt) }));
		return;
	}
	const browser = await chromium.launch({ headless: true });
	try {
		const page = await browser.newPage({ viewport: { width: 720, height: 720 } });
		await page.setContent('<html><body style="margin:0"><canvas width="720" height="720"></canvas></body></html>');
		await page.evaluate(() => {
			const ctx = document.querySelector("canvas").getContext("2d");
			ctx.fillStyle = "#eef1f2";
			ctx.fillRect(0, 0, 720, 720);
			ctx.fillStyle = "#c7cdd0";
			ctx.beginPath();
			ctx.ellipse(371, 582, 190, 27, 0, 0, Math.PI * 2);
			ctx.fill();
			ctx.fillStyle = "#229b9d";
			ctx.fillRect(201, 210, 300, 355);
			ctx.fillStyle = "#166e77";
			ctx.beginPath();
			ctx.moveTo(501, 210);
			ctx.lineTo(560, 169);
			ctx.lineTo(560, 517);
			ctx.lineTo(501, 565);
			ctx.closePath();
			ctx.fill();
			ctx.fillStyle = "#76cccb";
			ctx.beginPath();
			ctx.moveTo(201, 210);
			ctx.lineTo(260, 169);
			ctx.lineTo(560, 169);
			ctx.lineTo(501, 210);
			ctx.closePath();
			ctx.fill();
			ctx.save();
			ctx.beginPath();
			ctx.rect(201, 210, 300, 355);
			ctx.clip();
			ctx.strokeStyle = "#df5460";
			ctx.lineWidth = 64;
			ctx.beginPath();
			ctx.moveTo(176, 492);
			ctx.lineTo(531, 290);
			ctx.stroke();
			ctx.restore();
			ctx.fillStyle = "#f7c541";
			ctx.beginPath();
			ctx.arc(417, 464, 38, 0, Math.PI * 2);
			ctx.fill();
		});
		const image = await page.screenshot({ type: "png", path: join(output, "reference.png") });
		report = {
			createdAt: new Date().toISOString(),
			provider: "Agnes",
			model: config.model,
			test: "Synthetic reference image, 4 seconds, 720P, 1:1",
			referenceSha256: createHash("sha256").update(image).digest("hex"),
			referenceBytes: image.length,
			attempts: [],
		};
		await save();
		console.log(
			JSON.stringify({
				reportPath,
				reference: join(output, "reference.png"),
				model: report.model,
				referenceBytes: image.length,
			})
		);
	} finally {
		await browser.close();
	}
}

async function submit(format) {
	if (!report) throw new Error("Run prepare first");
	if (report.attempts.length >= 2 || report.attempts.some((attempt) => attempt.format === format))
		throw new Error("Submission limit reached; no request sent");
	if (format === "data-url" && report.attempts.length !== 0) throw new Error("Data URL must be the first attempt");
	if (
		format === "raw-base64" &&
		(report.attempts.length !== 1 || !["rejected", "failed"].includes(report.attempts[0].state))
	)
		throw new Error("Raw Base64 is allowed only after a confirmed rejection or terminal failure of the first attempt");
	const image = await readFile(join(output, "reference.png"));
	if (createHash("sha256").update(image).digest("hex") !== report.referenceSha256)
		throw new Error("Reference image changed; no request sent");
	const attempt = { format, state: "submitting", submittedAt: new Date().toISOString() };
	report.attempts.push(attempt);
	// Persist before POST. A timeout or crash must never cause a duplicate submission.
	await save();
	const base64 = image.toString("base64");
	try {
		const response = await fetch(config.baseUrl + "/videos", {
			method: "POST",
			redirect: "error",
			signal: AbortSignal.timeout(120_000),
			headers: { Authorization: "Bearer " + config.apiKey, "Content-Type": "application/json" },
			body: JSON.stringify({
				model: config.model,
				prompt:
					"Use <Picture 1> as the exact product reference. Slowly rotate the turquoise rectangular package clockwise on the light gray background. Preserve its coral diagonal stripe and the small yellow circle on the front. Gentle studio light, smooth motion, no added objects, no text.",
				mode: "reference",
				seconds: "4",
				size: "720P",
				aspect_ratio: "1:1",
				images: [format === "data-url" ? "data:image/png;base64," + base64 : base64],
			}),
		});
		attempt.httpStatus = response.status;
		const text = (await readMediaBody(response, 64 * 1024)).toString("utf8");
		let payload;
		try {
			payload = JSON.parse(text);
		} catch {
			payload = text;
		}
		attempt.error = safe(payload);
		if (!response.ok) attempt.state = [400, 401, 403, 404, 422].includes(response.status) ? "rejected" : "unknown";
		else if (typeof payload.video_id === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(payload.video_id)) {
			attempt.videoId = payload.video_id;
			attempt.state = "accepted";
		} else attempt.state = "unknown";
	} catch {
		attempt.state = "unknown";
		attempt.error = "Submission interrupted or unreadable. Do not resubmit; provider acceptance is unknown.";
	}
	attempt.updatedAt = new Date().toISOString();
	await save();
	console.log(JSON.stringify(publicAttempt(attempt)));
}

async function download(payload, attempt) {
	const url = payload.metadata?.url ?? payload.url;
	if (typeof url !== "string" || !url)
		throw new Error("Completed task has no metadata.url; no new task will be submitted");
	const content = await new SafeWebClient({ timeoutMs: 120_000 }).download(url, { maxBytes: 100 * 1024 * 1024 });
	const artifact = validateArtifact({ name: "reference-test.mp4", content }, { maxVideoBytes: 100 * 1024 * 1024 });
	const path = join(output, attempt.format + ".mp4");
	await writeFile(path, content);
	attempt.download = {
		path,
		bytes: content.length,
		sha256: createHash("sha256").update(content).digest("hex"),
		mimeType: artifact.mimeType,
	};
	if (attempt.downloadError) {
		attempt.recoveredDownloadError = attempt.downloadError;
		delete attempt.downloadError;
	}
	await save();
	console.log(JSON.stringify({ state: "downloaded", path, bytes: content.length }));
}

async function poll() {
	const attempt = report?.attempts.at(-1);
	if (!attempt?.videoId) throw new Error("No acknowledged video ID to poll; do not resubmit");
	if (["failed", "rejected"].includes(attempt.state)) {
		console.log(JSON.stringify(publicAttempt(attempt)));
		return;
	}
	const endpoint = new URL("/agnesapi", config.baseUrl);
	endpoint.searchParams.set("video_id", attempt.videoId);
	endpoint.searchParams.set("model_name", config.model);
	const deadline = Date.now() + 5 * 60_000;
	let previous = "";
	while (Date.now() < deadline) {
		try {
			const response = await fetch(endpoint, {
				redirect: "error",
				headers: { Authorization: "Bearer " + config.apiKey },
				signal: AbortSignal.timeout(30_000),
			});
			const text = (await readMediaBody(response, 64 * 1024)).toString("utf8");
			let payload;
			try {
				payload = JSON.parse(text);
			} catch {
				payload = { message: "Polling response was not JSON" };
			}
			if (!response.ok) {
				attempt.pollError = { status: response.status, detail: safe(payload) };
				await save();
				console.log(JSON.stringify({ state: "poll_error", ...attempt.pollError }));
				if (![429, 500, 502, 503, 504].includes(response.status)) return;
			} else {
				const status = String(payload.status).toLowerCase();
				attempt.updatedAt = new Date().toISOString();
				attempt.providerStatus = status;
				if (["failed", "error", "cancelled", "canceled"].includes(status)) {
					attempt.state = "failed";
					attempt.error = safe(payload);
					await save();
					console.log(JSON.stringify(publicAttempt(attempt)));
					return;
				}
				if (["completed", "success", "succeeded", "done"].includes(status)) {
					attempt.state = "completed";
					await save();
					console.log(JSON.stringify(publicAttempt(attempt)));
					if (!attempt.download) {
						try {
							await download(payload, attempt);
						} catch (error) {
							attempt.downloadError = safe(error instanceof Error ? error.message : String(error));
							attempt.resultShape = {
								fields: Object.keys(payload),
								metadataType: typeof payload.metadata,
								metadataFields:
									payload.metadata && typeof payload.metadata === "object" ? Object.keys(payload.metadata) : [],
							};
							await save();
							console.log(
								JSON.stringify({
									state: "download_failed",
									error: attempt.downloadError,
									resultShape: attempt.resultShape,
								})
							);
						}
					}
					return;
				}
				await save();
				if (status !== previous) {
					console.log(
						JSON.stringify({
							state: "pending",
							providerStatus: status,
							progress: typeof payload.progress === "number" ? payload.progress : undefined,
						})
					);
					previous = status;
				}
			}
		} catch {
			console.log(JSON.stringify({ state: "poll_interrupted", note: "Only the same video ID will be queried again." }));
		}
		await delay(5000);
	}
	console.log(
		JSON.stringify({
			state: "still_pending",
			videoId: attempt.videoId,
			note: "Run poll again for this same job; never resubmit.",
		})
	);
}

async function inspect() {
	const attempt = report?.attempts.at(-1);
	if (!attempt?.download) throw new Error("No downloaded video to inspect");
	const content = await readFile(attempt.download.path);
	const browser = await chromium.launch({ headless: true });
	try {
		const page = await browser.newPage({ viewport: { width: 720, height: 720 } });
		await page.setContent(
			'<html><body style="margin:0"><video muted playsinline style="width:720px;height:720px;object-fit:contain"></video></body></html>'
		);
		const metadata = await page.evaluate(async (encoded) => {
			const bytes = Uint8Array.from(atob(encoded), (value) => value.charCodeAt(0));
			const video = document.querySelector("video");
			const ready = new Promise((resolveReady, reject) => {
				video.onloadeddata = resolveReady;
				video.onerror = () => reject(new Error("Video decode failed"));
			});
			video.src = URL.createObjectURL(new Blob([bytes], { type: "video/mp4" }));
			await ready;
			return { width: video.videoWidth, height: video.videoHeight, duration: video.duration };
		}, content.toString("base64"));
		const frames = [];
		for (const [index, seconds] of [0.2, Math.min(2, metadata.duration / 2)].entries()) {
			const sample = await page.evaluate(async (time) => {
				const video = document.querySelector("video");
				const sought = new Promise((done) => {
					video.onseeked = done;
				});
				video.currentTime = time;
				await sought;
				const canvas = document.createElement("canvas");
				canvas.width = 64;
				canvas.height = 64;
				const ctx = canvas.getContext("2d");
				ctx.drawImage(video, 0, 0, 64, 64);
				return [...ctx.getImageData(0, 0, 64, 64).data];
			}, seconds);
			frames.push(sample);
			await page.screenshot({ path: join(output, attempt.format + "-frame-" + index + ".png") });
		}
		const motion =
			frames[0].reduce((sum, value, i) => sum + (i % 4 === 3 ? 0 : Math.abs(value - frames[1][i])), 0) / (64 * 64 * 3);
		attempt.inspection = { ...metadata, meanFrameDifference: motion, decoded: true };
		await save();
		console.log(JSON.stringify(attempt.inspection));
	} finally {
		await browser.close();
	}
}

if (command === "prepare") await prepare();
if (command === "submit-data-url" || command === "submit-raw") {
	const lockPath = join(output, "submission.lock");
	const lock = await open(lockPath, "wx");
	try {
		report = JSON.parse(await readFile(reportPath, "utf8"));
		await submit(command === "submit-data-url" ? "data-url" : "raw-base64");
	} finally {
		await lock.close();
		await rm(lockPath);
	}
}
if (command === "poll") await poll();
if (command === "inspect") await inspect();
