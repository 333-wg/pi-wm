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
- Supported text and source files must have an allowed text MIME type or source
  extension and must decode as UTF-8 without NUL bytes.
- Reads re-hash stored bytes so object corruption is detected before delivery.

Defaults are 10 MiB per image, 2 MiB per text file, 40 million image pixels,
and 10 MiB at the HTTP request boundary. They can be changed with
`WUMING_MAX_IMAGE_BYTES`, `WUMING_MAX_TEXT_ARTIFACT_BYTES`,
`WUMING_MAX_IMAGE_PIXELS`, and `WUMING_MAX_ARTIFACT_BYTES`.

Image validation intentionally establishes a narrow ingestion boundary; it is
not a malware scanner or a full media decoder. Deployments accepting untrusted
public uploads should add isolated decode/re-encode and malware scanning before
making artifacts available to other consumers.

## Model input

The Pi adapter converts validated image artifacts to Pi image content. Validated
text/source artifacts are embedded in the model prompt with a filename header.
The browser only sends immutable references, never server filesystem paths.

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
