import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';

const MAM_BASE = (process.env.MAM_BASE || 'https://21media-mam.vercel.app').replace(/\/$/, '');
const SECRET = String(process.env.BUFFER_PUSH_SECRET || '');
const SUPABASE_URL = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_KEY = String(process.env.MAM_SUPABASE_SERVICE_ROLE_KEY || '');
const REQUESTED_JOB_ID = String(process.env.JOB_ID || '').trim();
const HF_MUSETALK_WORKER = String(process.env.HF_MUSETALK_WORKER || '').trim();
const FORCE_REQUEUE = process.env.FORCE_REQUEUE === '1';
const BUCKET = 'reaction-media';
const FPS = 30;
const CROSSFADE = 0.16;

if (!SECRET) throw new Error('BUFFER_PUSH_SECRET missing');
if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('SUPABASE_URL / MAM_SUPABASE_SERVICE_ROLE_KEY missing');
if (!HF_MUSETALK_WORKER) throw new Error('HF_MUSETALK_WORKER missing');

const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'reaction-v4-'));
const cacheDir = path.join(workDir, 'cache');
await fs.mkdir(cacheDir, { recursive: true });

function log(...args) { console.log('[reaction-render-v4]', ...args); }
function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }

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
      else reject(new Error(`${bin} exited ${code}\n${stderr.slice(-9000)}\n${stdout.slice(-3000)}`));
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

async function forceRequeue(jobId) {
  if (!jobId) return;
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
      current_stage: 'render_requeued_v4',
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
  log(`Requeued ${jobId}`);
}

async function download(url, dest) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`download ${url} -> HTTP ${response.status}`);
  await fs.writeFile(dest, Buffer.from(await response.arrayBuffer()));
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

async function probeJson(file) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]);
  return JSON.parse(stdout);
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
    const seed = state.index;
    state.index += 1;
    output.push({ start: cursor, duration, asset, kind: 'neutral', seed });
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

async function hfMuseTalkLipSync({ index, videoUrl, audioUrl, minDuration }) {
  try { await fs.access(HF_MUSETALK_WORKER); } catch { throw new Error(`HF MuseTalk worker not found: ${HF_MUSETALK_WORKER}`); }
  const local = path.join(workDir, `lipsync-hf-${index}.mp4`);
  const result = await run('python', [
    HF_MUSETALK_WORKER,
    '--video-url', videoUrl,
    '--audio-url', audioUrl,
    '--output', local,
    '--space', 'trymonolith/MuseTalk',
    '--quality', 'Medium',
    '--fps', '30',
  ]);
  log('HF MuseTalk:', String(result.stdout || '').trim().slice(-1800));
  const stat = await fs.stat(local).catch(() => null);
  if (!stat || stat.size < 20_000) throw new Error('MuseTalk returned no usable MP4');
  const duration = await probeDuration(local);
  if (duration < Math.min(0.75, Math.max(0.35, minDuration * 0.55))) {
    throw new Error(`MuseTalk output is too short (${duration.toFixed(2)}s)`);
  }
  return { local, provider: 'huggingface_public_musetalk', space: 'trymonolith/MuseTalk', bytes: stat.size, duration };
}

async function buildTimeline({ plan, assets, totalDuration, request, jobId }) {
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
    let lipsyncMeta = null;

    if (hasComment) {
      await progress(jobId, 'tts_generating', { active_comment: event.comment.trim(), absolute_start_s: start });
      const tts = await createTts(event.comment.trim(), comments.length);
      duration = clamp(Math.max(duration, tts.duration + 0.35), 1.2, 8);
      await progress(jobId, 'lipsync_hf_running', {
        lipsync_provider: 'huggingface_public_musetalk',
        lipsync_space: 'trymonolith/MuseTalk',
        absolute_start_s: start,
      });
      const synced = await hfMuseTalkLipSync({ index: comments.length, videoUrl: asset.video_url, audioUrl: tts.audioUrl, minDuration: tts.duration });
      localOverride = synced.local;
      lipsyncMeta = synced;
      comments.push({
        start,
        text: event.comment.trim(),
        audioUrl: tts.audioUrl,
        local: tts.local,
        duration: tts.duration,
        lipsync_provider: synced.provider,
        lipsync_duration: synced.duration,
      });
    }

    duration = Math.min(duration, totalDuration - start);
    segments.push({ start, duration, asset, localOverride, kind: hasComment ? 'comment' : 'reaction', event, lipsyncMeta });
    cursor = start + duration;
  }

  if (cursor < totalDuration) segments.push(...neutralChunks(cursor, totalDuration, neutralAssets, neutralState));
  if (!segments.length) segments.push(...neutralChunks(0, totalDuration, neutralAssets, neutralState));
  return { segments, comments };
}

function transitionFades(segments) {
  const fades = [];
  for (let i = 0; i < segments.length - 1; i++) {
    fades.push(Math.min(CROSSFADE, Number(segments[i].duration) / 3, Number(segments[i + 1].duration) / 3));
  }
  return fades;
}

async function renderSegment(segment, index, tailDuration) {
  const source = segment.localOverride || await cachedDownload(segment.asset.video_url, segment.asset.video_url.toLowerCase().includes('.webm') ? '.webm' : '.mp4');
  const out = path.join(workDir, `segment-${String(index).padStart(3, '0')}.mp4`);
  const renderDuration = Math.max(0.12, Number(segment.duration) + Number(tailDuration || 0));
  const inputArgs = segment.kind === 'neutral' ? ['-stream_loop', '-1', '-i', source] : ['-i', source];
  const fill = 'fps=30,scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280';
  const tail = segment.kind === 'neutral' ? '' : ',tpad=stop_mode=clone:stop_duration=10';
  const filter = `${fill}${tail},trim=duration=${renderDuration.toFixed(3)},setpts=PTS-STARTPTS`;
  await run('ffmpeg', ['-y', ...inputArgs, '-an', '-vf', filter, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', out]);
  return { file: out, renderDuration };
}

async function crossfadeSegments(rendered, segments, fades, totalDuration) {
  if (rendered.length === 1) return rendered[0].file;
  const out = path.join(workDir, 'avatar-track.mp4');
  const args = ['-y'];
  for (const item of rendered) args.push('-i', item.file);

  let filter = '';
  let cumulative = rendered[0].renderDuration;
  let previousLabel = '0:v';
  for (let i = 1; i < rendered.length; i++) {
    const fade = fades[i - 1];
    const offset = Math.max(0.001, cumulative - fade);
    const outputLabel = `x${i}`;
    filter += `[${previousLabel}][${i}:v]xfade=transition=fade:duration=${fade.toFixed(3)}:offset=${offset.toFixed(3)}[${outputLabel}];`;
    cumulative += rendered[i].renderDuration - fade;
    previousLabel = outputLabel;
  }
  filter += `[${previousLabel}]trim=duration=${totalDuration.toFixed(3)},setpts=PTS-STARTPTS[avatar]`;
  args.push('-filter_complex', filter, '-map', '[avatar]', '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', out);
  await run('ffmpeg', args);

  const producedDuration = await probeDuration(out);
  if (Math.abs(producedDuration - totalDuration) > 0.12) {
    throw new Error(`Avatar timeline drifted: expected ${totalDuration.toFixed(3)}s, got ${producedDuration.toFixed(3)}s`);
  }
  return out;
}

async function composeFinal(source, avatarTrack, comments, totalDuration, sourceHasAudio) {
  const out = path.join(workDir, 'final.mp4');
  const args = ['-y', '-i', source, '-i', avatarTrack];
  for (const comment of comments) args.push('-i', comment.local);

  const filters = [
    '[0:v]split=2[srcbg][srcfg]',
    '[srcbg]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,gblur=sigma=28,eq=brightness=-0.13[bg]',
    '[srcfg]scale=1080:1920:force_original_aspect_ratio=decrease[fg]',
    '[bg][fg]overlay=(W-w)/2:(H-h)/2[base]',
    '[1:v]chromakey=0x00FF00:0.20:0.08,format=rgba,scale=620:-2:flags=lanczos[avatar]',
    '[base][avatar]overlay=W-w-20:H-h-12:format=auto[vout]',
  ];

  let audioMap = null;
  if (comments.length) {
    const labels = [];
    comments.forEach((comment, index) => {
      const inputIndex = 2 + index;
      const delay = Math.max(0, Math.round(comment.start * 1000));
      const label = `c${index}`;
      filters.push(`[${inputIndex}:a]aresample=48000,volume=1.08,adelay=delays=${delay}:all=1,apad=whole_dur=${totalDuration.toFixed(3)},atrim=duration=${totalDuration.toFixed(3)}[${label}]`);
      labels.push(`[${label}]`);
    });
    if (labels.length === 1) filters.push(`${labels[0]}anull[voice]`);
    else filters.push(`${labels.join('')}amix=inputs=${labels.length}:duration=first:normalize=0[voice]`);

    if (sourceHasAudio) {
      filters.push(`[0:a]aresample=48000,apad=whole_dur=${totalDuration.toFixed(3)},atrim=duration=${totalDuration.toFixed(3)}[srca]`);
      filters.push('[voice]asplit=2[voice_sc][voice_mix]');
      filters.push('[srca][voice_sc]sidechaincompress=threshold=0.02:ratio=6:attack=12:release=300[ducked]');
      filters.push('[ducked][voice_mix]amix=inputs=2:duration=first:normalize=0[aout]');
      audioMap = '[aout]';
    } else {
      audioMap = '[voice]';
    }
  }

  args.push('-filter_complex', filters.join(';'), '-map', '[vout]');
  if (audioMap) args.push('-map', audioMap);
  else if (sourceHasAudio) args.push('-map', '0:a:0');
  args.push('-t', totalDuration.toFixed(3), '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p');
  if (audioMap || sourceHasAudio) args.push('-c:a', 'aac', '-b:a', '160k', '-ar', '48000');
  args.push('-movflags', '+faststart', out);
  await run('ffmpeg', args);
  return out;
}

async function validateFinal(file, expectedDuration, expectAudio) {
  const data = await probeJson(file);
  const duration = Number(data?.format?.duration || 0);
  const video = (data.streams || []).find(stream => stream.codec_type === 'video');
  const audio = (data.streams || []).find(stream => stream.codec_type === 'audio');
  if (!video) throw new Error('Final validation: video stream missing');
  if (Number(video.width) !== 1080 || Number(video.height) !== 1920) throw new Error(`Final validation: expected 1080x1920, got ${video.width}x${video.height}`);
  if (Math.abs(duration - expectedDuration) > 0.35) throw new Error(`Final validation: duration mismatch ${duration.toFixed(3)} vs ${expectedDuration.toFixed(3)}`);
  if (expectAudio && !audio) throw new Error('Final validation: audio stream missing');
  if (expectAudio) {
    const audioDuration = Number(audio.duration || duration);
    if (Number.isFinite(audioDuration) && audioDuration < expectedDuration - 0.5) {
      throw new Error(`Final validation: audio ends early at ${audioDuration.toFixed(3)}s / ${expectedDuration.toFixed(3)}s`);
    }
  }
  return {
    duration_s: duration,
    width: Number(video.width),
    height: Number(video.height),
    video_codec: video.codec_name,
    audio_codec: audio?.codec_name || null,
    audio_duration_s: audio ? Number(audio.duration || duration) : null,
  };
}

async function uploadResult(jobId, file) {
  const storagePath = `results/${jobId}.mp4`;
  const bytes = await fs.readFile(file);
  const response = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${storagePath}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'video/mp4',
      'x-upsert': 'true',
    },
    body: bytes,
  });
  if (!response.ok) throw new Error(`Supabase result upload failed: ${response.status} ${await response.text()}`);
  return { path: storagePath, url: `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${storagePath}` };
}

if (FORCE_REQUEUE && REQUESTED_JOB_ID) await forceRequeue(REQUESTED_JOB_ID);

let claimedJob = null;
try {
  const claim = await api('/api/reaction/claim', { method: 'POST', body: REQUESTED_JOB_ID ? { job_id: REQUESTED_JOB_ID } : {} });
  if (!claim?.job) {
    log('No queued reaction job; exiting cleanly.');
    process.exit(0);
  }

  claimedJob = claim.job;
  const assets = claim.assets || [];
  const request = claimedJob.render_meta?.render_request || {};
  if (!claimedJob.reaction_plan || typeof claimedJob.reaction_plan !== 'object') throw new Error('Queued render job has no saved reaction_plan');
  if (!assets.some(asset => asset.enabled !== false && asset.reaction_type === 'neutral')) throw new Error('No enabled neutral avatar asset');

  await progress(claimedJob.id, 'render_preparing', {
    renderer: 'lm-render/github-actions-v4',
    avatar_mode: 'chroma',
    voice_lipsync: request.voice_lipsync === true,
    timeline_clock: 'absolute_preserved_xfade_v1',
  });

  const source = path.join(workDir, 'source.mp4');
  await download(claimedJob.source_url, source);
  const duration = await probeDuration(source);
  const sourceHasAudio = await hasAudio(source);
  log(`Claimed ${claimedJob.id}; duration=${duration.toFixed(2)}s; assets=${assets.length}; audio=${sourceHasAudio}`);

  const plan = adaptPlan(claimedJob.reaction_plan, assets, request);
  await progress(claimedJob.id, 'timeline_building', {
    adapted_event_count: plan.events?.length || 0,
    planned_voice_comments: (plan.events || []).filter(event => event.comment).length,
  });

  const { segments, comments } = await buildTimeline({ plan, assets, totalDuration: duration, request, jobId: claimedJob.id });
  const fades = transitionFades(segments);
  await progress(claimedJob.id, 'avatar_rendering', {
    segment_count: segments.length,
    comment_count: comments.length,
    transition_count: fades.length,
  });

  const rendered = [];
  for (let i = 0; i < segments.length; i++) {
    rendered.push(await renderSegment(segments[i], i, fades[i] || 0));
  }
  const avatarTrack = await crossfadeSegments(rendered, segments, fades, duration);

  await progress(claimedJob.id, 'compositing', {
    avatar_mode: 'chroma',
    source_audio_preserved: sourceHasAudio,
  });
  const final = await composeFinal(source, avatarTrack, comments, duration, sourceHasAudio);
  const validation = await validateFinal(final, duration, sourceHasAudio || comments.length > 0);

  await progress(claimedJob.id, 'result_uploading', { final_validation: validation });
  const uploaded = await uploadResult(claimedJob.id, final);

  const renderMeta = {
    ...(claimedJob.render_meta || {}),
    renderer: 'lm-render/github-actions-v4',
    duration_s: Number(duration.toFixed(3)),
    avatar_mode: 'chroma',
    source_analysis_mode: claimedJob.render_meta?.source_analysis_mode || 'saved_preview_plan',
    event_count: plan.events?.length || 0,
    segment_count: segments.length,
    transition_count: fades.length,
    comment_count: comments.length,
    lipsync_provider: comments.length ? 'huggingface_public_musetalk' : null,
    timeline_clock: 'absolute_preserved_xfade_v1',
    audio_mix: 'full_duration_padded_sidechain_v1',
    final_validation: validation,
    comments: comments.map(comment => ({
      start: comment.start,
      text: comment.text,
      duration: comment.duration,
      lipsync_provider: comment.lipsync_provider,
      lipsync_duration: comment.lipsync_duration,
    })),
    adapted_plan: plan,
  };

  await api('/api/reaction/complete', {
    method: 'POST',
    body: {
      job_id: claimedJob.id,
      status: 'completed',
      result_url: uploaded.url,
      result_path: uploaded.path,
      render_meta: renderMeta,
    },
  });
  log(`Completed ${claimedJob.id}: ${uploaded.url}`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error('[reaction-render-v4] FAILED', message);
  if (claimedJob?.id) {
    try {
      await api('/api/reaction/complete', {
        method: 'POST',
        body: {
          job_id: claimedJob.id,
          status: 'failed',
          error: message.slice(0, 4000),
          render_meta: {
            ...(claimedJob.render_meta || {}),
            renderer: 'lm-render/github-actions-v4',
            failed_stage: 'render',
          },
        },
      });
    } catch (reportError) {
      console.error('[reaction-render-v4] Failed to report job failure', reportError);
    }
  }
  process.exitCode = 1;
} finally {
  try { await fs.rm(workDir, { recursive: true, force: true }); } catch {}
}
