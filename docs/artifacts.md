# Artifacts

Wuming stores user attachments as immutable, workspace-scoped artifacts. The
gateway authenticates every upload and download with the same bearer token used
for the WebSocket connection. An artifact reference submitted in a prompt is
resolved again on the server and must belong to the session workspace; client
supplied names, MIME types, hashes, and sizes are never trusted.

## HTTP API

Upload a raw request body to:

```text
POST /api/workspaces/:workspaceId/artifacts
Authorization: Bearer <token>
Content-Type: <file MIME type>
X-Wuming-File-Name: <encodeURIComponent(filename)>
```

The response is `201 { "artifact": ArtifactRef }`. Download the immutable
content with an authenticated `GET /api/artifacts/:artifactId`. Downloads use
`Content-Disposition: attachment` and `X-Content-Type-Options: nosniff`.

## Storage and validation

- Metadata is stored in SQLite; object bytes are addressed by SHA-256 and
  deduplicated on disk.
- Names must be plain filenames. Paths, control characters, empty names, and
  names longer than 255 characters are rejected.
- Supported images are PNG, JPEG, GIF, and WebP. Wuming checks signatures,
  container termination, dimensions, MIME agreement, byte limits, and pixel
  limits before storage.
- Text and source files are detected by content rather than an extension
  whitelist. They must decode as UTF-8 without NUL bytes, so uncommon source
  extensions and extensionless configuration files work normally.
- Other binary files are accepted and stored with a normalized MIME type.
  DOCX and text-based PDF attachments are extracted server-side before being
  added to the Pi prompt. Unknown binary formats remain attached with metadata
  instead of failing the turn.
- Reads re-hash stored bytes so object corruption is detected before delivery.

Defaults are 10 MiB per file, 2 MiB per directly embedded text file, 40 million
image pixels, and 200,000 extracted document characters. They can be changed
with `WUMING_MAX_TEXT_ARTIFACT_BYTES`, `WUMING_MAX_IMAGE_PIXELS`,
`WUMING_MAX_EXTRACTED_TEXT_CHARS`, and `WUMING_MAX_ARTIFACT_BYTES`.

Image validation intentionally establishes a narrow ingestion boundary; it is
not a malware scanner or a full media decoder. Deployments accepting untrusted
public uploads should add isolated decode/re-encode and malware scanning before
making artifacts available to other consumers.

## Model input

The Pi adapter converts validated image artifacts to Pi image content. Text and
extracted document content are embedded in the model prompt with a filename
header. Other binary files contribute attachment metadata rather than causing a
prompt failure. The browser only sends immutable references, never server
filesystem paths.

## Tool output spilling

Sandbox `read_file`, `exec`, `run_python`, and `web_fetch` results keep a bounded inline preview for the model and
transcript. When that preview is truncated, Wuming stores the larger UTF-8 result
as a workspace-scoped artifact and adds its immutable reference to the tool
transcript. Bash artifacts are captured from the live output stream, so they are
not limited to the process result's shorter in-memory window.

`WUMING_MAX_TOOL_OUTPUT_CHARS` controls the inline preview and
`WUMING_MAX_TOOL_ARTIFACT_BYTES` controls the attachment capture. The latter is
clamped to `WUMING_MAX_TEXT_ARTIFACT_BYTES`. If the attachment capture also
reaches its limit, the result is explicitly marked as extended rather than full
output; Wuming never claims that omitted bytes were preserved.
