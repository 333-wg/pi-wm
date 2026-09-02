# Workspace Inspection

Wuming exposes authenticated, read-only workspace inspection over HTTP. The
browser never receives an absolute server path. Every request is authorized
against the principal's workspace list and resolved under the configured
workspace realpath.

## API

All endpoints require `Authorization: Bearer <token>`.

```text
GET /api/workspaces/:workspaceId/tree?path=.
GET /api/workspaces/:workspaceId/file?path=src/index.ts
GET /api/workspaces/:workspaceId/git/status
GET /api/workspaces/:workspaceId/git/diff?path=src/index.ts&staged=false
```

Directory reads are lazy and bounded. `.git`, `.wuming-data`, `node_modules`,
and symbolic links/junctions are excluded from traversal. File previews are
bounded UTF-8 reads; binary content is identified but not sent as text.

Git status uses porcelain v1 with NUL-delimited paths, so spaces and rename
records are parsed without line-based ambiguity. Diff commands use fixed
arguments with external diff and textconv disabled, terminal prompts disabled,
optional locks disabled, bounded output, and a timeout. User paths are passed
only after `--`. Untracked UTF-8 files receive a generated unified diff.

Limits are configured with `WUMING_MAX_DIRECTORY_ENTRIES`,
`WUMING_MAX_FILE_PREVIEW_BYTES`, `WUMING_MAX_GIT_OUTPUT_BYTES`, and
`WUMING_GIT_TIMEOUT_MS`.
