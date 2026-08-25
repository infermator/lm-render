import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const DRY_RUN = process.env.REACTION_V4_HARDEN_DRY_RUN === '1';
const DIRECT_REACTION_API = 'https://reaction-lab-coral.vercel.app';

const GUARANTEES = [
  { label: 'speech-ready carrier selection', needle: 'asset.speech_ready !== true', why: 'a spoken line must never lip-sync an arbitrary reaction clip' },
  { label: 'speech carriers excluded from reaction selection', needle: "if (!comment && requestedType === 'comment') requestedType = 'neutral'", why: 'a comment event without audio must not select a talking clip' },
  { label: 'immutable result path', needle: 'results/${jobId}/${renderId}.mp4', why: 'a shared result object lets a cached old render masquerade as a new one' },
  { label: 'native 16:9 avatar normalization', needle: 'force_original_aspect_ratio=decrease', why: 'the legacy portrait crop cut the subject out of a 16:9 green-screen plate' },
  { label: 'sampled chroma key colour', needle: 'sampleBackgroundColour', why: 'a hard-coded 0x00FF00 key leaves a rim on a real studio green plate' },
  { label: 'lip-sync duration contract', needle: 'Lip-sync output does not cover the line', why: 'a truncated lip-sync clip freezes the mouth while the voice keeps playing' },
  { label: 'anchor hard cuts', needle: "transition_mode: 'anchor_hard_cut'", why: 'dissolving between anchor-identical clips double-exposes the face' },
  { label: 'word-level caption timings', needle: 'transcribeLocally', why: 'model-guessed segment timings put captions seconds away from the words they transcribe' },
  { label: 'source-text layout safety', needle: 'protectSourceLayout', why: 'a wide corner cut-out must not cover text in the neighbouring centre region' },
  { label: 'source letterbox fit', needle: 'fitAvatarToContentBand', why: 'a corner cut-out taller than the source\'s own empty band sits on the picture' },
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
`  const geometry = layoutGeometry(placement, shift, cut, contentBand);
  const banded = geometry.banded;
  const srcY = geometry.sourceY;
  const pos = { x: geometry.avatarX, y: geometry.avatarY };`,
`  const geometry = layoutGeometry(placement, shift, cut, contentBand);
  const replacementMode = String(sourceReplacement?.mode || '');
  const rawRect = sourceReplacement?.rect || null;
  const localReplacement = replacementMode === 'rect_overlay' && rawRect;
  const replacementRect = localReplacement ? {
    x: Math.round(clamp(Number(rawRect.x), 0, 1) * OUT_W / 2) * 2,
    y: Math.round(clamp(Number(rawRect.y), 0, 1) * OUT_H / 2) * 2,
    width: Math.round(clamp(Number(rawRect.width), 0.16, 1) * OUT_W / 2) * 2,
    height: Math.round(clamp(Number(rawRect.height), 0.12, 0.46) * OUT_H / 2) * 2,
  } : null;
  if (replacementRect) {
    replacementRect.width = Math.min(replacementRect.width, OUT_W - replacementRect.x);
    replacementRect.height = Math.min(replacementRect.height, OUT_H - replacementRect.y);
    if (replacementRect.width < 120 || replacementRect.height < 120) throw new Error('Localized source replacement rectangle is too small');
  }
  const banded = localReplacement ? false : geometry.banded;
  const srcY = localReplacement ? '0' : geometry.sourceY;
  const pos = localReplacement
    ? { x: String(replacementRect.x), y: String(replacementRect.y) }
    : { x: geometry.avatarX, y: geometry.avatarY };`,
    'replacement geometry',
  );

  source = replaceExactlyOnce(
    source,
`  const sourceFit = banded
    ? \`scale=\${OUT_W}:\${geometry.sourceHeight}:force_original_aspect_ratio=increase,crop=\${OUT_W}:\${geometry.sourceHeight}\`
    : \`scale=\${OUT_W}:\${OUT_H}:force_original_aspect_ratio=decrease\`;`,
`  const sourceFit = localReplacement
    ? \`scale=\${OUT_W}:\${OUT_H}:force_original_aspect_ratio=increase,crop=\${OUT_W}:\${OUT_H}\`
    : banded
      ? \`scale=\${OUT_W}:\${geometry.sourceHeight}:force_original_aspect_ratio=increase,crop=\${OUT_W}:\${geometry.sourceHeight}\`
      : \`scale=\${OUT_W}:\${OUT_H}:force_original_aspect_ratio=decrease\`;`,
    'source fit filter',
  );

  source = replaceExactlyOnce(
    source,
`  const filters = [];
  if (plateFile) {`,
`  const filters = [];
  if (localReplacement) {
    if (!plateFile || plateIndex < 0) throw new Error('Localized source replacement requires an enabled background plate');
    const rw = replacementRect.width;
    const rh = replacementRect.height;
    const rx = replacementRect.x;
    const ry = replacementRect.y;
    const patchFit = \`scale=\${rw}:\${rh}:force_original_aspect_ratio=increase,crop=\${rw}:\${rh},setsar=1\`;
    filters.push(\`[0:v]\${sourceFit},setsar=1[sourcebase]\`);
    filters.push(\`[\${plateIndex}:v]\${patchFit}[replacement_plate]\`);
    filters.push(\`[sourcebase][replacement_plate]overlay=\${rx}:\${ry}:format=auto[base]\`);
  } else if (plateFile) {`,
    'localized background patch',
  );

  source = replaceExactlyOnce(
    source,
    '  filters.push(`[1:v]${key},${geometry.avatarFilter}[avatar]`);',
`  if (localReplacement) {
    const rw = replacementRect.width;
    const rh = replacementRect.height;
    // Key the canonical avatar, crop away empty green plate horizontally, then
    // fit the actual person INSIDE the exact foreign-reactor rectangle. Padding
    // is transparent, so the real room/background plate remains visible around
    // the subject rather than becoming another full-width band.
    filters.push(\`[1:v]\${key},crop=\${cut.width}:\${AVATAR_H}:\${cut.x}:0,scale=\${rw}:\${rh}:force_original_aspect_ratio=decrease,pad=\${rw}:\${rh}:(ow-iw)/2:oh-ih:color=0x00000000,format=rgba[avatar]\`);
  } else {
    filters.push(\`[1:v]\${key},\${geometry.avatarFilter}[avatar]\`);
  }`,
    'localized avatar fit',
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
  const sourceReplacement = request.source_replacement?.mode === 'rect_overlay'
    ? request.source_replacement
    : null;
  if (sourceReplacement && !plateFile) {
    throw new Error('Localized source replacement requires an enabled background plate');
  }
  if (sourceReplacement) {
    const rect = sourceReplacement.rect || {};
    const x = Number(rect.x); const y = Number(rect.y); const w = Number(rect.width); const h = Number(rect.height);
    if (![x, y, w, h].every(Number.isFinite) || x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > 1.001 || y + h > 1.001) {
      throw new Error('Localized source replacement received invalid normalized rectangle');
    }
    log(\`Source replacement: preserving source and covering only rect x=\${x.toFixed(3)} y=\${y.toFixed(3)} w=\${w.toFixed(3)} h=\${h.toFixed(3)} with our persona/background\`);
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
    "    layout_source: requested.forced ? 'operator_override' : layoutSafety.changed ? 'director_safety_correction' : 'director',",
    "    layout_source: sourceReplacement ? 'localized_source_replacement' : requested.forced ? 'operator_override' : layoutSafety.changed ? 'director_safety_correction' : 'director',\n    source_replacement: sourceReplacement,",
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
    for (const guarantee of missing) console.error(`[reaction-v4-hardening] MISSING: ${guarantee.label} — ${guarantee.why}`);
    throw new Error(`render-v4.mjs is missing ${missing.length} production guarantee(s)`);
  }

  const runtimeSource = patchSourceReplacement(source);
  const runtimePath = path.resolve(`scripts/reaction/.render-v4-runtime-${process.pid}.mjs`);
  await fs.writeFile(runtimePath, runtimeSource, 'utf8');

  console.log(`[reaction-v4-hardening] verified ${GUARANTEES.length} guarantees in render-v4.mjs`);
  console.log('[reaction-v4-hardening] localized source replacement=ON; full-width source crop=OFF; immutable outputs=ON; 16:9 avatar=ON');

  try {
    await checkSyntax(runtimePath);
    if (DRY_RUN) {
      console.log('[reaction-v4-hardening] DRY RUN OK');
      return;
    }

    const renderEnv = {
      ...process.env,
      MAM_BASE: String(process.env.MAM_BASE || DIRECT_REACTION_API).replace(/\/$/, ''),
    };
    const child = spawn(process.execPath, [runtimePath], { stdio: 'inherit', env: renderEnv });
    const code = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', resolve);
    });
    if (code !== 0) process.exitCode = Number(code || 1);
  } finally {
    await fs.rm(runtimePath, { force: true }).catch(() => {});
  }
}

main().catch(error => {
  console.error('[reaction-v4-hardening] FAILED', error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
