# Workspace Inspection

Wuming exposes authenticated workspace inspection over HTTP, plus explicit Git
write actions in local-device mode. The
browser never receives an absolute server path. Every request is authorized
against the principal's workspace list and resolved under the configured
workspace realpath.

## Git Workflow

The Changes view supports repository initialization, staging/unstaging the
current file or all changes in the active scope, committing staged changes,
remote address management, fetch, push, and fast-forward-only pull.
Creating or configuring a remote never uploads files automatically. Commits
remain local until the user confirms a push to the displayed remote and branch.

Create an empty remote repository on GitHub, Gitee, GitLab, or a compatible
Git host first, then add its HTTPS or SSH clone URL in remote settings.
Hosting-platform account login and repository creation APIs are not included.
Authentication uses the gateway computer's existing Git credential helper or
SSH agent/key configuration. URL-embedded passwords/tokens are rejected; the
browser has no password storage. Interactive authentication prompts are disabled.
Configure author identity in the repository before committing:

```sh
git config user.name "Your name"
git config user.email "you@example.com"
```

The action body is a strict discriminated union in GitActionSchema:

```json
{"type":"stage","paths":["src/index.ts"]}
{"type":"unstage","paths":["src/index.ts"]}
{"type":"commit","message":"Describe the change"}
{"type":"remote.save","name":"origin","url":"https://github.com/owner/repo.git"}
{"type":"push","remote":"origin","branch":"main"}
```

The init, remote.remove, fetch, and pull actions are also supported. All write
requests require workspace membership and workspace.write, pass origin and
bearer checks, and are unavailable in server mode. Opening only a subdirectory
of a repository remains read-only to avoid committing other workspace content.
Git hooks and credential helpers run on the local device as with terminal Git;
only operate on trusted local repositories.

Mutations are serialized per repository within the gateway process. Paths are
validated against current status and passed as literal NUL-delimited pathspecs
on stdin. Unstaging never deletes working files, including before the first
commit. Commands run without a shell, have bounded output, and time out after
30 seconds locally or 120 seconds for network operations. A timed-out command
may have partially completed; refresh repository state before retrying.

Push uses an explicit local-to-remote branch refspec and establishes upstream
tracking; it does not force, mirror, or implicitly push tags/submodules. Separate
push addresses are shown in the confirmation dialog. Multiple push addresses
are rejected. Pull refuses dirty worktrees and divergent history instead of
automatically stashing, rebasing, or merging. Resolve conflicts in the terminal,
then stage and commit the resolved files. Ahead/behind counts describe the
configured upstream using the most recently fetched refs, not live server state.

## API

All endpoints require `Authorization: Bearer <token>`.

```text
GET /api/workspaces/:workspaceId/tree?path=.
GET /api/workspaces/:workspaceId/file?path=src/index.ts
GET /api/workspaces/:workspaceId/git/status
GET /api/workspaces/:workspaceId/git/diff?path=src/index.ts&staged=false
GET /api/workspaces/:workspaceId/git/details
POST /api/workspaces/:workspaceId/git/action
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
