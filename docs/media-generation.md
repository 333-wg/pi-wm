# Image and Video Generation

Settings > Models provides independent default image and video connections.
Each accepts a Base URL, API key, and an exact provider model ID. Media models
are not added to the conversational model picker. A saved key is never returned
to the browser; leaving the key field empty preserves it only when the endpoint
has not changed. Configuration is AES-256-GCM encrypted in `media-models.enc`
using the existing host model-encryption key. Settings RPCs require owner access.
Like conversational model configuration, defaults belong to the local host,
not to separate accounts on a shared multi-tenant server.

Image settings accept up to 50 selected model IDs on the same connection, with
one default. Discovery uses checkboxes and a star selects the default; manual
default-ID entry remains available. Unchecking the default selects the first
remaining model. Saving requires at least one selection and a selected default.
Existing single-image settings load as a one-model selection. Video settings
remain single-model, preserving existing video-job connection fingerprints.

## Compatible Image Services

Each media settings form can fetch candidates with `GET <base>/models` before
saving. Discovery accepts draft credentials or reuses that kind's saved key only
when the Base URL is unchanged; it never saves the draft or generates media.
Declared output modalities and generation tasks take priority over model-ID
family matching. Image/video input support alone does not qualify. Unknown
models are omitted, and manual model-ID entry remains available. A filtered
candidate is not proof of compatibility with the selected generation protocol.
Agnes image/video model IDs are recognized even when the catalog omits output
metadata. Explicit output/task declarations still override name matching.

Both the official endpoint (`https://api.openai.com/v1`) and third-party relays
implementing the OpenAI Images API are supported. Set the relay's actual Base
URL and model ID; the app does not assume a fixed model name. A bare origin gets
`/v1`; an explicit path such as `/api/v1` is preserved. HTTPS is required except
for loopback HTTP, which supports locally running compatible services.

- Generation: `POST <base>/images/generations`, JSON `model`, `prompt`, `n: 1`.
- Optional `size` and `quality` are sent only when requested by the skill.
- Results may contain `data[0].b64_json` or `data[0].url`.
- Reference-image edits use multipart `POST <base>/images/edits` with `image`.
- Remote result downloads never include the model API key. Public-DNS pinning,
  redirect checks, byte limits, and artifact signature validation apply.
- PNG, JPEG, WebP and GIF can be displayed. SVG/HTML are not rendered as media.

OpenAI-compatible does not mean every provider's private API is supported.
Responses-style image tools, Gemini native APIs, provider-specific job formats,
and relays returning a nonstandard response need separate adapters. Result URLs
must be publicly downloadable; private-network or credentialed CDN URLs are
not fetched with the provider's key.

Media settings offer discovery, save, and remove, with no separate connection
check. They never call `GET <base>/models/<model>` or submit a paid generation
request. Successful discovery or saving does not verify generation permissions,
billing, or supported parameters; those are exercised by actual chat generation.

## Skill Contract

Skills use these host tools instead of embedding credentials or provider scripts:

```text
media_model_status({})
generate_image({ prompt, model?, size?, quality?, referenceArtifactId? })
generate_video({ prompt, size?, seconds?, aspectRatio?, referenceArtifactId?, referenceImageUrl? })
get_generated_video({ jobId })
```

The user configures models once in Wuming, not once per installed skill. The AI
adapts image/video invocation steps from a local third-party skill to the host
tools, keeping the skill's prompt construction, creative style, composition,
storyboard, and supported generation parameters. The user does not need to edit
the skill, provide its preferred vendor's API key, or configure a second SDK.

A required host policy and secret-free default readiness are injected on every
turn. Both explicit skill selection and successful `skill_load` calls add the
same integration guidance around the original content, including reference
loads. Installed source files and source attestations remain unchanged. The
integration supersedes media-provider setup instructions only; it must not alter
unrelated services, task intent, skill invocation permissions, or creative
requirements. Disabled and manual-only invocation rules still apply.

The host selects the currently saved default on each generation call. Only when
explicitly requested by the user may `generate_image.model` select another saved
image model; unknown IDs are rejected before authorization or network use. The
status tool lists the default and allowed image IDs without connection secrets.
Multi-selection never fans out or automatically retries other models. There is
no tool argument for overriding an endpoint or key. `media_model_status`
can recheck current readiness without a network request, charge, approval, or
secret disclosure. A missing skill-specific environment variable does not mean
the host model is missing. If a host default is genuinely absent, the AI directs
the user only to Wuming Settings > Models. If a required feature is unsupported,
it explains that incompatibility instead of requesting duplicate credentials.

This is AI workflow adaptation, not transparent network interception of
arbitrary scripts. Provider invocation scripts are replaced by host tool calls;
ordinary authorized preparation and postprocessing remain possible. Running a
third-party script outside Wuming is not covered by this configuration contract.

Generation requires a writable session and follows its approval policy for
network and secret use. There are no automatic billable POST retries. Fees
charged by media providers are not included in conversational token accounting.

## Image Result Recovery

URL image results are persisted in `media_image_jobs` before downloading. A failed
download/save returns `retrieval_pending` and a session-scoped `jobId`, not a claim
that the provider failed to generate an image. Use `get_generated_image` to retry
only retrieval; omitting the ID retrieves the latest result in that session.
Recovery works across host restarts and does not require the original provider
credentials. Identical generation requests with a pending result reuse that
result instead of issuing another billable POST. Completed jobs reuse their
attachment and clear the saved signed URL. Old failures from before this feature
cannot be recovered unless their original result URL was retained elsewhere.

Media downloads remain subject to public-IP validation, DNS pinning, redirect
checks and size/time limits. When an HTTP destination resolves only to public
or synthetic proxy addresses (198.18.0.0/15), the media downloader resolves A and
AAAA records through authenticated Cloudflare DNS-over-HTTPS, validates every
returned address, then pins the public addresses for the original request.
Only the hostname is sent to the DNS resolver, never prompts, signed URL paths
or API credentials. Private/mixed-private answers, invalid TLS, and failed DNS
recovery remain blocked. Ordinary web fetches do not opt in to this fallback.
No protocol rewriting or disabling of proxy software/security checks is needed.

Generation results may still be unavailable if the provider deletes a file or
its signed URL expires. Recovery never silently submits a replacement image;
after one unsuccessful recovery, explain the retrieval problem and wait for
user direction.

## Video Adapters and References

Video settings default to automatic protocol selection. The registry in
`apps/gateway/src/media-video.ts` owns capabilities, validation, serialization,
remote task IDs, polling paths and result normalization. Extend that registry
for a documented provider contract, rather than branching in tool execution.

- Official Agnes v2.0 uses the legacy adapter. Official Agnes 2.5 and 2.5 Flash
  automatically use the new `agnes-v2.5` adapter.
- Other endpoints retain OpenAI Videos-compatible transport. Known Sora models
  receive their duration and size limits; unrelated models do not inherit them.
  Unknown native Agnes models fail before submission.
- Settings can override transport once per service: OpenAI multipart, OpenAI
  JSON, Agnes v2.0 or Agnes 2.5. A relay's model name does not prove its protocol.
  Custom native APIs still need dedicated adapters. This is not universal
  compatibility with arbitrary vendor APIs. Detection never creates paid jobs.

The status tool and host policy expose the actual video model and secret-free
`videoCapabilities`: protocol, validation confidence, durations, resolutions,
aspect ratios and reference transports. A successful status lookup is only
diagnostic, not proof of successful generation.

Agnes 2.5 sends JSON with `mode`, resolution tier `size`, `aspect_ratio` and
string `seconds` (4-12). Flash supports only 720P; standard 2.5 also supports
1080P, 1K and 2K. Prefer `aspectRatio` and omit size for default 720P. Legacy
pixel-size arguments are aspect-ratio hints for this tier-based API:
1024x1024 maps to 720P/1:1, not exact 1024-pixel output. Normalized parameters
are returned with the job. Unsupported explicit tiers or durations are rejected,
not silently downgraded or shortened.

Use one reference input, never both:

- `referenceArtifactId`: an existing workspace image. The backend validates
  workspace access, byte limits and PNG/JPEG/WebP type. It uploads multipart
  `input_reference`, or Base64-encodes it as JSON `input_reference.image_url`.
  Base64 stays out of model context, tool arguments, results and job metadata.
- `referenceImageUrl`: an existing public HTTPS image URL. Agnes 2.5 submits
  `images: [url]` with `mode: reference`; compatible JSON uses
  `input_reference.image_url`. Refer to `<Picture 1>` in Agnes prompts.

OpenAI's image-reference contract explicitly accepts Base64 Data URLs. Agnes
2.5 documentation requires publicly reachable image URLs and does not document
Base64 acceptance. A real completed generation on 2026-09-14 nevertheless
verified `images: ["data:image/png;base64,..."]` on the official
`agnes-video-2.5-flash` endpoint. The adapter now automatically Base64-encodes
workspace references for that exact model/host and reports verified capability.
No settings change or public image hosting is needed. Standard 2.5 and relays
do not inherit this verification; their documented default remains public URL.
The service-level **Force Base64 Data URL** override is available for other
connections with independently established support and is marked compatibility
mode, not verified support. Its preference is saved once, not per skill.
Rejections never fall back to text-only video, public hosting or another POST.

The live test requested 4 seconds, 720P, 1:1 with one synthetic reference image.
One submission completed and produced a decodable, visibly moving MP4 retaining
the reference appearance. The actual file was 960x960 and 4.458333 seconds, so
resolution tiers and requested durations are not treated as exact file metadata.
The result used top-level `url`, not the documented `metadata.url`; both response
forms are supported. See `agnes-video-reference-verification-2026-09-14.json`.
The test never submitted a raw-Base64 fallback because the first format succeeded.

Sources checked for these contracts:

- `https://agnes-ai.com/en/docs/agnes-video-25.md`
- `https://agnes-ai.com/en/docs/agnes-video-25-flash.md`
- `https://github.com/openai/openai-node/blob/master/src/resources/videos.ts`

Errors preserve bounded diagnostic fields with credentials, signed URLs,
inline media and bearer tokens redacted. Raw provider bodies are not persisted.
A failed video submission blocks further submissions in the same turn even
after a changed prompt or successful settings lookup. A fresh user-directed
turn can retry; preflight errors before submission can be corrected directly.

## Video Jobs and Display

The official `agnes-video-v2.0` model at `https://apihub.agnes-ai.com/v1`
(or the bare origin) automatically uses the legacy Agnes adapter. Agnes 2.5 and
Flash use the newer adapter above; relays default to OpenAI transport.
Agnes creation sends JSON to `POST <base>/videos` and requires `video_id` in
the response; it does not guess that a legacy `id` is a video ID. Retrieval uses
`GET /agnesapi?video_id=...&model_name=agnes-video-v2.0` on the configured
origin, then downloads the completed `metadata.url` or top-level `url` through the same public-DNS
pinning and byte-limited downloader used for image results, without the API key.
The adapter follows the official video reference and Python example:

- `https://agnes-ai.com/doc/agnes-video-v20`
- `https://github.com/AgnesAI-Labs/AgnesAI-Models/blob/main/examples/python/video_generation.py`

Agnes defaults to 1152x768, 24 fps and 121 frames (about five seconds). An
explicit `size` maps to width/height. Integer durations of 1-18 seconds map to
`seconds * 24 + 1` frames, satisfying the documented 8n+1 rule and 441-frame
limit; longer requests are rejected before authorization or submission, never
silently shortened. This adapter currently covers text-to-video only.
Each job persists its submission protocol. Existing job databases migrate with
the OpenAI default, preserving old polling paths and connection fingerprints.
Changing a protocol or reference-format preference does not alter the polling
protocol or connection identity of an already submitted job.
No failed or interrupted submission automatically switches protocols or retries.

The OpenAI video adapter uses multipart `POST <base>/videos`,
`GET <base>/videos/<id>`, and `GET <base>/videos/<id>/content`.
Creation returns a locally scoped job ID persisted in `media-jobs.db`.
Retrieval waits up to 60 seconds before returning pending; subsequent retrievals
do not submit new jobs. Jobs are bound to the session and original connection.
New jobs wait 30 seconds before the first status query, then 45 seconds and up to
60 seconds between pending responses. Schedules and query leases are persisted:
repeated/concurrent tool calls and gateway restarts cannot reset the wait.
Retrieval HTTP 429 and transient server/network errors remain pending instead of
triggering the generic repeated-tool-failure guard. Backoff starts at 60 seconds,
doubles up to 300 seconds, and honors a longer Retry-After (seconds or HTTP date).
HTTP 429 also cools down other jobs on the same saved connection. Pending output
includes the next query time; waiting remains cancellable and never resubmits.
Completed MP4/WebM files become authenticated, persistent artifacts. Retrieval
survives a gateway restart and reuses an already stored artifact.

Cancellation stops local requests/waiting, not a remote provider's job or charges.
An interrupted submission without an acknowledged job ID must not be silently
repeated. Restoring the original model settings is required to retrieve pending
jobs after changing the video connection.

Images and videos render directly below tool activity, outside collapsed tool
details. Images open at full size; videos provide native playback controls.
Both are downloadable and remain available after reloading the conversation.
Object URLs are created from authenticated downloads and revoked on unmount.
Other tools and skills returning standard media artifact references get the
same display behavior.

`WUMING_MAX_VIDEO_ARTIFACT_BYTES` defaults to 100 MiB. Image generation uses the
existing artifact limit (10 MiB by default). Video downloads are buffered within
the limit before playback; resumable byte-range streaming is not implemented.

## Verification

```sh
npx vitest run apps/gateway/test/media-generation.test.ts apps/gateway/test/server.test.ts
npx vitest run apps/gateway/test/media-skill-policy.test.ts apps/gateway/test/skill-tools.test.ts
npx playwright test e2e/media-generation.spec.ts
```

These tests use local fixtures, not paid APIs. They cover official/relay URL
construction, both image response formats, default selection, encryption,
authorization, reference-image edits, persistent video jobs, validated media,
inline playback, settings persistence, reload, and desktop/mobile bounds.
Local skill fixtures intentionally request another provider's API key and script:
both automatic loading and manual selection are verified through the real
Gateway/SDK/tool/attachment pipeline using the host defaults without writing
skill configuration. The scripted test provider verifies routing context and
transport; it does not prove that every remote language model obeys instructions.
