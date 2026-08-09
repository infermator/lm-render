import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const SUPABASE_URL = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_KEY = String(process.env.MAM_SUPABASE_SERVICE_ROLE_KEY || '');
const JOB_ID = String(process.env.JOB_ID || '').trim();
const FORCE_REQUEUE = process.env.FORCE_REQUEUE === '1';

async function forceRequeue(jobId) {
  if (!jobId || !SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error('FORCE_REQUEUE requires JOB_ID + Supabase service credentials');
  }
  const response = await fetch(`${SUPABASE_URL}/rest/v1/reaction_jobs?id=eq.${encodeURIComponent(jobId)}`, {
    method: 'PATCH',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify({
      status: 'queued',
      current_stage: 'render_requeued',
      error: null,
      result_url: null,
      result_path: null,
      started_at: null,
      completed_at: null,
      updated_at: new Date().toISOString(),
    }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Could not requeue ${jobId}: ${response.status} ${text}`);
  console.log(`[reaction-render-v3] Requeued ${jobId}`);
}

function replaceOnce(source, needle, replacement, label) {
  if (!source.includes(needle)) throw new Error(`v3 patch target missing: ${label}`);
  return source.replace(needle, replacement);
}

async function main() {
  if (FORCE_REQUEUE) await forceRequeue(JOB_ID);

  const basePath = path.resolve('scripts/reaction/render-v2.mjs');
  let source = await fs.readFile(basePath, 'utf8');

  source = replaceOnce(
    source,
    "const MUSETALK_WORKER = (process.env.MUSETALK_KAGGLE_WORKER || '').trim();",
    "const MUSETALK_WORKER = (process.env.MUSETALK_KAGGLE_WORKER || '').trim();\nconst KAGGLE_USERNAME_ENV = (process.env.KAGGLE_USERNAME || '').trim();",
    'Kaggle username env',
  );

  source = replaceOnce(
    source,
    "const kaggleUsername = String(request.kaggle_username || '').trim();",
    "const kaggleUsername = KAGGLE_USERNAME_ENV || String(request.kaggle_username || '').trim();",
    'Kaggle username selection',
  );

  source = replaceOnce(
    source,
    "  await fs.copyFile(MUSETALK_WORKER, path.join(dir, 'musetalk_lipsync.py'));\n  await fs.writeFile(path.join(dir, 'job.json'), JSON.stringify({ video_url: videoUrl, audio_url: audioUrl, bbox_shift: 0 }, null, 2));",
    `  const embeddedJobB64 = Buffer.from(JSON.stringify({ video_url: videoUrl, audio_url: audioUrl, bbox_shift: 0 })).toString('base64');
  const workerDest = path.join(dir, 'musetalk_lipsync.py');
  const workerSource = await fs.readFile(MUSETALK_WORKER, 'utf8');
  const bootstrap = 'import base64,json\\nfrom pathlib import Path\\nPath(__file__).resolve().parent.joinpath("job.json").write_text(base64.b64decode("' + embeddedJobB64 + '").decode())\\n';
  await fs.writeFile(workerDest, bootstrap + workerSource);
  await fs.writeFile(path.join(dir, 'job.json'), JSON.stringify({ video_url: videoUrl, audio_url: audioUrl, bbox_shift: 0 }, null, 2));`,
    'Embed Kaggle job payload',
  );

  const diagnosticHelper = `\nasync function collectKaggleFailure(kernel, outDir, status) {\n  const diagnostics = [];\n  try {\n    const logs = await run('kaggle', ['kernels', 'logs', kernel]);\n    const text = String(logs.stdout || logs.stderr || '').trim();\n    if (text) diagnostics.push('KAGGLE LOG TAIL:\\n' + text.slice(-9000));\n  } catch (error) {\n    diagnostics.push('kaggle kernels logs failed: ' + (error instanceof Error ? error.message : String(error)));\n  }\n  try {\n    await run('kaggle', ['kernels', 'output', kernel, '-p', outDir, '-o']);\n  } catch (error) {\n    diagnostics.push('kaggle kernels output failed: ' + (error instanceof Error ? error.message : String(error)));\n  }\n  try {\n    const errorFile = await findFile(outDir, 'musetalk-error.log');\n    if (errorFile) diagnostics.push('MUSETALK TRACEBACK:\\n' + (await fs.readFile(errorFile, 'utf8')).slice(-12000));\n  } catch {}\n  try {\n    const stageFile = await findFile(outDir, 'musetalk-stage.json');\n    if (stageFile) diagnostics.push('MUSETALK STAGE: ' + (await fs.readFile(stageFile, 'utf8')).slice(-2000));\n  } catch {}\n  return 'Kaggle status: ' + status.slice(-1500) + (diagnostics.length ? '\\n\\n' + diagnostics.join('\\n\\n') : '');\n}\n\n`;

  source = replaceOnce(
    source,
    'async function kaggleLipSync({ jobId, index, videoUrl, audioUrl, kaggleUsername }) {',
    diagnosticHelper + 'async function kaggleLipSync({ jobId, index, videoUrl, audioUrl, kaggleUsername }) {',
    'Kaggle diagnostics helper',
  );

  source = replaceOnce(
    source,
    "if (/error|failed|cancel/.test(lower)) throw new Error(`Kaggle MuseTalk failed: ${status.slice(-1500)}`);",
    "if (/error|failed|cancel/.test(lower)) { const details = await collectKaggleFailure(kernel, outDir, status); throw new Error(`Kaggle MuseTalk failed:\\n${details}`); }",
    'Kaggle failed status handling',
  );

  source = source
    .replaceAll('reaction-v2-', 'reaction-v3-')
    .replaceAll('[reaction-render-v2]', '[reaction-render-v3]')
    .replaceAll('lm-render/github-actions-v2', 'lm-render/github-actions-v3');

  const runtimePath = path.join(os.tmpdir(), `reaction-render-v3-${process.pid}.mjs`);
  await fs.writeFile(runtimePath, source);
  console.log(`[reaction-render-v3] Runtime renderer: ${runtimePath}`);

  const child = spawn(process.execPath, [runtimePath], {
    stdio: 'inherit',
    env: process.env,
  });
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  await fs.rm(runtimePath, { force: true }).catch(() => {});
  if (code !== 0) process.exitCode = Number(code || 1);
}

main().catch(error => {
  console.error('[reaction-render-v3] FAILED', error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
