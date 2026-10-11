# Artifacts

Wuming stores user attachments as immutable, workspace-scoped artifacts. The
gateway authenticates every upload and download with the same bearer token used
for the WebSocket connection. An artifact reference submitted in a prompt is
resolved again on the server and must belong to the session workspace; client
supplied names, MIME types, hashes, and sizes are never trusted.

## 文件与文件夹附件

桌面端可点击输入框的附件按钮选择文件，也可直接将一个或多个文件拖入对话框；上传不会移动或删除原文件。不再提供独立文件夹按钮。本机文件夹可直接拖入，作为**只读目录引用**（支持与普通文件混合），不压缩成 ZIP、遍历全目录或上传内部文件，空目录也可引用。普通浏览器无法取得拖入目录的真实路径，可改用桌面端或上传目录中的文件。

目录不再打包，因此不涉及 ZIP 大小限制。本机（`local_device`）普通文件/用户自行制作的 ZIP 上传默认不设应用层字节上限；可通过 `WUMING_MAX_FILE_ATTACHMENT_BYTES` 设置正整数上限，`0` 表示不设字节上限（仅本机模式允许）。远程部署默认沿用 `WUMING_MAX_ARTIFACT_BYTES`，手机上传仍最多 10 MiB。图片、视频及直接嵌入文本的独立限制不变。普通文件上传仍占用内存，实际容量受浏览器、Node.js 和电脑可用资源限制，不保证任意大小。

目录引用没有原先的 2000 个条目、32 层打包限制，每条消息仍最多 8 个附件。聊天中保存一个小型 `目录名.directory.json` 引用清单，模型通过 `directory_read` 工具按需列目录、glob、grep、读取文本；读取结果反映磁盘当前内容，并有单次搜索/输出上限，截断时需要缩小查询。搜索沿用 `.gitignore` 和 `.git/node_modules` 排除规则；直接读取已知路径仍可读取隐藏文件，请勿引用敏感目录。

引用授权持久化在本机数据目录的 `directory-attachments` 中，按工作区隔离。注册接口要求本机回环、桌面鉴权和工作区权限，拒绝手机及服务器部署。上传伪造 JSON 不会创建目录授权。文件读取沿用路径校验，拒绝 `..`、绝对路径及指向目录外的符号链接。引用不授予写入或 Shell 权限，不切换当前项目；要修改项目仍使用「打开项目」。移除输入框中的附件不会撤销已发送历史中的引用；本机目录被删除、移动或权限改变后读取会失败，需要重新附加。引用与路径不能移到另一台电脑直接使用。

历史 ZIP 附件保持可下载，不自动转换成目录引用。使用新功能时需重新附加原目录。引用路径和实际读取的内容可能进入所配置模型的上下文，不代表数据永不离开电脑。

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
  container termination, dimensions, byte limits, and pixel limits before storage.
  Local file selection and drag-and-drop send the browser's file bytes, never a
  local filesystem path. The browser MIME type is a hint: recognized images use
  their detected MIME even when the extension or supplied type is wrong or absent.
  JPEG segments and scans are walked to find the actual end marker; trailing
  export data is allowed, but truncated images and markers inside metadata are not.
  Original filenames and bytes are preserved for download.
- Text and source files are detected by content rather than an extension
  whitelist. They must decode as UTF-8 without NUL bytes, so uncommon source
  extensions and extensionless configuration files work normally.
- Other binary files are accepted and stored with a normalized MIME type.
  DOCX and text-based PDF attachments are extracted server-side before being
  added to the Pi prompt. Unknown binary formats remain attached with metadata
  instead of failing the turn.
- Reads re-hash stored bytes so object corruption is detected before delivery.

Remote file and image defaults are 10 MiB (local file/ZIP uploads have no default byte cap), 2 MiB per directly embedded text file, 40 million
image pixels, and 200,000 extracted document characters. They can be changed
with `WUMING_MAX_TEXT_ARTIFACT_BYTES`, `WUMING_MAX_IMAGE_PIXELS`,
`WUMING_MAX_EXTRACTED_TEXT_CHARS`, and `WUMING_MAX_ARTIFACT_BYTES`.

Image validation intentionally establishes a narrow ingestion boundary; it is
not a malware scanner or a full media decoder. Deployments accepting untrusted
public uploads should add isolated decode/re-encode and malware scanning before
making artifacts available to other consumers.

## Model input

Custom-model image input is automatic: explicit provider input declarations take
precedence over the bundled model catalog. Unknown aliases are allowed to attempt
image input rather than silently dropping it. Legacy text-only checkbox values
do not disable a model's native vision capability. A known text-only model is
rejected before the provider request, with a visible conversation notice; the
uploaded artifact remains available for retry with a vision model.

The Pi adapter converts validated image artifacts to Pi image content. Text and
extracted document content are embedded in the model prompt with a filename
header. Other binary files contribute attachment metadata rather than causing a
prompt failure. The browser only sends immutable references, never server
filesystem paths.

Image messages also include an attachment metadata record linking the image index
to its artifact ID and original filename. Reference-image generation passes that
ID to the image-edit tool, which resolves the original bytes within the workspace.
Chat images use bounded thumbnails; the full-size viewer and downloads use the
original image, not a resized replacement.

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

`browser_screenshot` returns PNG image content directly to the active model turn
and also stores the same validated bytes as an authenticated artifact when the
artifact store is available. `WUMING_BROWSER_MAX_SCREENSHOT_BYTES` is clamped to
the global artifact byte limit. If artifact persistence fails, the current tool
result still carries the image and reports the persistence error in its details.
The Web transcript loads supported image artifacts through the authenticated
artifact endpoint and renders them inline in the tool card while retaining the
download control; object URLs are revoked when the card unmounts.
