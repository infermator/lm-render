import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const DRY_RUN = process.env.REACTION_V4_HARDEN_DRY_RUN === '1';

function replaceOnce(source, needle, replacement, label) {
  if (!source.includes(needle)) throw new Error(`v4 hardening target missing: ${label}`);
  return source.replace(needle, replacement);
}

async function main() {
  const sourcePath = path.resolve('scripts/reaction/render-v4.mjs');
  let source = await fs.readFile(sourcePath, 'utf8');

  // A spoken event must never lip-sync an arbitrary smirk/cringe clip merely
  // because that reaction is active. Speech uses a reusable, explicitly
  // validated carrier that is generated once for the persona.
  if (!source.includes('const speechReadyAssets = assets.filter')) {
    source = replaceOnce(
      source,
      `    const asset = chooseAsset(assets, String(event.type), Number(event.intensity ?? 0.35)) || neutralAssets[neutralState.index++ % neutralAssets.length];
    const hasComment = request.voice_lipsync === true && typeof event.comment === 'string' && event.comment.trim().length > 0;
    let duration = clamp(Number(event.duration ?? 2.4), 0.8, 8);`,
      `    const reactionAsset = chooseAsset(assets, String(event.type), Number(event.intensity ?? 0.35)) || neutralAssets[neutralState.index++ % neutralAssets.length];
    const hasComment = request.voice_lipsync === true && typeof event.comment === 'string' && event.comment.trim().length > 0;
    const speechReadyAssets = assets.filter(candidate => candidate.enabled !== false && candidate.speech_ready === true);
    const speechAsset = hasComment
      ? (speechReadyAssets.find(candidate => candidate.reaction_type === String(event.type)) || speechReadyAssets[0] || null)
      : null;
    if (hasComment && !speechAsset) {
      throw new Error('Voice render requires one enabled speech-ready reusable avatar asset; refusing to fake lip-sync on an unvalidated reaction clip.');
    }
    const asset = speechAsset || reactionAsset;
    let duration = clamp(Number(event.duration ?? 2.4), 0.8, 8);`,
      'speech-ready asset selection',
    );
  }

  if (!source.includes('speech_asset_id: asset.id')) {
    source = replaceOnce(
      source,
      `        lipsync_provider: synced.provider,
        lipsync_duration: synced.duration,
      });`,
      `        lipsync_provider: synced.provider,
        lipsync_duration: synced.duration,
        speech_asset_id: asset.id,
        speech_asset_label: asset.label || null,
      });`,
      'speech asset trace metadata',
    );
  }

  // Replays must never overwrite the same cacheable public object. Every
  // finished render gets an immutable URL, which also makes A/B QC possible.
  if (source.includes('const storagePath = `results/${jobId}.mp4`;')) {
    source = replaceOnce(
      source,
      `async function uploadResult(jobId, file) {
  const storagePath = \`results/\${jobId}.mp4\`;
  const bytes = await fs.readFile(file);`,
      `async function uploadResult(jobId, file) {
  const renderId = \`\${Date.now()}-\${crypto.randomBytes(4).toString('hex')}\`;
  const storagePath = \`results/\${jobId}/\${renderId}.mp4\`;
  const bytes = await fs.readFile(file);`,
      'immutable result path',
    );
    source = replaceOnce(source, `'x-upsert': 'true',`, `'x-upsert': 'false',`, 'immutable upload policy');
  }

  if (!source.includes('results/${jobId}/${renderId}.mp4')) {
    throw new Error('v4 hardening failed: immutable result path is absent');
  }
  if (!source.includes('const speechReadyAssets = assets.filter')) {
    throw new Error('v4 hardening failed: speech-ready asset selection is absent');
  }

  const runtimePath = path.join(os.tmpdir(), `reaction-render-v4-hardened-${process.pid}.mjs`);
  await fs.writeFile(runtimePath, source);
  console.log(`[reaction-v4-hardening] runtime=${runtimePath}`);
  console.log('[reaction-v4-hardening] speech-ready selection=ON; immutable outputs=ON; Kaggle path=ABSENT');

  if (DRY_RUN) {
    const check = spawn(process.execPath, ['--check', runtimePath], { stdio: 'inherit', env: process.env });
    const code = await new Promise((resolve, reject) => {
      check.on('error', reject);
      check.on('close', resolve);
    });
    await fs.rm(runtimePath, { force: true }).catch(() => {});
    if (code !== 0) throw new Error(`Hardened v4 runtime syntax check failed with ${code}`);
    console.log('[reaction-v4-hardening] DRY RUN OK');
    return;
  }

  const child = spawn(process.execPath, [runtimePath], { stdio: 'inherit', env: process.env });
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  await fs.rm(runtimePath, { force: true }).catch(() => {});
  if (code !== 0) process.exitCode = Number(code || 1);
}

main().catch(error => {
  console.error('[reaction-v4-hardening] FAILED', error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
