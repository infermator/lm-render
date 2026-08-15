#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const MAM_BASE = String(process.env.MAM_BASE || 'https://reaction-lab-coral.vercel.app').replace(/\/$/, '');
const SECRET = String(process.env.BUFFER_PUSH_SECRET || process.env.REACTION_PIPELINE_SECRET || '').trim();
const STORAGE_URL = String(process.env.SHOTLEE_SUPABASE_URL || process.env.SUPABASE_URL || '').replace(/\/$/, '');
const STORAGE_KEY = String(process.env.SHOTLEE_SUPABASE_SERVICE_ROLE_KEY || process.env.MAM_SUPABASE_SERVICE_ROLE_KEY || '').trim();
const EXACT_RENDER_ID = String(process.env.RENDER_ID || '').trim();
const WORKER_RUN_ID = String(process.env.GITHUB_RUN_ID || `local-${Date.now()}`);

if (!SECRET) throw new Error('BUFFER_PUSH_SECRET / REACTION_PIPELINE_SECRET missing');
if (!STORAGE_URL || !STORAGE_KEY) throw new Error('Shotlee storage credentials missing');

async function api(route, body) {
  const response = await fetch(`${MAM_BASE}${route}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const payload = await response.json().catch(async () => ({ error: await response.text().catch(() => '') }));
  if (!response.ok) throw new Error(`${route} HTTP ${response.status}: ${payload?.error || JSON.stringify(payload)}`);
  return payload;
}

async function progress(renderId, stage, message = '') {
  try {
    await api('/api/clipper/progress', { render_id: renderId, stage, message });
  } catch (error) {
    console.warn(`[clipper-render] progress ${stage} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function run(command, args, options = {}) {
  console.log(`[clipper-render] $ ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited ${result.status}`);
}

function runCapture(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited ${result.status}: ${(result.stderr || '').slice(-1200)}`);
  return result.stdout || '';
}

function commandOk(command, args) {
  const result = spawnSync(command, args, { stdio: 'ignore' });
  return !result.error && result.status === 0;
}

function ensureCaptionTooling() {
  if (commandOk('python3', ['-c', 'import faster_whisper'])) return;
  console.log('[clipper-render] installing faster-whisper only because this selected render requested captions');
  run('python3', ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', 'faster-whisper>=1.0.3']);
}

function findDownloadedFile(dir) {
  const preferred = ['source.mp4', 'source.mkv', 'source.webm', 'source.mov'];
  for (const name of preferred) {
    const target = path.join(dir, name);
    if (fs.existsSync(target) && fs.statSync(target).size > 1024) return target;
  }
  const match = fs.readdirSync(dir).find(name => /^source\./.test(name) && fs.statSync(path.join(dir, name)).isFile());
  return match ? path.join(dir, match) : null;
}

function srtTimestamp(seconds) {
  const ms = Math.max(0, Math.round(Number(seconds || 0) * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const milli = ms % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(milli).padStart(3, '0')}`;
}

function writeCaptions(source, outPath, language) {
  const script = path.resolve('scripts/reaction/transcribe_local.py');
  const args = [script, source, '--model', process.env.WHISPER_MODEL || 'tiny'];
  if (language && language !== 'unknown' && language !== 'auto') args.push('--language', language);
  const raw = runCapture('python3', args);
  const payload = JSON.parse(raw);
  const words = Array.isArray(payload.words) ? payload.words : [];
  if (!words.length) return { created: false, provider: payload.provider || null, words: 0 };

  const groups = [];
  let group = [];
  for (const word of words) {
    group.push(word);
    const duration = Number(group[group.length - 1].end) - Number(group[0].start);
    if (group.length >= 5 || duration >= 2.4) {
      groups.push(group);
      group = [];
    }
  }
  if (group.length) groups.push(group);

  const srt = groups.map((items, index) => {
    const text = items.map(item => String(item.text || '').trim()).filter(Boolean).join(' ');
    return `${index + 1}\n${srtTimestamp(items[0].start)} --> ${srtTimestamp(items[items.length - 1].end)}\n${text}\n`;
  }).join('\n');
  fs.writeFileSync(outPath, srt, 'utf8');
  return { created: Boolean(srt.trim()), provider: payload.provider || null, words: words.length };
}

function escapeSubtitlePath(filePath) {
  return filePath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

function uploadObject(localPath, objectPath, contentType) {
  const encoded = objectPath.split('/').map(encodeURIComponent).join('/');
  // GitHub masks configured secrets, but do not print this curl command at all.
  const result = spawnSync('curl', [
    '-fsS', '-X', 'POST', `${STORAGE_URL}/storage/v1/object/clipper-media/${encoded}`,
    '-H', `Authorization: Bearer ${STORAGE_KEY}`,
    '-H', `apikey: ${STORAGE_KEY}`,
    '-H', 'x-upsert: true',
    '-H', `Content-Type: ${contentType}`,
    '--data-binary', `@${localPath}`,
  ], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`storage upload exited ${result.status}`);
}

function probe(file) {
  const raw = runCapture('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file]);
  return JSON.parse(raw);
}

async function main() {
  // IMPORTANT: claim before any optional heavy setup. The UI should move from
  // queued -> rendering in seconds, not after Whisper dependencies finish.
  const claimed = await api('/api/clipper/claim', { render_id: EXACT_RENDER_ID || undefined, worker_run_id: WORKER_RUN_ID });
  if (!claimed.render) {
    console.log('[clipper-render] queue empty');
    process.exitCode = 3;
    return;
  }

  const { render, candidate, vod } = claimed;
  await progress(render.id, 'claimed', `GitHub run ${WORKER_RUN_ID}`);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), `clipper-${String(render.id).slice(0, 8)}-`));
  console.log(`[clipper-render] render=${render.id} candidate=${candidate.id} vod=${vod.id}`);

  let sourceStoragePath = null;
  let resultStoragePath = null;
  try {
    const plan = render.edit_plan || {};
    const output = plan.output || {};
    const start = Number(plan.candidate?.start_s ?? candidate.clip_start_s);
    const end = Number(plan.candidate?.end_s ?? candidate.clip_end_s);
    const duration = end - start;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new Error('Invalid candidate timestamp range');
    if (duration < 15 || duration > 90.01) throw new Error(`CLIPPER duration contract violated (${duration.toFixed(1)}s; expected 15–90s)`);

    await progress(render.id, 'downloading', `Materializing ${duration.toFixed(1)}s selected window`);
    const sourcePattern = path.join(work, 'source.%(ext)s');
    run('yt-dlp', [
      '--no-playlist',
      '--js-runtimes', 'node',
      '--remote-components', 'ejs:github',
      '--download-sections', `*${start}-${end}`,
      '--force-keyframes-at-cuts',
      '--merge-output-format', 'mp4',
      '-f', 'bv*+ba/b',
      '-o', sourcePattern,
      String(vod.source_url),
    ]);

    let source = findDownloadedFile(work);
    if (!source) throw new Error('yt-dlp completed without a source file');
    await progress(render.id, 'normalizing', 'Normalizing selected source window');
    const canonicalSource = path.join(work, 'candidate-source.mp4');
    run('ffmpeg', ['-y', '-i', source, '-map', '0:v:0', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', canonicalSource]);
    source = canonicalSource;

    const captionsEnabled = output.captions !== false;
    const captionPath = path.join(work, 'captions.srt');
    let captionMeta = { created: false, provider: null, words: 0 };
    if (captionsEnabled) {
      await progress(render.id, 'transcribing', 'Preparing local Whisper captions');
      try {
        ensureCaptionTooling();
        captionMeta = writeCaptions(source, captionPath, output.language || vod.language || 'auto');
      } catch (error) {
        console.warn(`[clipper-render] captions skipped: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    await progress(render.id, 'composing', 'Rendering 1080×1920 vertical edit');
    const layout = output.layout === 'center_crop' ? 'center_crop' : 'fit_blur';
    const out = path.join(work, 'video.mp4');
    const captionFilter = captionMeta.created
      ? `,subtitles='${escapeSubtitlePath(captionPath)}':force_style='FontName=DejaVu Sans,FontSize=18,Bold=1,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,Outline=3,Shadow=0,Alignment=2,MarginV=190'`
      : '';

    const filter = layout === 'center_crop'
      ? `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920${captionFilter}[v]`
      : `[0:v]split=2[bg0][fg0];[bg0]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,gblur=sigma=28,eq=brightness=-0.16[bg];[fg0]scale=1080:1920:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2${captionFilter}[v]`;

    run('ffmpeg', [
      '-y', '-i', source,
      '-filter_complex', filter,
      '-map', '[v]', '-map', '0:a?',
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
      '-r', String(Number(output.fps || 30)), '-movflags', '+faststart', out,
    ]);

    const resultProbe = probe(out);
    const videoStream = (resultProbe.streams || []).find(stream => stream.codec_type === 'video') || {};
    if (Number(videoStream.width) !== 1080 || Number(videoStream.height) !== 1920) {
      throw new Error(`Unexpected output geometry ${videoStream.width}x${videoStream.height}`);
    }

    await progress(render.id, 'uploading', 'Uploading source window and rendered MP4 to clipper-media');
    sourceStoragePath = `candidates/${candidate.id}/source.mp4`;
    resultStoragePath = `renders/${candidate.id}/${render.id}/video.mp4`;
    uploadObject(source, sourceStoragePath, 'video/mp4');
    uploadObject(out, resultStoragePath, 'video/mp4');

    await progress(render.id, 'finalizing', 'Persisting render result and QC');
    await api('/api/clipper/complete', {
      render_id: render.id,
      ok: true,
      source_storage_path: sourceStoragePath,
      result_storage_path: resultStoragePath,
      render_meta: {
        worker: 'lm-render/clipper-v2',
        worker_run_id: WORKER_RUN_ID,
        source_window_s: [start, end],
        layout,
        captions: captionMeta,
        ffprobe: resultProbe,
      },
      qc_json: {
        passed: true,
        width: Number(videoStream.width),
        height: Number(videoStream.height),
        duration_s: Number(resultProbe.format?.duration || 0),
      },
    });
    console.log(`[clipper-render] completed ${render.id} -> ${resultStoragePath}`);
  } catch (error) {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    console.error(`[clipper-render] failed ${render.id}: ${message}`);
    try {
      await api('/api/clipper/complete', {
        render_id: render.id,
        ok: false,
        source_storage_path: sourceStoragePath,
        result_storage_path: resultStoragePath,
        render_meta: { worker: 'lm-render/clipper-v2', worker_run_id: WORKER_RUN_ID },
        error: message.slice(0, 2800),
      });
    } catch (completeError) {
      console.error('[clipper-render] failed to report completion', completeError);
    }
    process.exitCode = 1;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

await main();
