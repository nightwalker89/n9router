---
name: 9router-video
description: Generate videos via 9Router /v1/videos/generations across xAI Grok Imagine, Google Vertex AI Veo, OpenRouter, and web-cookie providers (Grok Web gw/grok-video, Muse Web, UC Web, VeoAI Free). Handles both synchronous web-executor responses (data URL MP4) and asynchronous polling jobs (submit, poll GET /v1/videos/{id} with x-connection-id until done/completed). Use when the user wants to generate or render a video, text-to-video (txt2vid), or image-to-video.
---

# 9Router — Video Generation

Requires `NINEROUTER_URL` (and `NINEROUTER_KEY` if auth enabled). See https://raw.githubusercontent.com/decolua/9router/refs/heads/master/skills/9router/SKILL.md for setup.

## Endpoints

| Endpoint | Purpose |
|---|---|
| `POST /v1/videos/generations` | text-to-video / image-to-video (all video providers) |
| `POST /v1/videos/edits` | edit an existing video (`xai` only) |
| `POST /v1/videos/extensions` | extend an existing video (`xai` only) |
| `GET /v1/videos/{request_id}` | poll async job status (`xai`, `vertex`, `openrouter`) |

> Pass `model` with a provider prefix (for example `gw/grok-video`, `xai/grok-imagine-video`, `vertex/veo-3.1-generate-preview`, `openrouter/google/veo-3.1`). Unprefixed model IDs default to `xai`. Combos are not supported on `/v1/videos/*`.

## Two execution modes

### Mode A — Synchronous web-cookie / executor providers
Applies to `grok-web` (alias `gw`), `muse-web`, `uc-web`, and `veoaifree-web` (`noAuth`).

`POST /v1/videos/generations` runs end-to-end and returns HTTP `200` directly with a base64 `data:video/mp4;base64,...` URL (no `GET` polling step):

| Field | Required | Notes |
|---|---|---|
| `model` | yes | e.g. `gw/grok-video`, `muse-web/muse-video`, `uc-web/wan-2.6`, `veoaifree-web/veo` |
| `prompt` | yes | video description |
| `size` | no | aspect ratio, e.g. `16:9` (default on `grok-web`), `9:16`, `1:1` |
| `seconds` or `duration` | no | duration in seconds (default `6` on `grok-web`) |
| `resolution` | no | provider-dependent |
| `image` / `image_url` / `images` / `image_urls` | no | image-to-video URL or `data:` URL (supported on `muse-web`, `uc-web`) |

Example (`gw/grok-video` via `grok-web`):

```bash
curl -sS -X POST "$NINEROUTER_URL/v1/videos/generations" \
  -H "Authorization: Bearer $NINEROUTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gw/grok-video","prompt":"A serene lake at sunset","size":"16:9","duration":6}' \
  | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8")); const b64=(d.video?.url||"").split(",")[1]; if(!b64){console.error(d);process.exit(1);} require("fs").writeFileSync("out.mp4",Buffer.from(b64,"base64"));'
```

Response shape:

```json
{
  "id": "video-grok-web-1735000000",
  "object": "video.generation",
  "created": 1735000000,
  "model": "grok-video",
  "status": "completed",
  "video": { "url": "data:video/mp4;base64,..." }
}
```

---

### Mode B — Asynchronous job providers (`xai`, `vertex`, `openrouter`)
The initial `POST` returns a job ID (`request_id` / `id`) and a response header `x-9router-connection-id`. Poll `GET /v1/videos/{id}` echoing `x-connection-id: <id from create response>` (or `?provider=<id>`) until `status` is `done` / `completed` or `failed`.

Submit a job:

```bash
curl -i -X POST "$NINEROUTER_URL/v1/videos/generations" \
  -H "Authorization: Bearer $NINEROUTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"xai/grok-imagine-video","prompt":"A cinematic tracking shot through a neon city at night","duration":8,"aspect_ratio":"16:9","resolution":"720p"}'
# Header: x-9router-connection-id: <conn-id>
# Body:   {"request_id":"abc123"}  (or {"id":"..."})
```

Poll until finished:

```bash
curl "$NINEROUTER_URL/v1/videos/abc123" \
  -H "Authorization: Bearer $NINEROUTER_KEY" \
  -H "x-connection-id: <conn-id from create response>"
# xAI pending:   {"status":"pending","progress":42}
# xAI done:      {"status":"done","video":{"url":"https://…mp4","duration":8},"model":"grok-imagine-video"}
# Vertex done:   {"id":"…","request_id":"…","status":"completed","video":{"url":"gs://… or null","b64_json":"… or null","mime_type":"video/mp4"},"videos":[…]}
# Failed:        {"status":"failed","error":{"code":"…","message":"…"}}
```

## Provider parameters & quirks

| Provider | Example models | Supported endpoints | Provider-specific fields & notes |
|---|---|---|---|
| `xai` | `xai/grok-imagine-video` | `generations`, `edits`, `extensions` | `duration`, `aspect_ratio` (`16:9`, `9:16`, `1:1`, `4:3`, `3:4`, `3:2`, `2:3`), `resolution` (`480p`, `720p`, `1080p`), `image` (`{"url":"..."}`), `video` (`{"url":"..."}` or `{"file_id":"..."}`). Needs xAI API key or Grok Build OAuth with video access. |
| `vertex` | `vertex/veo-3.1-generate-preview`, `vertex/veo-3.1-fast-generate-preview`, `vertex/veo-3.0-generate-001`, `vertex/veo-2.0-generate-001` | `generations` | Service Account JSON (or OAuth + `projectId`). Accepts `duration`, `aspect_ratio`, `resolution`, `negative_prompt`, `seed`, `storage_uri` (GCS URI to avoid inline base64), `generate_audio`, `n`, `image`/`image_url`. |
| `openrouter` | `openrouter/google/veo-3.1`, `openrouter/openai/sora-2-pro`, `openrouter/bytedance/seedance-2.0` | `generations` | `duration`, `aspect_ratio`, `resolution`; OpenRouter JSON body passed through verbatim. |
| `grok-web` (`gw`) | `gw/grok-video` | `generations` (sync) | Requires `grok.com` cookies (`sso`, `sso-rw`, `cf_clearance`) via Login via Browser + `wreq-js` runtime. Daily quota is ~1 video/day per account; default rendering is 480p. |
| `muse-web` | `muse-web/muse-video` | `generations` (sync) | Cookie auth via Login via Browser; supports `image` for image-to-video. |
| `uc-web` | `uc-web/default`, `uc-web/wan-2.6`, `uc-web/sora-2`, … | `generations` (sync) | Cookie auth; supports `seconds`, `size`, `resolution`, `image`. |
| `veoaifree-web` | `veoaifree-web/veo`, `veoaifree-web/seedance` | `generations` (sync) | NoAuth executor-driven path (`noAuth`). |

## CLI one-shot (`xai`)

```bash
9router xai video \
  --prompt "A cinematic tracking shot through a neon city at night" \
  --output video.mp4
# options: --model --duration --aspect-ratio --resolution --image --timeout --port --host --api-key
```

Submits, polls with progress, downloads to `video.mp4.part`, and atomically renames on success.

## Notes & limits

- Async jobs are **account-bound** upstream: always send `x-connection-id` (from the `x-9router-connection-id` create header) on `GET /v1/videos/{id}` polls.
- Creation `POST`s are **never auto-retried** on network/5xx errors so billable upstream video jobs are not duplicated (only `401`/`403` token refresh performs a single retry before job creation).
- Video models are tagged `kind: "video"` and are excluded from `/v1/models` chat lists and fallback combos.
