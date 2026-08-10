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

## Avatar-segment normalization — native 16:9

`renderSegment()` keeps the asset's own 16:9 geometry:

`fps=30 → scale to 1102×620 (decrease) → pad to 1102×620 with the plate colour → setsar=1 → trim → -t`

The legacy `scale/crop 720×1280` portrait path is gone. It cropped from the
centre, and the canonical reference frames the subject on the **right**, so the
crop removed most of him.

The avatar frame is scaled as a whole and pinned flush to the bottom-right of the
1080×1920 canvas (`overlay=W-w:H-h`). The reference deliberately runs the
subject's body off its own right and bottom edges, so those straight cuts sit
under the canvas edges instead of showing as a sticker outline. The empty green
left half of the frame keys away to nothing and costs only transparent pixels.

`-t` is passed on every segment render. `-stream_loop -1` feeds an infinite
input and `trim` alone does not reliably let ffmpeg finish.

Intermediates are H.264 **yuv444p**, so the key is computed from full-resolution
chroma rather than half-resolution 4:2:0 edges. The final delivery encode is
still yuv420p.

## Final composition

Current v4 source composition:

- creates a blurred vertical fill from the source
- fits the useful source foreground into 1080×1920
- chroma-keys the avatar track
- scales avatar
- overlays avatar near the lower-right area

The final product output is still 1080×1920 9:16 even though reusable avatar **source** assets are moving to 16:9.

Do not confuse source-asset aspect ratio with final-video aspect ratio.

## Chroma key — measured, not assumed

This was the single most damaging assumption in the old renderer.

`chromakey` matches on **chroma only and ignores luma**. A real studio green
plate is far less saturated than `0x00FF00`, which places it close to neutral in
UV — and so is a black hoodie. Measured on a representative plate
(`0x3f9a3f`, black hoodie, skin patch, mild vignette):

| similarity | hoodie alpha | skin alpha | plate |
| ---: | ---: | ---: | --- |
| 0.20 | 0 | 0 | keyed |
| 0.16 | 0 | 35 | keyed |
| 0.13 | 60 | 162 | keyed |
| 0.09 | 230 | 255 | keyed |
| **0.07** | **255** | **255** | **keyed** |
| 0.05 | 255 | 255 | plate survives |

The old hard-coded `chromakey=0x00FF00:0.20:0.08` sat well inside the range that
removes the subject entirely. The usable window is narrow and it moves with the
plate, so both halves are now derived per render:

1. **Key colour** — the median RGB of every greenish cell in a 64×36 grid of the
   reference asset's first frame. A corner sample reads the vignette and yields a
   colour the rest of the frame does not match.
2. **Similarity** — a descending candidate ladder from 0.24 to 0.04. Cells are
   classified as subject or plate from the unkeyed frame, then each candidate is
   scored on mean subject alpha and mean plate alpha. The first candidate with
   subject ≥ 250 and plate ≤ 4 wins.

`despill=type=green:mix=0.5:expand=0` is appended when the local ffmpeg exposes
it. At `mix=0.5` it is a no-op on uncontaminated pixels.

Both values land in `render_meta.chroma_*` for QC, and
`node scripts/reaction/render-v4.mjs --calibrate <file|url>` reports them for any
asset without needing job credentials. It exits non-zero when no clean threshold
exists, which means the plate is too uneven or too desaturated to key without
eating the subject — fix the plate, do not widen the threshold.

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

The returned MP3 is then padded locally with **300 ms of silence at each end**
(`adelay` + `apad`) before anything else touches it.

This is what makes a spoken segment cut cleanly. The lip-sync model produces a
closed mouth wherever the audio is silent, so the segment opens and closes on the
same closed-mouth anchor pose as every other clip. It also reads as a natural
breath before the line.

The padded duration — not the raw TTS duration — is the contract for the speech
bed, the lip-sync output check and the segment length. The voice is delayed to
the event's absolute time, so the words land 300 ms later, which is intended.

## Lip-sync

### Speech bed

Lip-sync no longer runs against a single raw asset.

Every speech carrier opens and closes on the same reference frame, so carriers
are chained with hard cuts into a **bed at least as long as the padded line**,
then normalized and uploaded to `reaction-media/tmp/lipsync/`. The Hugging Face
Space takes URLs, so both the bed and the padded voice are uploaded before the
call. The bed is encoded yuv420p for decoder compatibility, not in the 4:4:4
intermediate format used inside the renderer.

This closes a real failure mode. A production render recorded
`lipsync_duration: 12.03s` for a 1.62s line: the provider's output length tracks
the **input video**, not the audio. With a 5s carrier and a longer line the mouth
froze while the voice kept playing, and the only guard accepted anything over
0.75s. The renderer now rejects a lip-sync clip that does not cover the padded
line.

### Current smoke implementation

The base v4 worker invokes public HF Space:

`trymonolith/MuseTalk`

via `hf_musetalk_lipsync.py`.

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

1. **HF MuseTalk quality** — plumbing works; mouth quality not approved.
2. **No robust automatic speech visual QC** — human review still required.
3. **Only one voice comment in smoke mode** — intentional current limit, not final product design.
4. **Avatar placement is a constant** — `AVATAR_H = 620`, flush bottom-right. Should become a per-persona preset after visual review.
5. **Neutral variety comes only from alternating assets** — chunks are cut on whole asset loops so every cut lands on the shared anchor frame. Start offsets would break that, so more variety needs more neutral clips, not offsets.
6. **Legacy experimental workflows/files** — Kaggle probes and QC experiments should eventually be archived once the new pipeline is stable.

## Next code-change order

### 1. Reaction-only render on the new asset pack

Voice disabled. Isolate motion continuity, anchor cuts and chroma quality.

### 2. Speech carrier lip-sync A/B

Speech A (talking) against Speech C (closed mouth), same line, one carrier
enabled at a time.

### 3. Face-ROI lip-sync experiment

Crop and upscale a stable face ROI for inference, then feather it back into the
untouched body clip. This also keeps the speech segment's chroma edges identical
to every other segment, because the plate pixels are never re-encoded by the
provider.

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
