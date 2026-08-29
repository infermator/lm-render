# lm-render

Public GitHub Actions media-render/orchestration repo for 21Media projects.


## Existing non-Reaction workflows

This repo also contains older media automation workflows such as daily clip/photo generation and backlog rendering. They are separate from Reaction Video Lab and can retain their own private-repo clone/secrets model until intentionally migrated.

Do not copy assumptions from those workflows into the Reaction Lab architecture.

## CLIPPER Podcast V3

`scripts/clipper/podcast_render.mjs` owns the Podcast-only render contract. It
reuses stored transcript word timings for 15 pt Inter ASS captions, highlights
only the current word with a contrast-selected accent, and preserves the smooth
caption-lane gradient. When the edit plan carries a validated
`clipper-soundtrack-v1` object, it downloads that private library track, chooses
a deterministic starting offset, normalizes/loops/fades it, ducks it beneath
source speech, limits the final mix, and records the exact track and mix in QC.

Stream V2 (`scripts/clipper/render.mjs`) is deliberately unchanged.
