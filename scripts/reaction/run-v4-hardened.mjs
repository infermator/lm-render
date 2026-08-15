import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const DRY_RUN = process.env.REACTION_V4_HARDEN_DRY_RUN === '1';
const DIRECT_REACTION_API = 'https://reaction-lab-coral.vercel.app';

// Canonical renderer guarantees. The source-replacement feature below is kept
// in this hardened launcher because render-v4.mjs is large and stable: we patch
// a temporary runtime copy with exact anchors, validate the syntax, run it, then
// delete it. If canonical code ever changes around an anchor, fail before any
// paid render work instead of silently applying a stale transformation.
const GUARANTEES = [
  {
    label: 'speech-ready carrier selection',
    needle: 'asset.speech_ready !== true',
    why: 'a spoken line must never lip-sync an arbitrary reaction clip',
  },
  {
    label: 'speech carriers excluded from reaction selection',
    needle: "if (!comment && requestedType === 'comment') requestedType = 'neutral'",
    why: 'a comment event without audio must not select a talking clip',
  },
  {
    label: 'immutable result path',
    needle: 'results/${jobId}/${renderId}.mp4',
    why: 'a shared result object lets a cached old render masquerade as a new one',
  },
  {
    label: 'native 16:9 avatar normalization',
    needle: 'force_original_aspect_ratio=decrease',
    why: 'the legacy portrait crop cut the subject out of a 16:9 green-screen plate',
  },
  {
    label: 'sampled chroma key colour',
    needle: 'sampleBackgroundColour',
    why: 'a hard-coded 0x00FF00 key leaves a rim on a real studio green plate',
  },
  {
    label: 'lip-sync duration contract',
    needle: 'Lip-sync output does not cover the line',
    why: 'a truncated lip-sync clip freezes the mouth while the voice keeps playing',
  },
  {
    label: 'anchor hard cuts',
    needle: "transition_mode: 'anchor_hard_cut'",
    why: 'dissolving between anchor-identical clips double-exposes the face',
  },
  {
    label: 'word-level caption timings',
    needle: 'transcribeLocally',
    why: 'model-guessed segment timings put captions seconds away from the words they transcribe',
  },
];

function replaceExactlyOnce(source, needle, replacement, label) {
  const first = source.indexOf(needle);
  if (first < 0) throw new Error(`source-replacement patch anchor missing: ${label}`);
  if (source.indexOf(needle, first + needle.length) >= 0) {
    throw new Error(`source-replacement patch anchor is ambiguous: ${label}`);
  }
  return source.slice(0, first) + replacement + source.slice(first + needle.length);
}

function patchSourceReplacement(canonicalSource) {
  let source = canonicalSource;

  source = replaceExactlyOnce(
    source,
    'async function composeFinal(source, avatarTrack, comments, totalDuration, sourceHasAudio, despillAvailable, layout, plateFile, subtitleFile, subject) {',
    'async function composeFinal(source, avatarTrack, comments, totalDuration, sourceHasAudio, despillAvailable, layout, plateFile, subtitleFile, subject, sourceReplacement = null) {',
    'composeFinal signature',
  );

  source = replaceExactlyOnce(
    source,
`  const sourceFit = banded
    ? \`scale=\${OUT_W}:\${geometry.sourceHeight}:force_original_aspect_ratio=increase,crop=\${OUT_W}:\${geometry.sourceHeight}\`
    : \`scale=\${OUT_W}:\${OUT_H}:force_original_aspect_ratio=decrease\`;`,
`  // A source admitted as replace_existing_reactor has a foreign reactor in a
  // stable slice attached to the TOP edge. Physically remove that slice before
  // fitting the surviving source into the lower canvas. This is different from
  // merely shifting/scaling the whole source, which would leave the old reactor
  // visible lower in the frame.
  const replacementMode = String(sourceReplacement?.mode || '');
  const requestedCrop = Number(sourceReplacement?.crop_top_fraction);
  const cropTopFraction = replacementMode === 'crop_top' && Number.isFinite(requestedCrop)
    ? clamp(requestedCrop, 0.18, 0.48)
    : 0;
  const sourcePre = cropTopFraction > 0
    ? \`crop=iw:ih*\${(1 - cropTopFraction).toFixed(4)}:0:ih*\${cropTopFraction.toFixed(4)},\`
    : '';
  const sourceFit = banded
    ? \`\${sourcePre}scale=\${OUT_W}:\${geometry.sourceHeight}:force_original_aspect_ratio=increase,crop=\${OUT_W}:\${geometry.sourceHeight}\`
    : \`\${sourcePre}scale=\${OUT_W}:\${OUT_H}:force_original_aspect_ratio=decrease\`;`,
    'source fit filter',
  );

  source = replaceExactlyOnce(
    source,
`  const plateFile = plateAsset
    ? await cachedDownload(plateAsset.video_url, path.extname(new URL(plateAsset.video_url).pathname) || '.jpg')
    : null;

  // An operator who asks for a top corner gets one whether or not a plate`,
`  const plateFile = plateAsset
    ? await cachedDownload(plateAsset.video_url, path.extname(new URL(plateAsset.video_url).pathname) || '.jpg')
    : null;
  const sourceReplacement = request.source_replacement?.mode === 'crop_top'
    ? request.source_replacement
    : null;
  if (sourceReplacement && !plateFile) {
    throw new Error('Source replacement requires an enabled background plate');
  }
  if (sourceReplacement && String(requested.layout?.avatar || '') !== 'top_band') {
    throw new Error('Source replacement must render in top_band layout');
  }
  if (sourceReplacement) {
    const crop = clamp(Number(sourceReplacement.crop_top_fraction || 0.34), 0.18, 0.48);
    log(\`Source replacement: removing top \${(crop * 100).toFixed(1)}% of source, then filling that band with our persona/background\`);
  }

  // An operator who asks for a top corner gets one whether or not a plate`,
    'replacement guard after background resolution',
  );

  source = replaceExactlyOnce(
    source,
    '  let final = await composeFinal(source, avatarTrack, comments, duration, sourceHasAudio, despillAvailable, effectiveLayout, plateFile, subtitleFile, subject);',
    '  let final = await composeFinal(source, avatarTrack, comments, duration, sourceHasAudio, despillAvailable, effectiveLayout, plateFile, subtitleFile, subject, sourceReplacement);',
    'composeFinal invocation',
  );

  source = replaceExactlyOnce(
    source,
    "    layout_source: requested.forced ? 'operator_override' : 'director',",
    "    layout_source: sourceReplacement ? 'source_replacement' : requested.forced ? 'operator_override' : 'director',\n    source_replacement: sourceReplacement,",
    'render metadata replacement provenance',
  );

  return source;
}

async function checkSyntax(file) {
  const check = spawn(process.execPath, ['--check', file], { stdio: 'inherit', env: process.env });
  const code = await new Promise((resolve, reject) => {
    check.on('error', reject);
    check.on('close', resolve);
  });
  if (code !== 0) throw new Error(`render-v4 syntax check failed with ${code}`);
}

async function main() {
  const rendererPath = path.resolve('scripts/reaction/render-v4.mjs');
  const source = await fs.readFile(rendererPath, 'utf8');

  const missing = GUARANTEES.filter(guarantee => !source.includes(guarantee.needle));
  if (missing.length) {
    for (const guarantee of missing) {
      console.error(`[reaction-v4-hardening] MISSING: ${guarantee.label} — ${guarantee.why}`);
    }
    throw new Error(`render-v4.mjs is missing ${missing.length} production guarantee(s)`);
  }

  const runtimeSource = patchSourceReplacement(source);
  const runtimePath = path.resolve(`scripts/reaction/.render-v4-runtime-${process.pid}.mjs`);
  await fs.writeFile(runtimePath, runtimeSource, 'utf8');

  console.log(`[reaction-v4-hardening] verified ${GUARANTEES.length} guarantees in render-v4.mjs`);
  console.log('[reaction-v4-hardening] source replacement=ON; immutable outputs=ON; 16:9 avatar=ON; Kaggle path=ABSENT');

  try {
    // Always syntax-check the actually executed runtime copy. This also catches
    // accidental invalid patch output before the worker can claim a job.
    await checkSyntax(runtimePath);

    if (DRY_RUN) {
      console.log('[reaction-v4-hardening] DRY RUN OK');
      return;
    }

    // Machine traffic must never silently fall back to the MAM browser-session
    // gateway. The workflow sets MAM_BASE explicitly, and this fallback protects
    // manual/alternate launches from regressing to the old 401 route.
    const renderEnv = {
      ...process.env,
      MAM_BASE: String(process.env.MAM_BASE || DIRECT_REACTION_API).replace(/\/$/, ''),
    };
    const child = spawn(process.execPath, [runtimePath], { stdio: 'inherit', env: renderEnv });
    const code = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', resolve);
    });
    // 3 means the queue was empty; the workflow drain wrapper handles it as a
    // clean stop. Preserve the renderer code here rather than hiding failures.
    if (code !== 0) process.exitCode = Number(code || 1);
  } finally {
    await fs.rm(runtimePath, { force: true }).catch(() => {});
  }
}

main().catch(error => {
  console.error('[reaction-v4-hardening] FAILED', error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
