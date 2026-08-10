# lm-render

Public GitHub Actions media-render/orchestration repo for 21Media projects.

Historically this repo was only a thin free-tier runner that cloned private generator code. That description is no longer fully true: **Reaction Video Lab v4 renderer/orchestration code now lives directly in this repo** so the worker can run without cloning the private MAM application.

## Why this repo is public

GitHub-hosted Actions on public repositories can be used as the low-volume render runner without the private-repo Actions-minute cap that originally motivated this repo.

This repo must therefore contain **no application secrets**. Secrets are provided only at Actions runtime.

Forked pull requests do not receive repository secrets by default. Production workflows are triggered by controlled `schedule`, `workflow_dispatch`, or owner-controlled push paths rather than arbitrary external input.

## Reaction Video Lab

Reaction Video Lab product/UI/state lives in private repo:

`infermator/21media-mam`

This repo owns the async media worker side.

### Active flow

`MAM render request → reaction_jobs queued → GitHub Actions worker → renderer v4 → optional TTS/lip-sync → chroma composite → QC/validation → Supabase result → MAM preview`

### Important files

- `.github/workflows/reaction-render.yml` — active Reaction Lab worker workflow
- `scripts/reaction/render-v4.mjs` — base v4 renderer
- `scripts/reaction/run-v4-hardened.mjs` — active hardened entrypoint
- `scripts/reaction/hf_musetalk_lipsync.py` — current public Hugging Face MuseTalk smoke-provider adapter
- `docs/reaction-renderer-v4.md` — technical renderer status, invariants, known debt and next implementation steps

The product-level source of truth is `21media-mam/docs/reaction-video-lab.md`.

## Reaction worker triggers

`reaction-render.yml` currently supports:

- `workflow_dispatch` with optional exact `reaction_jobs` UUID
- scheduled polling every 5 minutes
- owner-controlled `.github/render-kick` push trigger

Scheduled runs are intentionally single-shot. A worker should not stay alive for several minutes with a stale checkout and later claim a newly queued job.

## Reaction worker secrets

The active Reaction Lab workflow requires:

| Secret | Purpose |
| --- | --- |
| `BUFFER_PUSH_SECRET` | bearer token for protected MAM worker endpoints |
| `SUPABASE_URL` | MAM Supabase project URL |
| `MAM_SUPABASE_SERVICE_ROLE_KEY` | service-role access for Reaction Lab job/storage operations |

The Reaction v4 worker **does not require Kaggle credentials** and does not clone `21media-mam` at runtime.

Other older workflows in this repository may still use additional secrets such as `GH_PAT` or `BLOB_READ_WRITE_TOKEN`; do not assume those are Reaction Lab requirements.

## Current Reaction v4 decisions

- final output remains 1080×1920 9:16
- reusable avatar source library is moving to **16:9 chroma-green short clips**
- current recommended motion units are ~3s reactions, 4s neutrals and 5s speech-ready carriers
- Kling is persona setup only, not called per source video
- spoken comments require a reusable `speech_ready` asset
- ElevenLabs is TTS only
- Kaggle GPU Batch is not in the active path
- public Hugging Face MuseTalk is a smoke backend, **not yet a visually approved production lip-sync provider**
- source audio must survive for the whole source duration
- re-renders should use immutable/versioned result objects
- provider/API success alone is not enough to pass lip-sync QC

## Hardened v4 entrypoint

The workflow runs:

`scripts/reaction/run-v4-hardened.mjs`

The launcher currently enforces two safeguards that were added quickly after live-output failures:

1. spoken events must use an enabled `speech_ready` reusable avatar asset
2. re-renders must use immutable/versioned result paths instead of overwriting one public object

It also explicitly keeps Kaggle out of the active runtime.

This runtime source-patching approach is **temporary technical debt**. Once 16:9 avatar-source support is implemented, these safeguards should be folded directly into the canonical `render-v4.mjs` source and the launcher simplified/removed.

## Current biggest renderer gap

The base v4 renderer still prepares avatar segments through a legacy 720×1280 portrait normalization/crop. That is incompatible with the newly agreed 16:9 green-screen persona library.

Before the next serious avatar-quality test, renderer segment preparation must preserve the 16:9 avatar source, chroma-key it, then scale/position the resulting cutout into the final 1080×1920 composition.

See `docs/reaction-renderer-v4.md` for the exact migration plan.

## Existing non-Reaction workflows

This repo also contains older media automation workflows such as daily clip/photo generation and backlog rendering. They are separate from Reaction Video Lab and can retain their own private-repo clone/secrets model until intentionally migrated.

Do not copy assumptions from those workflows into the Reaction Lab architecture.
