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
generate_video({ prompt, size?, seconds? })
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

## Video Jobs and Display

The official `agnes-video-v2.0` model at `https://apihub.agnes-ai.com/v1`
(or the bare origin) automatically uses the Agnes adapter. Other models, custom
path prefixes, and third-party hosts continue to use the OpenAI transport.
Agnes creation sends JSON to `POST <base>/videos` and requires `video_id` in
the response; it does not guess that a legacy `id` is a video ID. Retrieval uses
`GET /agnesapi?video_id=...&model_name=agnes-video-v2.0` on the configured
origin, then downloads the completed `metadata.url` through the same public-DNS
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
No failed or interrupted submission automatically switches protocols or retries.

The OpenAI video adapter uses multipart `POST <base>/videos`,
`GET <base>/videos/<id>`, and `GET <base>/videos/<id>/content`.
Creation returns a locally scoped job ID persisted in `media-jobs.db`.
Retrieval waits up to 60 seconds before returning pending; subsequent retrievals
do not submit new jobs. Jobs are bound to the session and original connection.
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
