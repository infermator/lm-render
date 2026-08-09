import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';

const MAM_BASE = (process.env.MAM_BASE || 'https://21media-mam.vercel.app').replace(/\/$/, '');
const SECRET = process.env.BUFFER_PUSH_SECRET;
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_KEY = process.env.MAM_SUPABASE_SERVICE_ROLE_KEY;
const REQUESTED_JOB_ID = (process.env.JOB_ID || '').trim();
const KAGGLE_TOKEN = (process.env.KAGGLE_API_TOKEN || '').trim();
const MUSETALK_WORKER = (process.env.MUSETALK_KAGGLE_WORKER || '').trim();
const BUCKET = 'reaction-media';
const FPS = 30;
const CROSSFADE = 0.16;

if (!SECRET) throw new Error('BUFFER_PUSH_SECRET missing');
if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('SUPABASE_URL / MAM_SUPABASE_SERVICE_ROLE_KEY missing');

const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'reaction-v2-'));
const cacheDir = path.join(workDir, 'cache');
await fs.mkdir(cacheDir, { recursive: true });

function log(...args) { console.log('[reaction-render-v2]', ...args); }
function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function run(bin, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', d => { stdout += d.toString(); });
    child.stderr?.on('data', d => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${bin} exited ${code}\n${stderr.slice(-6000)}\n${stdout.slice(-3000)}`));
    });
  });
}

async function api(route, { method = 'GET', body } = {}) {
  const headers = { Authorization: `Bearer ${SECRET}` };
  let payload;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const response = await fetch(`${MAM_BASE}${route}`, { method, headers, body: payload });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!response.ok) throw new Error(`${method} ${route} -> ${response.status}: ${JSON.stringify(data)}`);
  return data;
}

async function progress(jobId, currentStage, renderMetaPatch = {}) {
  try {
    await api('/api/reaction/progress', {
      method: 'POST',
      body: { job_id: jobId, status: 'rendering', current_stage: currentStage, render_meta_patch: renderMetaPatch },
    });
  } catch (error) {
    log('Progress update failed:', error instanceof Error ? error.message : String(error));
  }
}

async function download(url, dest) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`download ${url} -> HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(dest, bytes);
  return dest;
}

async function cachedDownload(url, extension = '.mp4') {
  const key = crypto.createHash('sha1').update(url).digest('hex');
  const dest = path.join(cacheDir, `${key}${extension}`);
  try { await fs.access(dest); return dest; } catch {}
  return download(url, dest);
}

async function probeDuration(file) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file]);
  const value = Number(stdout.trim());
  if (!Number.isFinite(value) || value <= 0) throw new Error(`Could not probe duration: ${file}`);
  return value;
}

async function hasAudio(file) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=index', '-of', 'csv=p=0', file]);
  return !!stdout.trim();
}

async function findFile(root, targetName) {
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isFile() && entry.name === targetName) return full;
    if (entry.isDirectory()) {
      const nested = await findFile(full, targetName).catch(() => null);
      if (nested) return nested;
    }
  }
  return null;
}

function chooseAsset(assets, type, intensity = 0.35) {
  const candidates = assets.filter(asset => asset.enabled !== false && asset.reaction_type === type);
  if (!candidates.length) return null;
  return [...candidates].sort((a, b) => {
    const amid = (Number(a.intensity_min ?? 0) + Number(a.intensity_max ?? 1)) / 2;
    const bmid = (Number(b.intensity_min ?? 0) + Number(b.intensity_max ?? 1)) / 2;
    return Math.abs(amid - intensity) - Math.abs(bmid - intensity);
  })[0];
}

function fallbackType(requested, available) {
  if (available.has(requested)) return requested;
  const preferences = {
    laugh: ['smirk', 'cringe', 'neutral'],
    disbelief: ['cringe', 'smirk', 'neutral'],
    suspicious: ['cringe', 'neutral', 'smirk'],
    surprise: ['cringe', 'neutral', 'smirk'],
    comment: ['neutral', 'smirk', 'cringe'],
  };
  for (const type of preferences[requested] || ['neutral']) if (available.has(type)) return type;
  return 'neutral';
}

function adaptPlan(plan, assets, request) {
  const available = new Set(assets.filter(asset => asset.enabled !== false).map(asset => String(asset.reaction_type)));
  const voiceEnabled = request.voice_lipsync === true;
  const maxVoiceComments = voiceEnabled ? Math.max(0, Number(request.max_voice_comments ?? 1)) : 0;
  let keptComments = 0;
  const events = [...(Array.isArray(plan?.events) ? plan.events : [])]
    .filter(event => Number.isFinite(Number(event?.time)))
    .sort((a, b) => Number(a.time) - Number(b.time))
    .map(event => {
      const requestedType = String(event.type || 'neutral');
      const type = fallbackType(requestedType, available);
      let comment = typeof event.comment === 'string' ? event.comment.trim() : '';
      if (!voiceEnabled || !comment || keptComments >= maxVoiceComments) comment = '';
      if (comment) keptComments += 1;
      return { ...event, type, comment: comment || undefined, mapped_from_type: type !== requestedType ? requestedType : undefined };
    });
  return { ...plan, events };
}

function neutralChunks(start, end, neutralAssets, state) {
  const output = [];
  let cursor = start;
  while (end - cursor > 0.04) {
    const duration = Math.min(end - cursor, 10.5);
    const asset = neutralAssets[state.index % neutralAssets.length];
    state.index += 1;
    output.push({ start: cursor, duration, asset, kind: 'neutral' });
    cursor += duration;
  }
  return output;
}

async function createTts(text, index) {
  const result = await api('/api/reaction/tts', { method: 'POST', body: { text } });
  const audioUrl = String(result.audio_url || '');
  if (!audioUrl) throw new Error('TTS returned no audio URL');
  const local = path.join(workDir, `comment-${index}.mp3`);
  await download(audioUrl, local);
  return { audioUrl, local, duration: await probeDuration(local) };
}

async function kaggleLipSync({ jobId, index, videoUrl, audioUrl, kaggleUsername }) {
  if (!KAGGLE_TOKEN) throw new Error('KAGGLE_API_TOKEN missing in lm-render GitHub secrets');
  if (!kaggleUsername) throw new Error('Kaggle username missing from render request');
  if (!MUSETALK_WORKER) throw new Error('MUSETALK_KAGGLE_WORKER missing');
  try { await fs.access(MUSETALK_WORKER); } catch { throw new Error(`MuseTalk Kaggle worker not found: ${MUSETALK_WORKER}`); }

  const slug = `reaction-lipsync-${jobId.slice(0, 8)}-${Date.now().toString(36)}-${index}`.toLowerCase();
  const kernel = `${kaggleUsername}/${slug}`;
  const dir = path.join(workDir, `kaggle-${index}`);
  const outDir = path.join(dir, 'output');
  await fs.mkdir(dir, { recursive: true });
  await fs.mkdir(outDir, { recursive: true });
  await fs.copyFile(MUSETALK_WORKER, path.join(dir, 'musetalk_lipsync.py'));
  await fs.writeFile(path.join(dir, 'job.json'), JSON.stringify({ video_url: videoUrl, audio_url: audioUrl, bbox_shift: 0 }, null, 2));
  await fs.writeFile(path.join(dir, 'kernel-metadata.json'), JSON.stringify({
    id: kernel,
    title: `Reaction Lip Sync ${jobId.slice(0, 8)} ${index}`,
    code_file: 'musetalk_lipsync.py',
    language: 'python',
    kernel_type: 'script',
    is_private: true,
    enable_gpu: true,
    enable_tpu: false,
    enable_internet: true,
    dataset_sources: [], kernel_sources: [], competition_sources: [],
  }, null, 2));

  log(`Starting Kaggle MuseTalk kernel ${kernel}`);
  let pushed = false;
  try {
    try {
      await run('kaggle', ['kernels', 'push', '-p', dir, '--accelerator', 'NvidiaTeslaP100', '--timeout', '1200']);
    } catch (p100Error) {
      log('P100 push failed; retrying with T4:', p100Error instanceof Error ? p100Error.message : String(p100Error));
      await run('kaggle', ['kernels', 'push', '-p', dir, '--accelerator', 'NvidiaTeslaT4', '--timeout', '1200']);
    }
    pushed = true;
    let complete = false;
    for (let attempt = 1; attempt <= 100; attempt++) {
      const { stdout, stderr } = await run('kaggle', ['kernels', 'status', kernel]);
      const status = `${stdout}\n${stderr}`.trim();
      log(`Kaggle [${attempt}/100] ${status.replace(/\s+/g, ' ').slice(0, 500)}`);
      const lower = status.toLowerCase();
      if (/complete|success/.test(lower)) { complete = true; break; }
      if (/error|failed|cancel/.test(lower)) throw new Error(`Kaggle MuseTalk failed: ${status.slice(-1500)}`);
      await sleep(15000);
    }
    if (!complete) throw new Error('Timed out waiting for Kaggle MuseTalk');
    await run('kaggle', ['kernels', 'output', kernel, '-p', outDir, '-o', '--file-pattern', '.*lipsync-result\\.(mp4|json)$']);
    const result = await findFile(outDir, 'lipsync-result.mp4');
    if (!result) throw new Error('Kaggle MuseTalk completed but no lipsync-result.mp4 was downloaded');
    const local = path.join(workDir, `lipsync-${index}.mp4`);
    await fs.copyFile(result, local);
    return { local, provider: 'musetalk_kaggle', kernel };
  } finally {
    if (pushed) {
      try { await run('kaggle', ['kernels', 'delete', kernel, '-y']); }
      catch (error) { log('Kaggle kernel cleanup skipped:', error instanceof Error ? error.message : String(error)); }
    }
  }
}

async function buildTimeline({ plan, assets, totalDuration, request, jobId, kaggleUsername }) {
  const neutralAssets = assets.filter(asset => asset.enabled !== false && asset.reaction_type === 'neutral');
  if (!neutralAssets.length) throw new Error('No enabled neutral reaction asset');
  const neutralState = { index: 0 };
  const segments = [];
  const comments = [];
  let cursor = 0;
  for (const event of plan.events || []) {
    let start = clamp(Number(event.time), 0, Math.max(0, totalDuration - 0.1));
    if (start < cursor + 0.08) start = cursor + 0.08;
    if (start >= totalDuration - 0.05) break;
    if (start > cursor) segments.push(...neutralChunks(cursor, start, neutralAssets, neutralState));
    const asset = chooseAsset(assets, String(event.type), Number(event.intensity ?? 0.35)) || neutralAssets[neutralState.index++ % neutralAssets.length];
    const hasComment = request.voice_lipsync === true && typeof event.comment === 'string' && event.comment.trim().length > 0;
    let duration = clamp(Number(event.duration ?? 2.4), 0.8, 8);
    let localOverride = null;
    if (hasComment) {
      await progress(jobId, 'tts_generating', { active_comment: event.comment.trim() });
      const tts = await createTts(event.comment.trim(), comments.length);
      duration = clamp(Math.max(duration, tts.duration + 0.3), 1.2, 8);
      await progress(jobId, 'lipsync_kaggle_running', { lipsync_provider: 'musetalk_kaggle' });
      const synced = await kaggleLipSync({ jobId, index: comments.length, videoUrl: asset.video_url, audioUrl: tts.audioUrl, kaggleUsername });
      localOverride = synced.local;
      comments.push({ start, text: event.comment.trim(), audioUrl: tts.audioUrl, local: tts.local, duration: tts.duration, lipsync_provider: synced.provider });
    }
    duration = Math.min(duration, totalDuration - start);
    segments.push({ start, duration, asset, localOverride, kind: hasComment ? 'comment' : 'reaction', event });
    cursor = start + duration;
  }
  if (cursor < totalDuration) segments.push(...neutralChunks(cursor, totalDuration, neutralAssets, neutralState));
  if (!segments.length) segments.push(...neutralChunks(0, totalDuration, neutralAssets, neutralState));
  return { segments, comments };
}

async function renderSegment(segment, index) {
  const source = segment.localOverride || await cachedDownload(segment.asset.video_url, segment.asset.video_url.toLowerCase().includes('.webm') ? '.webm' : '.mp4');
  const out = path.join(workDir, `segment-${String(index).padStart(3, '0')}.mp4`);
  const duration = Math.max(0.12, Number(segment.duration));
  const inputArgs = segment.kind === 'neutral' ? ['-stream_loop', '-1', '-i', source] : ['-i', source];
  const filter = segment.kind === 'neutral'
    ? `fps=${FPS},scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2:color=black,trim=duration=${duration.toFixed(3)},setpts=PTS-STARTPTS`
    : `fps=${FPS},scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2:color=black,tpad=stop_mode=clone:stop_duration=10,trim=duration=${duration.toFixed(3)},setpts=PTS-STARTPTS`;
  await run('ffmpeg', ['-y', ...inputArgs, '-an', '-vf', filter, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', out]);
  return out;
}

async function crossfadeSegments(segmentFiles, durations, totalDuration) {
  if (segmentFiles.length === 1) return segmentFiles[0];
  const out = path.join(workDir, 'avatar-track.mp4');
  const args = ['-y'];
  for (const file of segmentFiles) args.push('-i', file);
  let filter = '';
  let cumulative = Number(durations[0]);
  let previousLabel = '0:v';
  for (let i = 1; i < segmentFiles.length; i++) {
    const fade = Math.min(CROSSFADE, durations[i - 1] / 3, durations[i] / 3);
    const offset = Math.max(0.01, cumulative - fade);
    const outputLabel = `x${i}`;
    filter += `[${previousLabel}][${i}:v]xfade=transition=fade:duration=${fade.toFixed(3)}:offset=${offset.toFixed(3)}[${outputLabel}];`;
    cumulative += Number(durations[i]) - fade;
    previousLabel = outputLabel;
  }
  filter += `[${previousLabel}]tpad=stop_mode=clone:stop_duration=5,trim=duration=${totalDuration.toFixed(3)},setpts=PTS-STARTPTS[avatar]`;
  args.push('-filter_complex', filter, '-map', '[avatar]', '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', out);
  await run('ffmpeg', args);
  return out;
}

async function composeFinal(source, avatarTrack, comments, totalDuration, sourceHasAudio, avatarMode) {
  const out = path.join(workDir, 'final.mp4');
  const args = ['-y', '-i', source, '-i', avatarTrack];
  for (const comment of comments) args.push('-i', comment.local);
  const filters = [
    '[0:v]split=2[srcbg][srcfg]',
    '[srcbg]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,gblur=sigma=30,eq=brightness=-0.16[bg]',
    '[srcfg]scale=1080:1920:force_original_aspect_ratio=decrease[fg]',
    '[bg][fg]overlay=(W-w)/2:(H-h)/2[base]',
  ];
  if (avatarMode === 'chroma') {
    filters.push('[1:v]chromakey=0x00FF00:0.20:0.08,format=rgba,scale=600:-2[avatar]');
    filters.push('[base][avatar]overlay=W-w-18:H-h-8:format=auto[vout]');
  } else {
    filters.push('[1:v]scale=390:-2:flags=lanczos,pad=iw+10:ih+10:5:5:color=0x151515[pip]');
    filters.push('[base][pip]overlay=W-w-24:H-h-24:format=auto[vout]');
  }
  let audioMap = null;
  if (comments.length) {
    const labels = [];
    comments.forEach((comment, index) => {
      const inputIndex = 2 + index;
      const delay = Math.max(0, Math.round(comment.start * 1000));
      const label = `c${index}`;
      filters.push(`[${inputIndex}:a]aresample=48000,volume=1.10,adelay=${delay}|${delay}[${label}]`);
      labels.push(`[${label}]`);
    });
    if (labels.length === 1) filters.push(`${labels[0]}anull[voice]`);
    else filters.push(`${labels.join('')}amix=inputs=${labels.length}:duration=longest:normalize=0[voice]`);
    if (sourceHasAudio) {
      filters.push('[0:a]aresample=48000[srca]');
      filters.push('[srca][voice]sidechaincompress=threshold=0.02:ratio=8:attack=8:release=220[ducked]');
      filters.push('[ducked][voice]amix=inputs=2:duration=longest:normalize=0[aout]');
      audioMap = '[aout]';
    } else audioMap = '[voice]';
  }
  args.push('-filter_complex', filters.join(';'), '-map', '[vout]');
  if (audioMap) args.push('-map', audioMap); else if (sourceHasAudio) args.push('-map', '0:a:0');
  args.push('-t', totalDuration.toFixed(3), '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p');
  if (audioMap || sourceHasAudio) args.push('-c:a', 'aac', '-b:a', '160k');
  args.push('-movflags', '+faststart', out);
  await run('ffmpeg', args);
  return out;
}

async function uploadResult(jobId, file) {
  const storagePath = `results/${jobId}.mp4`;
  const bytes = await fs.readFile(file);
  const response = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${storagePath}`, {
    method: 'POST',
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'video/mp4', 'x-upsert': 'true' },
    body: bytes,
  });
  if (!response.ok) throw new Error(`Supabase result upload failed: ${response.status} ${await response.text()}`);
  return { path: storagePath, url: `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${storagePath}` };
}

let claimedJob = null;
try {
  const claim = await api('/api/reaction/claim', { method: 'POST', body: REQUESTED_JOB_ID ? { job_id: REQUESTED_JOB_ID } : {} });
  if (!claim?.job) { log('No queued reaction job; exiting cleanly.'); process.exit(0); }
  claimedJob = claim.job;
  const assets = claim.assets || [];
  const request = claimedJob.render_meta?.render_request || {};
  const avatarMode = request.avatar_mode === 'chroma' ? 'chroma' : 'pip';
  const kaggleUsername = String(request.kaggle_username || '').trim();
  if (!claimedJob.reaction_plan || typeof claimedJob.reaction_plan !== 'object') throw new Error('Queued render job has no saved reaction_plan');
  if (!assets.some(asset => asset.enabled !== false && asset.reaction_type === 'neutral')) throw new Error('No enabled neutral avatar asset');

  await progress(claimedJob.id, 'render_preparing', { renderer: 'lm-render/github-actions-v2', avatar_mode: avatarMode, voice_lipsync: request.voice_lipsync === true });
  const source = path.join(workDir, 'source.mp4');
  await download(claimedJob.source_url, source);
  const duration = await probeDuration(source);
  const sourceHasAudio = await hasAudio(source);
  log(`Claimed ${claimedJob.id}; duration=${duration.toFixed(2)}s; assets=${assets.length}; audio=${sourceHasAudio}`);
  const plan = adaptPlan(claimedJob.reaction_plan, assets, request);
  await progress(claimedJob.id, 'timeline_building', { adapted_event_count: plan.events?.length || 0, planned_voice_comments: (plan.events || []).filter(event => event.comment).length });
  const { segments, comments } = await buildTimeline({ plan, assets, totalDuration: duration, request, jobId: claimedJob.id, kaggleUsername });
  await progress(claimedJob.id, 'avatar_rendering', { segment_count: segments.length, comment_count: comments.length });
  const rendered = [];
  for (let i = 0; i < segments.length; i++) rendered.push(await renderSegment(segments[i], i));
  const avatarTrack = await crossfadeSegments(rendered, segments.map(segment => segment.duration), duration);
  await progress(claimedJob.id, 'compositing');
  const final = await composeFinal(source, avatarTrack, comments, duration, sourceHasAudio, avatarMode);
  await progress(claimedJob.id, 'result_uploading');
  const uploaded = await uploadResult(claimedJob.id, final);
  const renderMeta = {
    ...(claimedJob.render_meta || {}), renderer: 'lm-render/github-actions-v2', duration_s: Number(duration.toFixed(3)), avatar_mode: avatarMode,
    source_analysis_mode: claimedJob.render_meta?.source_analysis_mode || 'saved_preview_plan', event_count: plan.events?.length || 0,
    segment_count: segments.length, comment_count: comments.length, lipsync_provider: comments.length ? 'musetalk_kaggle' : null,
    lipsync_skipped_count: 0, comments: comments.map(comment => ({ start: comment.start, text: comment.text, duration: comment.duration, lipsync_skipped: false, lipsync_provider: comment.lipsync_provider })), adapted_plan: plan,
  };
  await api('/api/reaction/complete', { method: 'POST', body: { job_id: claimedJob.id, status: 'completed', result_url: uploaded.url, result_path: uploaded.path, render_meta: renderMeta } });
  log(`Completed ${claimedJob.id}: ${uploaded.url}`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error('[reaction-render-v2] FAILED', message);
  if (claimedJob?.id) {
    try {
      await api('/api/reaction/complete', { method: 'POST', body: { job_id: claimedJob.id, status: 'failed', error: message.slice(0, 4000), render_meta: { ...(claimedJob.render_meta || {}), renderer: 'lm-render/github-actions-v2', failed_stage: 'render' } } });
    } catch (reportError) { console.error('[reaction-render-v2] Failed to report job failure', reportError); }
  }
  process.exitCode = 1;
} finally {
  try { await fs.rm(workDir, { recursive: true, force: true }); } catch {}
}
