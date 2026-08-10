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
const OUT_W = 1080;
const OUT_H = 1920;

// Persona assets are 16:9 green screen; the final product is 9:16. The avatar
// frame is scaled as a whole and pinned flush to the bottom-right corner, so the
// subject — who sits on the right of his reference frame with his body running
// off the right and bottom edges — lands in the corner with those cut edges
// hidden by the canvas edges. The empty green left half keys out to nothing.
const AVATAR_H = 620;
const AVATAR_W = Math.round((AVATAR_H * 16) / 9 / 2) * 2;

// Silence wrapped around every TTS line. It makes the lip-sync model produce a
// closed mouth at both ends of the speech segment, which is what makes the cut
// into and out of a speech carrier invisible, and it doubles as a breath-in.
const SPEECH_PAD_S = 0.3;

// `node render-v4.mjs --calibrate <file|url>` reports the chroma key it would
// use for an asset and exits. Useful for QC on a new persona plate, and it needs
// none of the job credentials.
const CALIBRATE_TARGET = process.argv[2] === '--calibrate' ? String(process.argv[3] || '').trim() : '';

if (!CALIBRATE_TARGET) {
  if (!SECRET) throw new Error('BUFFER_PUSH_SECRET missing');
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('SUPABASE_URL / MAM_SUPABASE_SERVICE_ROLE_KEY missing');
  if (!HF_MUSETALK_WORKER) throw new Error('HF_MUSETALK_WORKER missing');
}

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

async function uploadToBucket(localFile, storagePath, contentType) {
  const bytes = await fs.readFile(localFile);
  const response = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${storagePath}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': contentType,
      'x-upsert': 'true',
    },
    body: bytes,
  });
  if (!response.ok) throw new Error(`Supabase upload failed (${storagePath}): ${response.status} ${await response.text()}`);
  return { path: storagePath, url: `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${storagePath}` };
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

async function ffmpegHasFilter(name) {
  try {
    const { stdout } = await run('ffmpeg', ['-hide_banner', '-filters']);
    return new RegExp(`\\s${name}\\s`).test(stdout);
  } catch { return false; }
}

// The green in a generated studio plate is never 0x00FF00. Keying against a
// hard-coded pure green either leaves a green rim or eats hair edges, so the key
// colour is read from the plate itself.
// Sampling a corner reads the darkest, most vignetted part of the plate and
// produces a key colour the rest of the frame does not match. The median of
// every greenish cell is immune both to vignetting and to the subject.
async function sampleBackgroundColour(file) {
  const grid = await alphaGrid(file, 'null');
  const greens = [];
  for (let i = 0; i < GRID_W * GRID_H; i++) {
    const r = grid[i * 4];
    const g = grid[i * 4 + 1];
    const b = grid[i * 4 + 2];
    if (g > r + 12 && g > b + 12) greens.push([r, g, b]);
  }
  if (greens.length < 20) throw new Error('Could not find a green plate in the avatar asset');
  const median = channel => {
    const values = greens.map(rgb => rgb[channel]).sort((a, b) => a - b);
    return values[Math.floor(values.length / 2)];
  };
  const rgb = [median(0), median(1), median(2)];
  return {
    hex: rgb.map(v => v.toString(16).padStart(2, '0')).join(''),
    rgb,
    plate_cells: greens.length,
  };
}

const GRID_W = 64;
const GRID_H = 36;

async function alphaGrid(file, filter) {
  const raw = path.join(workDir, `grid-${crypto.randomBytes(3).toString('hex')}.raw`);
  await run('ffmpeg', ['-y', '-i', file, '-frames:v', '1', '-vf', `${filter},scale=${GRID_W}:${GRID_H}:flags=area`, '-pix_fmt', 'rgba', '-f', 'rawvideo', raw]);
  const bytes = await fs.readFile(raw);
  await fs.rm(raw, { force: true });
  return bytes;
}

function meanAlpha(grid, cells) {
  if (!cells.length) return 0;
  let total = 0;
  for (const cell of cells) total += grid[cell * 4 + 3];
  return total / cells.length;
}

// chromakey matches on chroma only and ignores luma. A studio green plate is far
// less saturated than 0x00FF00, which puts it close to neutral in UV — and so is
// a black hoodie. At the old fixed similarity of 0.20 a measured plate keyed the
// subject's hoodie AND face straight out of the frame. The usable window depends
// on the actual plate, so it is measured per render instead of guessed.
async function calibrateChromaKey(file, keyHex, keyRgb) {
  const plain = await alphaGrid(file, 'null');
  const subject = [];
  const background = [];
  for (let i = 0; i < GRID_W * GRID_H; i++) {
    const distance = Math.hypot(plain[i * 4] - keyRgb[0], plain[i * 4 + 1] - keyRgb[1], plain[i * 4 + 2] - keyRgb[2]);
    if (distance > 70) subject.push(i);
    else if (distance < 22) background.push(i);
  }
  if (!subject.length || !background.length) {
    log('Chroma calibration could not separate subject from plate; using conservative default.');
    return { similarity: 0.08, calibrated: false, subject_cells: subject.length, background_cells: background.length };
  }

  const candidates = [0.24, 0.20, 0.17, 0.15, 0.13, 0.11, 0.10, 0.09, 0.08, 0.07, 0.06, 0.05, 0.045, 0.04];
  let best = null;
  for (const similarity of candidates) {
    const keyed = await alphaGrid(file, `chromakey=0x${keyHex}:${similarity}:0.06`);
    const subjectAlpha = meanAlpha(keyed, subject);
    const backgroundAlpha = meanAlpha(keyed, background);
    if (!best || (backgroundAlpha <= 6 && subjectAlpha > best.subjectAlpha)) {
      best = { similarity, subjectAlpha, backgroundAlpha };
    }
    if (subjectAlpha >= 250 && backgroundAlpha <= 4) {
      return {
        similarity,
        calibrated: true,
        subject_alpha: Number(subjectAlpha.toFixed(1)),
        background_alpha: Number(backgroundAlpha.toFixed(1)),
        subject_cells: subject.length,
        background_cells: background.length,
      };
    }
  }

  log(`Chroma calibration found no clean threshold; best similarity=${best.similarity} subjectAlpha=${best.subjectAlpha.toFixed(1)} backgroundAlpha=${best.backgroundAlpha.toFixed(1)}`);
  return {
    similarity: best.similarity,
    calibrated: false,
    subject_alpha: Number(best.subjectAlpha.toFixed(1)),
    background_alpha: Number(best.backgroundAlpha.toFixed(1)),
    subject_cells: subject.length,
    background_cells: background.length,
  };
}

function enabledAssets(assets) {
  return assets.filter(asset => asset.enabled !== false);
}

function speechCarriers(assets) {
  return enabledAssets(assets).filter(asset => asset.speech_ready === true);
}

// Speech carriers are deliberately excluded here. A carrier is a mouth-shaped
// blank for lip-sync, not a reaction; letting one satisfy a plain `comment`
// event is what made the avatar mouth words with no audio behind them.
function chooseAsset(assets, type, intensity = 0.35) {
  const candidates = enabledAssets(assets).filter(asset => asset.reaction_type === type && asset.speech_ready !== true);
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
  // Only non-speech assets define the reaction vocabulary, so a persona whose
  // only `comment` clips are speech carriers does not advertise `comment`.
  const available = new Set(
    enabledAssets(assets).filter(asset => asset.speech_ready !== true).map(asset => String(asset.reaction_type)),
  );
  const voiceEnabled = request.voice_lipsync === true && speechCarriers(assets).length > 0;
  const maxVoiceComments = voiceEnabled ? Math.max(0, Number(request.max_voice_comments ?? 1)) : 0;
  let keptComments = 0;
  const events = [...(Array.isArray(plan?.events) ? plan.events : [])]
    .filter(event => Number.isFinite(Number(event?.time)))
    .sort((a, b) => Number(a.time) - Number(b.time))
    .map(event => {
      let requestedType = String(event.type || 'neutral');
      let comment = typeof event.comment === 'string' ? event.comment.trim() : '';
      if (!voiceEnabled || !comment || keptComments >= maxVoiceComments) comment = '';
      if (comment) keptComments += 1;
      // A `comment` event that lost its line is no longer a speaking beat. It
      // must not keep selecting a talking clip.
      if (!comment && requestedType === 'comment') requestedType = 'neutral';
      const type = fallbackType(requestedType, available);
      return { ...event, type, comment: comment || undefined, mapped_from_type: type !== String(event.type || '') ? String(event.type || '') : undefined };
    });
  return { ...plan, events };
}

async function assetDuration(asset, localFile) {
  const declared = Number(asset?.duration_s);
  if (Number.isFinite(declared) && declared > 0.2) return declared;
  return probeDuration(localFile);
}

// Chunks are cut on whole asset loops wherever possible. Every clip starts and
// ends on the identical reference frame, so a cut at a loop boundary is
// invisible while a cut mid-performance pops.
function neutralChunks(start, end, neutralAssets, state) {
  const output = [];
  let cursor = start;
  while (end - cursor > 0.04) {
    const asset = neutralAssets[state.index % neutralAssets.length];
    const loop = Number(state.durations.get(asset.id)) || 4;
    const duration = Math.min(end - cursor, loop);
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
  const raw = path.join(workDir, `comment-${index}-raw.mp3`);
  await download(audioUrl, raw);
  const padded = path.join(workDir, `comment-${index}.mp3`);
  await run('ffmpeg', [
    '-y', '-i', raw,
    '-af', `adelay=${Math.round(SPEECH_PAD_S * 1000)}:all=1,apad=pad_dur=${SPEECH_PAD_S.toFixed(3)}`,
    '-c:a', 'libmp3lame', '-q:a', '2', padded,
  ]);
  return { rawUrl: audioUrl, local: padded, duration: await probeDuration(padded) };
}

// Speech carriers all open and close on the same anchor frame, so they can be
// chained with hard cuts into a bed of any length. Lip-sync then runs once over
// the whole bed instead of over a single clip that may be shorter than the line.
async function buildSpeechBed(carriers, needSeconds, index, state) {
  const parts = [];
  let covered = 0;
  let guard = 0;
  while (covered < needSeconds && guard < 24) {
    const carrier = carriers[state.index % carriers.length];
    state.index += 1;
    guard += 1;
    const local = await cachedDownload(carrier.video_url, carrier.video_url.toLowerCase().includes('.webm') ? '.webm' : '.mp4');
    const duration = await assetDuration(carrier, local);
    parts.push({ carrier, local, duration });
    covered += duration;
  }
  if (!parts.length) throw new Error('No speech carrier available for the bed');

  const normalized = [];
  for (let i = 0; i < parts.length; i++) {
    const out = path.join(workDir, `bed-${index}-${i}.mp4`);
    // The bed leaves the machine for a third-party lip-sync service, so it is
    // encoded for maximum decoder compatibility rather than in the 4:4:4
    // intermediate format used inside this renderer.
    await run('ffmpeg', ['-y', '-i', parts[i].local, '-an', '-vf', avatarNormalizeFilter(),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', out]);
    normalized.push(out);
  }

  const bed = path.join(workDir, `speech-bed-${index}.mp4`);
  await concatFiles(normalized, bed);
  const bedDuration = await probeDuration(bed);
  if (bedDuration + 0.05 < needSeconds) {
    throw new Error(`Speech bed is shorter than its line: ${bedDuration.toFixed(2)}s < ${needSeconds.toFixed(2)}s`);
  }
  return { file: bed, duration: bedDuration, carrierIds: parts.map(p => p.carrier.id) };
}

async function hfMuseTalkLipSync({ index, videoUrl, audioUrl, expectedDuration }) {
  try { await fs.access(HF_MUSETALK_WORKER); } catch { throw new Error(`HF MuseTalk worker not found: ${HF_MUSETALK_WORKER}`); }
  const local = path.join(workDir, `lipsync-hf-${index}.mp4`);
  const result = await run('python', [
    HF_MUSETALK_WORKER,
    '--video-url', videoUrl,
    '--audio-url', audioUrl,
    '--output', local,
    '--space', 'trymonolith/MuseTalk',
    '--quality', 'Medium',
    '--fps', String(FPS),
  ]);
  log('HF MuseTalk:', String(result.stdout || '').trim().slice(-1800));
  const stat = await fs.stat(local).catch(() => null);
  if (!stat || stat.size < 20_000) throw new Error('MuseTalk returned no usable MP4');
  const duration = await probeDuration(local);
  // A provider that silently truncates leaves the mouth frozen while the voice
  // keeps playing, so the returned clip must actually cover the padded line.
  if (duration + 0.25 < expectedDuration) {
    throw new Error(`Lip-sync output does not cover the line: ${duration.toFixed(2)}s < ${expectedDuration.toFixed(2)}s`);
  }
  return { local, provider: 'huggingface_public_musetalk', space: 'trymonolith/MuseTalk', bytes: stat.size, duration };
}

async function buildTimeline({ plan, assets, totalDuration, request, jobId }) {
  const neutralAssets = enabledAssets(assets).filter(asset => asset.reaction_type === 'neutral' && asset.speech_ready !== true);
  if (!neutralAssets.length) throw new Error('No enabled neutral reaction asset');

  const neutralState = { index: 0, durations: new Map() };
  for (const asset of neutralAssets) {
    const local = await cachedDownload(asset.video_url, asset.video_url.toLowerCase().includes('.webm') ? '.webm' : '.mp4');
    neutralState.durations.set(asset.id, await assetDuration(asset, local));
  }

  const carriers = speechCarriers(assets);
  const carrierState = { index: 0 };
  const segments = [];
  const comments = [];
  let cursor = 0;

  for (const event of plan.events || []) {
    let start = clamp(Number(event.time), 0, Math.max(0, totalDuration - 0.1));
    if (start < cursor + 0.08) start = cursor + 0.08;
    if (start >= totalDuration - 0.05) break;
    if (start > cursor) segments.push(...neutralChunks(cursor, start, neutralAssets, neutralState));

    const hasComment = request.voice_lipsync === true && typeof event.comment === 'string' && event.comment.trim().length > 0;
    let duration = clamp(Number(event.duration ?? 2.4), 0.8, 8);
    let asset = null;
    let localOverride = null;
    let lipsyncMeta = null;

    if (hasComment) {
      if (!carriers.length) {
        throw new Error('Voice render requires one enabled speech-ready reusable avatar asset; refusing to fake lip-sync on an unvalidated reaction clip.');
      }
      await progress(jobId, 'tts_generating', { active_comment: event.comment.trim(), absolute_start_s: start });
      const tts = await createTts(event.comment.trim(), comments.length);

      await progress(jobId, 'speech_bed_building', { padded_tts_duration_s: Number(tts.duration.toFixed(3)) });
      const bed = await buildSpeechBed(carriers, tts.duration, comments.length, carrierState);
      const bedUpload = await uploadToBucket(bed.file, `tmp/lipsync/${jobId}-${comments.length}-bed.mp4`, 'video/mp4');
      const audioUpload = await uploadToBucket(tts.local, `tmp/lipsync/${jobId}-${comments.length}-voice.mp3`, 'audio/mpeg');

      await progress(jobId, 'lipsync_hf_running', {
        lipsync_provider: 'huggingface_public_musetalk',
        lipsync_space: 'trymonolith/MuseTalk',
        absolute_start_s: start,
      });
      const synced = await hfMuseTalkLipSync({
        index: comments.length,
        videoUrl: bedUpload.url,
        audioUrl: audioUpload.url,
        expectedDuration: tts.duration,
      });

      // The segment runs exactly as long as the padded line, so it opens and
      // closes on the carrier's closed-mouth anchor.
      duration = tts.duration;
      asset = carriers[0];
      localOverride = synced.local;
      lipsyncMeta = { ...synced, carrier_ids: bed.carrierIds };
      comments.push({
        start,
        text: event.comment.trim(),
        audioUrl: audioUpload.url,
        local: tts.local,
        duration: tts.duration,
        lead_in_s: SPEECH_PAD_S,
        lipsync_provider: synced.provider,
        lipsync_duration: synced.duration,
        speech_carrier_ids: bed.carrierIds,
      });
    } else {
      asset = chooseAsset(assets, String(event.type), Number(event.intensity ?? 0.35))
        || neutralAssets[neutralState.index++ % neutralAssets.length];
    }

    duration = Math.min(duration, totalDuration - start);
    segments.push({ start, duration, asset, localOverride, kind: hasComment ? 'comment' : 'reaction', event, lipsyncMeta });
    cursor = start + duration;
  }

  if (cursor < totalDuration) segments.push(...neutralChunks(cursor, totalDuration, neutralAssets, neutralState));
  if (!segments.length) segments.push(...neutralChunks(0, totalDuration, neutralAssets, neutralState));
  return { segments, comments };
}

let BACKGROUND_HEX = '00ff00';
let CHROMA_SIMILARITY = 0.08;

// 16:9 in, 16:9 out. The old portrait crop cut the subject in half, because he
// sits on the right of his reference frame and the crop was centred.
function avatarNormalizeFilter() {
  return [
    `fps=${FPS}`,
    `scale=${AVATAR_W}:${AVATAR_H}:force_original_aspect_ratio=decrease`,
    `pad=${AVATAR_W}:${AVATAR_H}:(ow-iw)/2:(oh-ih)/2:color=0x${BACKGROUND_HEX}`,
    'setsar=1',
  ].join(',');
}

// yuv444p keeps full-resolution chroma through the intermediates, so the key is
// computed from real chroma detail instead of half-resolution 4:2:0 edges.
function avatarEncodeArgs() {
  return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-pix_fmt', 'yuv444p', '-profile:v', 'high444'];
}

async function concatFiles(files, out) {
  if (files.length === 1) {
    await fs.copyFile(files[0], out);
    return out;
  }
  const listFile = path.join(workDir, `concat-${crypto.randomBytes(4).toString('hex')}.txt`);
  await fs.writeFile(listFile, files.map(file => `file '${file.replace(/'/g, "'\\''")}'`).join('\n'));
  await run('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', out]);
  return out;
}

async function renderSegment(segment, index) {
  const source = segment.localOverride
    || await cachedDownload(segment.asset.video_url, segment.asset.video_url.toLowerCase().includes('.webm') ? '.webm' : '.mp4');
  const out = path.join(workDir, `segment-${String(index).padStart(3, '0')}.mp4`);
  const renderDuration = Math.max(0.12, Number(segment.duration));
  const inputArgs = segment.kind === 'neutral' ? ['-stream_loop', '-1', '-i', source] : ['-i', source];
  const tail = segment.kind === 'neutral' ? '' : ',tpad=stop_mode=clone:stop_duration=10';
  const filter = `${avatarNormalizeFilter()}${tail},trim=duration=${renderDuration.toFixed(3)},setpts=PTS-STARTPTS`;
  await run('ffmpeg', ['-y', ...inputArgs, '-an', '-vf', filter, ...avatarEncodeArgs(), '-t', renderDuration.toFixed(3), out]);
  return { file: out, renderDuration };
}

// Hard cuts, not dissolves. Consecutive clips meet on the identical reference
// frame, so a cut is invisible while a cross-dissolve double-exposes the face.
async function assembleAvatarTrack(rendered, totalDuration) {
  const merged = path.join(workDir, 'avatar-merged.mp4');
  await concatFiles(rendered.map(item => item.file), merged);
  const mergedDuration = await probeDuration(merged);

  // Every segment is encoded at 30fps, so its real duration rounds to a whole
  // frame. Over a long timeline those roundings accumulate into a shortfall of a
  // few frames. That is quantisation, not a planning error, so the tail is
  // extended by holding the anchor frame. A large gap still means the timeline
  // logic is wrong and must fail.
  const shortfall = totalDuration - mergedDuration;
  if (shortfall > 1.0) {
    throw new Error(`Avatar timeline is short by ${shortfall.toFixed(3)}s: expected ${totalDuration.toFixed(3)}s, got ${mergedDuration.toFixed(3)}s`);
  }

  const out = path.join(workDir, 'avatar-track.mp4');
  if (shortfall > 0.005) {
    log(`Padding avatar tail by ${shortfall.toFixed(3)}s of frame-quantisation drift`);
    await run('ffmpeg', ['-y', '-i', merged, '-an',
      '-vf', `tpad=stop_mode=clone:stop_duration=${(shortfall + 0.5).toFixed(3)}`,
      ...avatarEncodeArgs(), '-t', totalDuration.toFixed(3), out]);
  } else {
    await run('ffmpeg', ['-y', '-i', merged, '-an', '-t', totalDuration.toFixed(3), '-c', 'copy', out]);
  }

  const producedDuration = await probeDuration(out);
  if (Math.abs(producedDuration - totalDuration) > 0.15) {
    throw new Error(`Avatar timeline drifted: expected ${totalDuration.toFixed(3)}s, got ${producedDuration.toFixed(3)}s`);
  }
  return out;
}

async function composeFinal(source, avatarTrack, comments, totalDuration, sourceHasAudio, despillAvailable) {
  const out = path.join(workDir, 'final.mp4');
  const args = ['-y', '-i', source, '-i', avatarTrack];
  for (const comment of comments) args.push('-i', comment.local);

  const key = [
    'format=rgba',
    `chromakey=0x${BACKGROUND_HEX}:${CHROMA_SIMILARITY}:0.06`,
    despillAvailable ? 'despill=type=green:mix=0.5:expand=0' : null,
  ].filter(Boolean).join(',');

  const filters = [
    '[0:v]split=2[srcbg][srcfg]',
    `[srcbg]scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=increase,crop=${OUT_W}:${OUT_H},gblur=sigma=28,eq=brightness=-0.13[bg]`,
    `[srcfg]scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=decrease[fg]`,
    '[bg][fg]overlay=(W-w)/2:(H-h)/2[base]',
    `[1:v]${key}[avatar]`,
    // Flush to the corner: the reference frame already cuts his body at the
    // right and bottom edges, so any margin would expose those straight cuts.
    '[base][avatar]overlay=W-w:H-h:format=auto[vout]',
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
  if (Number(video.width) !== OUT_W || Number(video.height) !== OUT_H) throw new Error(`Final validation: expected ${OUT_W}x${OUT_H}, got ${video.width}x${video.height}`);
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

// Immutable per render. A shared object made it possible to reload a cached old
// render and believe a fix had failed.
async function uploadResult(jobId, file) {
  const renderId = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  return uploadToBucket(file, `results/${jobId}/${renderId}.mp4`, 'video/mp4');
}

if (CALIBRATE_TARGET) {
  const local = /^https?:\/\//i.test(CALIBRATE_TARGET)
    ? await cachedDownload(CALIBRATE_TARGET, '.mp4')
    : CALIBRATE_TARGET;
  const background = await sampleBackgroundColour(local);
  const chroma = await calibrateChromaKey(local, background.hex, background.rgb);
  console.log(JSON.stringify({
    file: CALIBRATE_TARGET,
    key_hex: background.hex,
    key_rgb: background.rgb,
    despill: await ffmpegHasFilter('despill'),
    ...chroma,
  }, null, 2));
  await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  process.exit(chroma.calibrated ? 0 : 2);
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
  const neutralPool = enabledAssets(assets).filter(asset => asset.reaction_type === 'neutral' && asset.speech_ready !== true);
  if (!neutralPool.length) throw new Error('No enabled neutral avatar asset');
  if (request.voice_lipsync === true && !speechCarriers(assets).length) {
    throw new Error('Voice render requires one enabled speech-ready reusable avatar asset');
  }

  await progress(claimedJob.id, 'render_preparing', {
    renderer: 'lm-render/github-actions-v4',
    avatar_mode: 'chroma',
    avatar_source_format: '16:9_native',
    voice_lipsync: request.voice_lipsync === true,
    timeline_clock: 'absolute_preserved_hardcut_v2',
  });

  const source = path.join(workDir, 'source.mp4');
  await download(claimedJob.source_url, source);
  const duration = await probeDuration(source);
  const sourceHasAudio = await hasAudio(source);

  const referenceAsset = neutralPool[0];
  const referenceLocal = await cachedDownload(referenceAsset.video_url, referenceAsset.video_url.toLowerCase().includes('.webm') ? '.webm' : '.mp4');
  const background = await sampleBackgroundColour(referenceLocal);
  BACKGROUND_HEX = background.hex;
  const chroma = await calibrateChromaKey(referenceLocal, background.hex, background.rgb);
  CHROMA_SIMILARITY = chroma.similarity;
  const despillAvailable = await ffmpegHasFilter('despill');
  log(`Claimed ${claimedJob.id}; duration=${duration.toFixed(2)}s; assets=${assets.length}; audio=${sourceHasAudio}; key=0x${background.hex}; similarity=${chroma.similarity}; calibrated=${chroma.calibrated}; despill=${despillAvailable}`);

  const plan = adaptPlan(claimedJob.reaction_plan, assets, request);
  await progress(claimedJob.id, 'timeline_building', {
    adapted_event_count: plan.events?.length || 0,
    planned_voice_comments: (plan.events || []).filter(event => event.comment).length,
    chroma_key_hex: background.hex,
    chroma_similarity: chroma.similarity,
  });

  const { segments, comments } = await buildTimeline({ plan, assets, totalDuration: duration, request, jobId: claimedJob.id });
  await progress(claimedJob.id, 'avatar_rendering', {
    segment_count: segments.length,
    comment_count: comments.length,
  });

  const rendered = [];
  for (let i = 0; i < segments.length; i++) rendered.push(await renderSegment(segments[i], i));
  const avatarTrack = await assembleAvatarTrack(rendered, duration);

  await progress(claimedJob.id, 'compositing', {
    avatar_mode: 'chroma',
    source_audio_preserved: sourceHasAudio,
  });
  const final = await composeFinal(source, avatarTrack, comments, duration, sourceHasAudio, despillAvailable);
  const validation = await validateFinal(final, duration, sourceHasAudio || comments.length > 0);

  await progress(claimedJob.id, 'result_uploading', { final_validation: validation });
  const uploaded = await uploadResult(claimedJob.id, final);

  const renderMeta = {
    ...(claimedJob.render_meta || {}),
    renderer: 'lm-render/github-actions-v4',
    duration_s: Number(duration.toFixed(3)),
    avatar_mode: 'chroma',
    avatar_source_format: '16:9_native',
    avatar_frame: `${AVATAR_W}x${AVATAR_H}`,
    chroma_key_hex: background.hex,
    chroma_similarity: chroma.similarity,
    chroma_calibration: chroma,
    chroma_despill: despillAvailable,
    source_analysis_mode: claimedJob.render_meta?.source_analysis_mode || 'saved_preview_plan',
    event_count: plan.events?.length || 0,
    segment_count: segments.length,
    transition_mode: 'anchor_hard_cut',
    comment_count: comments.length,
    lipsync_provider: comments.length ? 'huggingface_public_musetalk' : null,
    speech_pad_s: SPEECH_PAD_S,
    timeline_clock: 'absolute_preserved_hardcut_v2',
    audio_mix: 'full_duration_padded_sidechain_v1',
    final_validation: validation,
    comments: comments.map(comment => ({
      start: comment.start,
      text: comment.text,
      duration: comment.duration,
      lead_in_s: comment.lead_in_s,
      lipsync_provider: comment.lipsync_provider,
      lipsync_duration: comment.lipsync_duration,
      speech_carrier_ids: comment.speech_carrier_ids,
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
