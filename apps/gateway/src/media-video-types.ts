import type { MediaModelSettings, VideoProtocolPreference } from "@wuming/protocol";

export type VideoProtocol = Exclude<VideoProtocolPreference, "auto">;
export type VideoConnection = Pick<MediaModelSettings, "baseUrl" | "model" | "videoProtocol" | "videoReferenceFormat">;
export interface VideoParams {
	prompt: string;
	size?: string;
	seconds?: number;
	aspectRatio?: string;
	referenceArtifactId?: string;
	referenceImageUrl?: string;
}
export interface VideoReference {
	content: Uint8Array<ArrayBuffer>;
	mimeType: string;
	name: string;
}
export interface VideoCapabilities {
	protocol: VideoProtocol;
	validation: "documented" | "verified" | "compatibility";
	generationModes?: Array<"text" | "image">;
	durations?: number[];
	seconds?: { min: number; max: number; default: number };
	sizes?: string[];
	aspectRatios?: string[];
	referenceInputs: Array<"artifact" | "public-url">;
	artifactTransport?: "multipart" | "data-url" | "base64";
	note?: string;
}
export interface VideoHttpRequest {
	resource: string | URL;
	body?: BodyInit;
	json?: boolean;
	headers?: Record<string, string>;
}
// Only non-secret routing information is persisted with a submitted job.
export interface VideoJobContext {
	mode?: "text" | "image";
}
export interface VideoRequest {
	protocol: VideoProtocol;
	body: BodyInit;
	json: boolean;
	resource?: string | URL;
	headers?: Record<string, string>;
	context?: VideoJobContext;
	parameters: Record<string, string | number>;
}
export interface VideoResult {
	status: "completed" | "pending" | "failed";
	url?: string;
	fileId?: string;
	inlineData?: { data: string; mimeType: string };
}
export interface VideoAdapter {
	protocol: VideoProtocol;
	matches: (config: VideoConnection) => boolean;
	capabilities: (config: VideoConnection) => VideoCapabilities;
	request: (config: VideoConnection, params: VideoParams, reference?: VideoReference) => VideoRequest;
	resultResource: (config: VideoConnection, id: string, context?: VideoJobContext) => string | URL;
	remoteId: (payload: Record<string, unknown>) => unknown;
	validRemoteId?: (id: string) => boolean;
	pollRequest?: (config: VideoConnection, id: string, context?: VideoJobContext) => VideoHttpRequest;
	result?: (payload: Record<string, unknown>) => VideoResult;
}
