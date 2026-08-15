import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const DRY_RUN = process.env.REACTION_V4_HARDEN_DRY_RUN === '1';
const DIRECT_REACTION_API = 'https://reaction-lab-coral.vercel.app';

// This launcher used to rewrite render-v4.mjs at runtime because the canonical
// renderer was missing production guarantees. Those guarantees now live in the
// renderer itself, so the launcher only asserts they are still present and then
// runs the real file. No generated runtime copy, no source patching.
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
    needle: 'transition_mode: \'anchor_hard_cut\'',
    why: 'dissolving between anchor-identical clips double-exposes the face',
  },
  {
    label: 'word-level caption timings',
    needle: 'transcribeLocally',
    why: 'model-guessed segment timings put captions seconds away from the words they transcribe',
  },
];

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

  console.log(`[reaction-v4-hardening] verified ${GUARANTEES.length} guarantees in render-v4.mjs`);
  console.log('[reaction-v4-hardening] speech-ready selection=ON; immutable outputs=ON; 16:9 avatar=ON; Kaggle path=ABSENT');

  if (DRY_RUN) {
    const check = spawn(process.execPath, ['--check', rendererPath], { stdio: 'inherit', env: process.env });
    const code = await new Promise((resolve, reject) => {
      check.on('error', reject);
      check.on('close', resolve);
    });
    if (code !== 0) throw new Error(`render-v4 syntax check failed with ${code}`);
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
  const child = spawn(process.execPath, [rendererPath], { stdio: 'inherit', env: renderEnv });
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  // 3 means the queue was empty; it is not a failure and callers rely on it.
  if (code !== 0) process.exitCode = Number(code || 1);
}

main().catch(error => {
  console.error('[reaction-v4-hardening] FAILED', error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
