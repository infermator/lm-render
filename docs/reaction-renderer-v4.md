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

## Triggering and the queue

`render-preview` in MAM dispatches this workflow immediately using the `GH_PAT`
token in its Vercel environment. That token is fine-grained with **Actions: Read
and write** on this repository; the older token used to clone private repos is
scoped Actions: Read and returns 403 on dispatch.

The `schedule` trigger remains as a safety net, but it is not a substitute.
Measured across fourteen scheduled firings the median gap is **52 minutes**,
ranging 29 to 123, against a cron asking for five — GitHub throttles scheduled
workflows heavily.

A scheduled run therefore drains the queue rather than rendering one job: it
loops until the renderer reports an empty queue, up to eight jobs. The renderer
exits **3** when it has nothing to claim, which is what stops the loop; a
dispatch carrying an explicit `job_id` runs exactly once.

## Runtime environment

Reaction workflow requires:

- `BUFFER_PUSH_SECRET`
- `SUPABASE_URL`
- `MAM_SUPABASE_SERVICE_ROLE_KEY`

`MAM_BASE` currently points to:

`https://21media-mam.vercel.app`

Optional: `WHISPER_MODEL` (default `small`) selects the caption transcription model.

Toolchain installed by the workflow: `ffmpeg` with libass, `fonts-dejavu-core`, and `faster-whisper`. Whisper weights are cached across runs — they are ~250 MB, and re-downloading them every render would cost more wall clock than the transcription itself.

Current reaction workflow does **not** require Kaggle credentials, a private-repo clone PAT, or any transcription API key.

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
- crops the keyed frame to the subject's measured extent
- overlays that cutout in the corner the Director chose
- burns in captions when the plan asks for them

The final product output is still 1080×1920 9:16 even though reusable avatar **source** assets are moving to 16:9.

Do not confuse source-asset aspect ratio with final-video aspect ratio.

### Cropping to the subject is what makes a corner a corner

The avatar frame is 1102 px wide and the subject occupies its right ~56 %. Aligning the whole frame to `x=0` therefore places him near the middle of the canvas: the empty plate to his left keys away to nothing, but it still consumes the placement.

`subjectBounds()` measures his horizontal extent from the keyed reference — 620 px of 1102 on the current persona — and the overlay crops to it before positioning. A right corner is unaffected; a left corner becomes genuinely left. Measuring rather than hard-coding is what lets a differently framed persona work without a code change.

He is never mirrored to reach a corner.

## Captions

`transcribe_local.py` runs `faster-whisper` on the extracted audio and returns word-level timings; `groupWords()` cuts them into lines of at most five words or 2.4 s, breaking on any gap over 0.7 s; `buildSubtitles()` writes ASS with white fill, a 5 px black outline and a soft shadow.

`MarginV` is measured from the edge the text aligns to, so keeping the band clear of the cutout costs the avatar's full **height**, not the y of its top edge — 660 px, not 1340.

VAD filtering is on. Without it the model transcribes ambient noise into invented speech, and ambient noise is the normal case for this pipeline.

**Transcription is local on purpose.** The first implementation called ElevenLabs Scribe, whose key had no `speech_to_text` permission; the second fell back to Gemini, which returned the right words at the wrong times — it captioned "Keep that. Stephen," over audio that says "goddamn minute", and displayed a caption over a window with no speech in it. Language models transcribe well and keep time badly. Do not put caption timing behind a hosted LLM, and do not treat a whole-video audio-energy correlation as evidence of alignment — on a noisy source it returns the same answer at every offset.

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

## No speech

The persona is silent. There is no TTS call, no lip-sync provider and no
speech carrier in the render path, and `voice_lipsync` is forced false before
a job is queued.

What remains from that era and is still used: the audio mix measures and gains
its input, ducks the source under it and limits the sum. If narration is ever
added as a voiceover — over the source, with no talking cutout — that mixing is
already built.

## Reaction placement

A generated reaction clip is a whole performance: it opens neutral, peaks, and
settles back. The Director's timestamp marks the moment the reaction should
**land**, so the renderer plays the clip whole and slides it until its peak sits
on that timestamp. The offset comes from `metadata.loop.peak_s` on the asset;
without one the midpoint is used.

Two things went wrong here and both are worth remembering.

Cutting the clip to the Director's event duration — about 2.4s — played only the
neutral opening beat, so the reaction was never visible in the render at all.

Then, with placement fixed, reactions still landed late: the neutral gap was
filled up to the event time *before* the asset was chosen, and only then was the
start shifted back. Since the avatar track is concatenated in order, the earlier
fill had already fixed the reaction's real position. A surprise scheduled at 4.5s
peaked at 9.4s. The asset must be resolved before the gap is filled.

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

1. **Clip generation lives here too.** `scripts/reaction/generate-asset.mjs` produces library clips against fal or OpenRouter. It is documented in the MAM repository's `docs/reaction-avatar-asset-spec.md`, which is the odd split to be aware of.
2. **`hf_musetalk_lipsync.py` and the fal lip-sync helpers are dead code** — speech was cut from the product; they should be removed once nothing references them.
3. **Avatar placement is a constant** — `AVATAR_H = 620`, flush bottom-right. Should become a per-persona preset.
4. **Neutral variety comes only from alternating assets** — chunks are cut on whole asset loops so every cut lands on the shared anchor frame. Start offsets would break that, so more variety needs more neutral clips.
5. **Short-lead reactions clamp to the start** — mitigated by keeping one very short clip per fast-onset type; Surprise A is 2.2s for this reason — an event earlier than a clip's peak offset cannot be placed on time.
6. **Legacy experimental workflows** — Kaggle and lip-sync probes should be archived.

## Next code-change order

### 1. Generate the missing reactions

`suspicious` and `laugh` fall back to other types until they exist.

### 2. Regenerate Neutral A on the current recipe

It predates ping-pong and is 4s against Neutral B's 20s, so it repeats far more often.

### 3. Decide reaction density

`targetEvents = (duration / 10) x reaction_density`, clamped 0.08-0.7, yields two events for a 53s source. If denser reactions are wanted the formula has to change, not just the setting.

### 4. Remove the dead speech code

## Non-regression checklist

A future renderer change must not reintroduce:

- speech or lip-sync in any form
- raw green rectangle PiP
- portrait cropping of the 16:9 source library
- a hard-coded chroma key colour or similarity
- cutting a reaction to the Director's event duration — the timestamp is the peak
- filling the neutral gap before the reaction's asset has been chosen
- cross-dissolves between clips that already share an anchor frame
- source audio ending early
- shared or cacheable result URL overwrite
- generic stale job requeue
- manual GitHub Actions as normal operator UX
