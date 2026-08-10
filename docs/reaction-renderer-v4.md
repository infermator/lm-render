# Reaction Video Lab — renderer v4 technical documentation

> Snapshot: 2026-08-10. Product decisions live in private MAM repo `docs/reaction-video-lab.md`. This file documents the actual worker implementation, current safeguards, known code debt and the next renderer changes required for the new avatar library.

## Scope

`lm-render` is the asynchronous media execution layer for Reaction Video Lab. It does not decide what happened in the source; it receives a saved Reaction Director plan and turns it into a final media file.

Worker responsibility:

`queued job → asset mapping → timeline → optional TTS/lip-sync → avatar track → chroma composition → source audio mix → validation → Supabase upload → complete/fail`

## Active files

### `.github/workflows/reaction-render.yml`

Production worker orchestration.

Triggers:

- `workflow_dispatch` with optional exact job UUID
- `schedule` every 5 minutes
- owner-controlled push to `.github/render-kick`

Important behavior:

- one Reaction worker concurrency group
- scheduled runs are single-shot so a stale checkout cannot remain alive and claim a future job
- Node 24
- ffmpeg/ffprobe installed on runner
- `gradio_client` installed for current HF smoke provider
- executes the hardened v4 entrypoint

### `scripts/reaction/render-v4.mjs`

Base v4 renderer.

Contains:

- job claim/progress/complete API calls
- source/asset download + cache
- semantic fallback mapping
- neutral/reaction timeline construction
- TTS request
- HF MuseTalk call
- segment normalization/rendering
- xfade avatar-track creation
- chroma composition
- audio ducking/mix
- ffprobe final validation
- result upload

### `scripts/reaction/run-v4-hardened.mjs`

Current active entrypoint.

It reads `render-v4.mjs`, applies critical safety fixes in-memory, writes a temporary hardened runtime file and executes that runtime.

Current hardening guarantees:

- spoken events select only an enabled `speech_ready=true` asset
- speech asset ID/label are traceable in comment metadata
- result uploads use unique/versioned paths rather than overwriting `results/{jobId}.mp4`
- upsert is disabled for final immutable objects
- Kaggle is absent from the active runtime

A dedicated dry-run workflow verifies the hardened runtime can be constructed and syntax-checked.

This is **short-term safety hardening**, not the preferred final architecture. These changes should be merged directly into `render-v4.mjs` during the next renderer refactor.

### `scripts/reaction/hf_musetalk_lipsync.py`

Current smoke-provider adapter for public Hugging Face MuseTalk.

The provider is useful for plumbing tests but has **not passed visual mouth-quality acceptance** on the old angled reaction carrier. Do not treat it as a production-quality dependency simply because it returns MP4 successfully.

## Runtime environment

Reaction workflow requires:

- `BUFFER_PUSH_SECRET`
- `SUPABASE_URL`
- `MAM_SUPABASE_SERVICE_ROLE_KEY`

`MAM_BASE` currently points to:

`https://21media-mam.vercel.app`

Current reaction workflow does **not** require Kaggle credentials or a private-repo clone PAT.

## Job lifecycle

### Queueing

MAM render-preview/request logic stores a `render_request` into `reaction_jobs.render_meta`, then sets the job to queued.

Current request metadata includes:

- `voice_lipsync`
- `max_voice_comments` (currently 1 for smoke renders)
- current lip-sync provider label
- avatar mode `chroma`
- renderer version `v4`
- enabled asset reaction vocabulary
- speech-ready asset IDs

MAM rejects voice mode before queueing if the persona has no enabled speech-ready asset.

### Claim

Worker calls:

`POST /api/reaction/claim`

An exact `JOB_ID` can be provided; otherwise the worker claims the oldest appropriate queued job.

A push/replay can use `FORCE_REQUEUE`, but normal product retries should go through the MAM render-request validation path rather than generic stale metadata requeue.

### Progress stages

V4 reports stages such as:

- `render_preparing`
- `timeline_building`
- `tts_generating`
- `lipsync_hf_running`
- `avatar_rendering`
- `compositing`
- `result_uploading`
- final completion/failure

## Director-plan adaptation

`adaptPlan()` maps requested Director event types to reaction types the persona actually has.

Current fallback examples:

- `laugh` → smirk/cringe/neutral
- `disbelief` → cringe/smirk/neutral
- `suspicious` → cringe/neutral/smirk
- `surprise` → cringe/neutral/smirk
- `comment` → neutral/smirk/cringe

This was useful while the library was tiny. As the new library expands, fallback policy should become less approximate; once Disbelief/Surprise exist, they should normally stay native.

Current smoke logic keeps only the configured maximum number of voice comments (currently one).

## Timeline behavior

`buildTimeline()`:

- sorts events by absolute source time
- fills gaps with neutral segments
- selects a reaction asset by type/intensity
- creates TTS for retained spoken comments
- invokes lip-sync for spoken intervals
- extends a spoken event duration enough to contain TTS
- returns avatar segments plus timed comment audio

### Absolute clock rule

Event times are source-time coordinates. Transition logic must not progressively move later events.

V4 crossfade creation renders each segment with enough tail for the overlap, uses ~160 ms fade overlaps, then trims the final avatar track back to the exact source duration.

A post-render duration check rejects avatar-track drift.

## Current neutral behavior

The base renderer can stream-loop neutral assets and create neutral chunks up to 10.5 seconds.

That behavior was written for the earlier longer-carrier design. With the new short 4-second Neutral A/B strategy, the next iteration should reduce obvious repetition by using:

- alternating neutral assets
- short source offsets where safe
- shorter neutral chunks
- controlled loop/crossfade points
- potentially small speed/time-offset variation only if it remains visually natural

Do not simply loop one 4-second clip for a long source and call that continuous performance.

## Current avatar-segment normalization — IMPORTANT BLOCKER

The base `renderSegment()` currently uses legacy portrait preparation roughly equivalent to:

`fps=30 → scale/crop to 720×1280`

This is now the largest renderer mismatch.

### Why it is wrong now

The new canonical avatar source library is **16:9 green-screen**. Cropping it into a 9:16 intermediate destroys the intended framing and makes the new asset-generation strategy pointless.

### Required refactor

Before the next serious visual test, replace portrait normalization with a 16:9-preserving path.

Recommended shape:

1. accept the 16:9 green-screen asset
2. normalize FPS to 30
3. normalize to a consistent 16:9 working resolution such as 1280×720 without portrait crop
4. trim/loop/tpad as needed while preserving geometry
5. crossfade compatible green-screen segments
6. chroma-key the resulting avatar track
7. scale/position the transparent cutout inside the final 1080×1920 composition

Exact working resolution and avatar scale should remain configurable after visual testing.

## Final composition

Current v4 source composition:

- creates a blurred vertical fill from the source
- fits the useful source foreground into 1080×1920
- chroma-keys the avatar track
- scales avatar
- overlays avatar near the lower-right area

The final product output is still 1080×1920 9:16 even though reusable avatar **source** assets are moving to 16:9.

Do not confuse source-asset aspect ratio with final-video aspect ratio.

## Chroma expectations

Target:

- no visible raw green rectangle
- acceptable edge softness around hair/earbud wires
- minimal green spill on skin/clothes
- stable avatar bounds between short clips

The current ffmpeg chromakey settings are a starting point, not sacred constants. The new HQ asset pack should be used to tune similarity/blend/despill rather than tuning against legacy room assets.

## Speech-ready carrier rule

A spoken event must not use the currently active smirk/cringe clip solely because that reaction is active.

Active hardened logic:

1. collect enabled `speech_ready=true` assets
2. prefer a speech-ready asset matching the semantic type if available
3. otherwise use the first speech-ready carrier
4. if none exists, fail explicitly

Current planned library uses:

- Speech A — `comment`, speech-ready
- Speech B — `comment`, speech-ready

These are persona infrastructure generated once, then reused across sources.

## TTS

Worker requests generated comment audio from MAM:

`POST /api/reaction/tts`

The worker downloads the returned MP3 and probes its real duration.

The event segment is expanded as needed to contain the TTS plus a small margin, bounded by current timeline limits.

## Lip-sync

### Current smoke implementation

The base v4 worker invokes public HF Space:

`trymonolith/MuseTalk`

via `hf_musetalk_lipsync.py`.

The result is accepted technically only if a usable MP4 exists and has a minimum duration.

### Why that is not enough

A real smoke render showed that a valid MuseTalk MP4 could still have effectively static lips on the old angled reaction carrier.

Therefore future spoken completion needs quality validation beyond file existence.

### Preferred next implementation

Use the new Speech A/B assets and test a face-ROI path:

1. detect face in carrier frames
2. derive stable padded face ROI
3. crop/upscale ROI for lip-sync inference
4. run provider on the larger face
5. align output back to original frame coordinates
6. feather/composite modified face into the untouched body carrier
7. continue chroma workflow

This should be compared against full-frame inference and alternative providers such as LatentSync-class models.

### Provider rule

Keep provider selection abstract. Do not bake public MuseTalk or any paid provider into product architecture permanently.

Kaggle GPU Batch is specifically excluded from the active path based on repeated CPU-only execution during API probes.

## Audio mixing

Current v4 audio behavior for spoken renders:

1. every TTS clip is resampled to 48 kHz
2. audio is delayed to its absolute Director timestamp
3. voice is padded/trimmed to full source duration
4. source audio is padded/trimmed to full duration
5. voice is split into:
   - sidechain control
   - final voice mix
6. source is ducked with sidechain compression
7. ducked source + voice are mixed with `duration=first`

This design fixed the earlier bug where the source audio disappeared after the comment.

### Required audio invariant

If source audio existed, it must remain audible after the TTS interval through the end of the source.

Do not rely only on stream metadata. A post-TTS loudness/audibility probe is a useful QC signal.

## Final validation

V4 currently checks:

- video stream exists
- final size is exactly 1080×1920
- final duration is close to source duration
- audio exists when expected
- audio duration does not end materially early

Delivery encode:

- H.264
- yuv420p
- AAC 48 kHz when audio exists
- faststart

Future automated QC should add:

- representative frame decode
- chroma/green residue estimate
- avatar region stability
- post-TTS audible-source check
- mouth-motion signal during speech, if a robust method is found

Automated mouth QC should not replace human review until its signal is proven reliable.

## Result upload

The checked-in base `render-v4.mjs` still contains the older single-object upload path, but the active hardened launcher rewrites this at runtime to unique result objects.

Target canonical behavior:

`results/{jobId}/{renderId}.mp4`

with no upsert.

Reason:

- no stale CDN/browser ambiguity
- easy A/B comparison
- each render iteration is traceable

This behavior should be moved directly into `render-v4.mjs` during the next refactor.

## Current known technical debt

1. **16:9 asset mismatch** — portrait normalization still exists in base renderer.
2. **Runtime source patching** — hardening belongs directly in canonical source.
3. **HF MuseTalk quality** — plumbing works; mouth quality not approved.
4. **No robust automatic speech visual QC** — human review still required.
5. **Neutral loop strategy** — needs adaptation for 4-second short neutrals.
6. **Transitions are simple xfade** — no real pose-aware morph/interpolation yet.
7. **Only one voice comment in smoke mode** — intentional current limit, not final product design.
8. **Hardcoded avatar placement/chroma parameters** — should become presets after new-library visual tuning.
9. **Legacy experimental workflows/files** — Kaggle probes and QC experiments should eventually be archived/removed once the new pipeline is stable.

## Next code-change order

### 1. Fold hardening into `render-v4.mjs`

Move:

- speech-ready selection
- speech trace fields
- immutable result upload

into canonical renderer source.

Then simplify `run-v4-hardened.mjs` to a thin launcher or remove it.

### 2. Implement native 16:9 avatar normalization

This must land before evaluating the new Kling asset pack.

### 3. Tune chroma/placement against new HQ assets

Do not tune against old room-background clips.

### 4. Implement short-library neutral/reaction strategy

Support 3s reactions / 4s neutrals without obvious repeated loops.

### 5. Validate reaction-only render

No TTS/lip-sync. Isolate motion continuity and chroma quality first.

### 6. Implement/test speech-ready carriers

Use Speech A/B and real ElevenLabs TTS.

### 7. Add face-ROI lip-sync experiment

A/B against full-frame and provider alternatives.

### 8. Add meaningful QC gates

Do not mark visually static speech as product success.

### 9. Only then optimize latency/provider SLA

Correctness and visual quality come before worker speed.

## Non-regression checklist

A future renderer change must not reintroduce:

- raw green rectangle PiP
- portrait cropping of the new 16:9 source library
- arbitrary reaction clip used as speech carrier
- source audio ending after TTS
- event timestamp drift from crossfades
- shared/cacheable result URL overwrite
- Kaggle in the active critical path without new evidence it works
- generic stale job requeue
- manual GitHub Actions as normal operator UX
