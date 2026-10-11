/** Keep remote deployments bounded; only local file uploads default to no application byte cap. */
export function fileAttachmentLimit(local: boolean, mediaLimit: number, configured?: string): number {
	if (configured === undefined || configured.trim() === "") return local ? Infinity : mediaLimit;
	const value = Number(configured);
	if (!Number.isSafeInteger(value) || value < 0)
		throw new Error("WUMING_MAX_FILE_ATTACHMENT_BYTES must be a non-negative safe integer");
	if (value === 0) {
		if (!local) throw new Error("Unlimited file attachments require local_device deployment");
		return Infinity;
	}
	return value;
}
