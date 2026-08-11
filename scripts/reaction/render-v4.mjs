import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const MAM_BASE = (process.env.MAM_BASE || 'https://21media-mam.vercel.app').replace(/\/$/, '');
const SECRET = String(process.env.BUFFER_PUSH_SECRET || '');
const SUPABASE_URL = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_KEY = String(process.env.MAM_SUPABASE_SERVICE_ROLE_KEY || '');
const REQUESTED_JOB_ID = String(process.env.JOB_ID || '').trim();
const HF_MUSETALK_WORKER = String(process.env.HF_MUSETALK_WORKER || '').trim();
const FAL_KEY = String(process.env.FAL_KEY || '').trim();
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
// Lead-in only has to let the mouth start closed; the tail is longer because
// the clip is morphed back to the anchor pose during it, and the generator bills
// by the second.
const SPEECH_LEAD_S = 0.15;
const SPEECH_TAIL_S = 0.35;
const SPEECH_PAD_S = SPEECH_LEAD_S;
const ANCHOR_RETURN_S = 0.28;

// The voice stem is normalised to this, then the source is ducked under it and
// the sum is limited. Without this the mix clipped at +2.9 dBFS and still went
// quiet under the line.
const VOICE_TARGET_LUFS = -13;

// Lip-sync runs against a video built from the persona's HQ still rather than a
// generated carrier. Inside the 1102x620 avatar frame the face measures ~207px;
// at this size it is roughly 540px, which is what these models actually need.
// fal's Kling lip-sync also requires both axes between 720 and 1920.
// Both axes divisible by 16. Asked for 1920x1080 the provider returned
// 1920x1072 and the difference pass could not run at all; 1080 is not a
// multiple of 16 and it silently conformed the frame.
const STILL_W = 1920;
const STILL_H = 1088;
const FAL_LIPSYNC_MODEL = 'fal-ai/kling-video/lipsync/audio-to-video';
const FAL_AVATAR_MODEL = 'fal-ai/kling-video/ai-avatar/v2/standard';
const FAL_MAX_CLIP_S = 10;

// `avatar` generates the performance from the still and the audio, so the mouth
// genuinely opens and the head moves. `lipsync` only repaints a mouth onto an
// existing frame, which on a three-quarter face produced texture that shifted
// without the lips ever parting. `avatar` costs ~$0.0562/s against $0.014 per
// 5s block; at one line per video that is cents either way.
const LIPSYNC_MODE = String(process.env.REACTION_LIPSYNC_MODE || 'avatar').trim();

// Supabase enforces the smaller of the bucket limit and the project plan's
// global upload limit. The bucket allows 250 MB but the project caps uploads at
// 50 MB, which a 145s 1080x1920 render blows straight past at CRF 20. The
// delivery encode is therefore given a size budget instead of a fixed quality.
const MAX_RESULT_BYTES = Math.round(Number(process.env.REACTION_MAX_RESULT_MB || 46) * 1024 * 1024);
const AUDIO_KBPS = 160;

// `node render-v4.mjs --calibrate <file|url>` reports the chroma key it would
// use for an asset and exits. Useful for QC on a new persona plate, and it needs
// none of the job credentials.
const CALIBRATE_TARGET = process.argv[2] === '--calibrate' ? String(process.argv[3] || '').trim() : '';

if (!CALIBRATE_TARGET) {
  if (!SECRET) throw new Error('BUFFER_PUSH_SECRET missing');
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('SUPABASE_URL / MAM_SUPABASE_SERVICE_ROLE_KEY missing');
  if (!HF_MUSETALK_WORKER && !FAL_KEY) throw new Error('No lip-sync provider configured: set FAL_KEY or HF_MUSETALK_WORKER');
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

// ElevenLabs output level is not constant, and a fixed volume made the mix
// 4.6 LUFS QUIETER while he spoke than while he did not. The voice is measured
// and gained to a known level instead.
async function measureLoudness(file) {
  const { stderr } = await run('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-af', 'ebur128=peak=true', '-f', 'null', '-']);
  const match = stderr.match(/I:\s*(-?[\d.]+)\s*LUFS/g);
  if (!match?.length) return null;
  const value = Number(String(match[match.length - 1]).match(/(-?[\d.]+)/)?.[1]);
  return Number.isFinite(value) ? value : null;
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

const REFERENCE_TYPE = 'reference';
const BACKGROUND_TYPE = 'background';

// The reference still and the background plate are persona inputs, not
// something the timeline can play.
function enabledAssets(assets) {
  return assets.filter(asset => asset.enabled !== false
    && asset.reaction_type !== REFERENCE_TYPE
    && asset.reaction_type !== BACKGROUND_TYPE);
}

function referenceStill(assets) {
  return assets.find(asset => asset.enabled !== false && asset.reaction_type === REFERENCE_TYPE) || null;
}

function backgroundPlate(assets) {
  return assets.find(asset => asset.enabled !== false && asset.reaction_type === BACKGROUND_TYPE) || null;
}

// Where the cut-out sits. A bottom corner has the source behind it already; a
// top corner is over filler, which is why it needs a plate.
//
// `width` is the cut-out after cropping away the empty plate, not the full
// avatar frame. Placing the whole frame in a left corner would leave the
// subject near the middle, because he sits on the right of his own frame.
function avatarPosition(corner, width) {
  const right = `${OUT_W - width}`;
  const bottom = `${OUT_H - AVATAR_H}`;
  switch (corner) {
    case 'bottom_left': return { x: '0', y: bottom };
    case 'top_right': return { x: right, y: '0' };
    case 'top_left': return { x: '0', y: '0' };
    default: return { x: right, y: bottom };
  }
}

// The subject's horizontal extent inside his own frame, measured from the keyed
// reference rather than assumed, so a differently framed persona still works.
async function subjectBounds(file, keyHex, similarity) {
  const grid = await alphaGrid(file, `format=rgba,chromakey=0x${keyHex}:${similarity}:0.06`);
  let minCol = GRID_W;
  let maxCol = -1;
  for (let x = 0; x < GRID_W; x++) {
    let solid = 0;
    for (let y = 0; y < GRID_H; y++) if (grid[(y * GRID_W + x) * 4 + 3] > 140) solid += 1;
    if (solid >= 2) { minCol = Math.min(minCol, x); maxCol = Math.max(maxCol, x); }
  }
  if (maxCol < 0) return { x: 0, width: AVATAR_W };
  // A little padding so the key's soft edge is not clipped.
  const x = Math.max(0, Math.floor(((minCol - 0.5) / GRID_W) * AVATAR_W / 2) * 2);
  const right = Math.min(AVATAR_W, Math.ceil((((maxCol + 1.5) / GRID_W) * AVATAR_W) / 2) * 2);
  const width = Math.max(2, right - x);
  return { x, width };
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

// A generated reaction is a whole performance: it opens neutral, peaks, and
// settles back. The Director's timestamp marks the moment the reaction should
// land, which is the peak — not the moment the clip starts rolling.
function assetPeak(asset, duration) {
  const stored = Number(asset?.metadata?.loop?.peak_s);
  if (Number.isFinite(stored) && stored > 0 && stored < duration) return stored;
  return duration / 2;
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
    '-af', `adelay=${Math.round(SPEECH_LEAD_S * 1000)}:all=1,apad=pad_dur=${SPEECH_TAIL_S.toFixed(3)}`,
    '-c:a', 'libmp3lame', '-q:a', '2', padded,
  ]);
  const measured = await measureLoudness(padded);
  const gainDb = measured == null ? 0 : clamp(VOICE_TARGET_LUFS - measured, -6, 18);
  return {
    rawUrl: audioUrl,
    local: padded,
    duration: await probeDuration(padded),
    loudness_lufs: measured,
    gain_db: Number(gainDb.toFixed(2)),
  };
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

// A still held for the length of the line. The provider only repaints the mouth,
// so everything else in the frame is identical to the reference by construction —
// which makes the cut into and out of a spoken segment exact.
// A still with a repainted mouth reads as a frozen photograph next to a neutral
// clip that breathes. A slow sub-percent wander is not breathing, but it removes
// the freeze. It is applied after the mouth is patched, because a patch anchored
// to fixed coordinates would slide off a head that had already started moving.
async function addMicroDrift(file, index) {
  const out = path.join(workDir, `drift-${index}.mp4`);
  const duration = await probeDuration(file);
  await run('ffmpeg', ['-y', '-i', file, '-an', '-vf', [
    "crop=w=iw*0.986:h=ih*0.986:x='(iw-ow)/2+9*sin(2*PI*t/9)':y='(ih-oh)/2+6*sin(2*PI*t/7+1.1)'",
    `scale=${STILL_W}:${STILL_H}`,
    'setsar=1',
  ].join(','), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-pix_fmt', 'yuv420p',
    '-t', duration.toFixed(3), out]);
  return out;
}

async function buildStillVideo(imageFile, durationSeconds, index) {
  const out = path.join(workDir, `still-${index}.mp4`);
  await run('ffmpeg', ['-y', '-loop', '1', '-i', imageFile,
    '-vf', `scale=${STILL_W}:${STILL_H}:force_original_aspect_ratio=increase,crop=${STILL_W}:${STILL_H},fps=${FPS},setsar=1`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-pix_fmt', 'yuv420p',
    '-t', durationSeconds.toFixed(3), out]);
  return out;
}

async function falRequest(pathname, options = {}) {
  const response = await fetch(pathname, {
    ...options,
    headers: { Authorization: `Key ${FAL_KEY}`, 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!response.ok) throw new Error(`fal ${pathname} -> ${response.status}: ${JSON.stringify(data).slice(0, 600)}`);
  return data;
}

async function falQueue(model, payload, expectedDuration, label) {
  const queued = await falRequest(`https://queue.fal.run/${model}`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  const statusUrl = String(queued.status_url || '');
  const responseUrl = String(queued.response_url || '');
  if (!statusUrl || !responseUrl) throw new Error(`fal did not queue the request: ${JSON.stringify(queued).slice(0, 400)}`);

  const deadline = Date.now() + 15 * 60 * 1000;
  let status = String(queued.status || 'IN_QUEUE');
  while (status !== 'COMPLETED') {
    if (Date.now() > deadline) throw new Error(`${label} timed out after 15 minutes`);
    await new Promise(resolve => setTimeout(resolve, 5000));
    const poll = await falRequest(statusUrl);
    status = String(poll.status || '');
    if (status === 'FAILED' || status === 'ERROR') {
      throw new Error(`${label} failed: ${JSON.stringify(poll).slice(0, 600)}`);
    }
  }
  const result = await falRequest(responseUrl);
  const url = String(result?.video?.url || '');
  if (!url) throw new Error(`${label} returned no video: ${JSON.stringify(result).slice(0, 400)}`);
  return url;
}

// The generator is free to reinterpret the pose, and it does: left alone it
// turns him toward the camera and lifts his head, so the cut back to a neutral
// clip sitting at the anchor jumps. This asks for the pose to be held.
const AVATAR_PROMPT = [
  'Keep the exact head orientation, body orientation, camera angle, framing and gaze direction of the reference image.',
  'He keeps looking off-screen to the left and never turns toward the camera.',
  'Minimal head movement: only the small natural motion that comes with speaking.',
  'No camera movement, no zoom, no reframing, no posture change.',
  'Natural mouth and jaw articulation for the speech.',
  'Keep the plain green background completely clean and unchanged.',
].join(' ');

// Generates the whole spoken performance from the persona still. There is no
// mouth patch afterwards: every pixel is generated coherently, so patching one
// region back would be the only thing capable of introducing a seam.
async function falKlingAvatar({ index, imageUrl, audioUrl, expectedDuration }) {
  // Re-rendering the same line is common while tuning everything around it, and
  // the generator bills per second every time. The clip is keyed on exactly what
  // determines it.
  const cacheKey = crypto.createHash('sha1').update(`${FAL_AVATAR_MODEL}::${imageUrl}::${audioUrl}::${AVATAR_PROMPT}`).digest('hex');
  const cachePath = `cache/avatar/${cacheKey}.mp4`;
  const cacheUrl = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${cachePath}`;
  const local = path.join(workDir, `avatar-fal-${index}.mp4`);

  const cached = await fetch(cacheUrl);
  if (cached.ok) {
    await fs.writeFile(local, Buffer.from(await cached.arrayBuffer()));
    const duration = await probeDuration(local);
    const size = await frameSize(local);
    log(`Kling AI Avatar: reused cached clip ${size.width}x${size.height}, ${duration.toFixed(2)}s`);
    return { local, provider: 'fal_kling_ai_avatar', model: FAL_AVATAR_MODEL, duration, width: size.width, height: size.height, cached: true };
  }

  const url = await falQueue(FAL_AVATAR_MODEL, { image_url: imageUrl, audio_url: audioUrl, prompt: AVATAR_PROMPT }, expectedDuration, 'fal Kling AI Avatar');
  await download(url, local);
  await uploadToBucket(local, cachePath, 'video/mp4').catch(error => log('Could not cache the avatar clip:', error.message));
  const duration = await probeDuration(local);
  if (duration + 0.35 < expectedDuration) {
    throw new Error(`Avatar output does not cover the line: ${duration.toFixed(2)}s < ${expectedDuration.toFixed(2)}s`);
  }
  const size = await frameSize(local);
  log(`Kling AI Avatar: generated ${size.width}x${size.height}, ${duration.toFixed(2)}s`);
  return { local, provider: 'fal_kling_ai_avatar', model: FAL_AVATAR_MODEL, duration, width: size.width, height: size.height, cached: false };
}

// Whatever pose the generator drifts into, the clip has to hand back to a
// neutral clip that sits at the anchor. The trailing silence is exactly the
// right place to morph home, so the hard cut at the segment boundary stays
// valid and nothing jumps.
async function returnToAnchor(clipFile, imageFile, index) {
  const duration = await probeDuration(clipFile);
  const fade = Math.min(ANCHOR_RETURN_S, duration / 3);
  const size = await frameSize(clipFile);
  const anchor = path.join(workDir, `anchor-${index}.mp4`);
  await run('ffmpeg', ['-y', '-loop', '1', '-i', imageFile,
    '-vf', `scale=${size.width}:${size.height}:force_original_aspect_ratio=increase,crop=${size.width}:${size.height},fps=${FPS},setsar=1`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-pix_fmt', 'yuv420p', '-t', (fade + 0.2).toFixed(3), anchor]);

  const out = path.join(workDir, `anchored-${index}.mp4`);
  await run('ffmpeg', ['-y', '-i', clipFile, '-i', anchor, '-an',
    '-filter_complex', `[0:v][1:v]xfade=transition=fade:duration=${fade.toFixed(3)}:offset=${(duration - fade).toFixed(3)}[v]`,
    '-map', '[v]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-pix_fmt', 'yuv420p',
    '-t', duration.toFixed(3), out]);
  log(`Anchored the spoken clip home over its last ${fade.toFixed(2)}s of silence`);
  return out;
}

async function falKlingLipSync({ index, videoUrl, audioUrl, expectedDuration }) {
  if (expectedDuration > FAL_MAX_CLIP_S) {
    throw new Error(`Spoken line is ${expectedDuration.toFixed(1)}s; the lip-sync endpoint accepts at most ${FAL_MAX_CLIP_S}s`);
  }
  const queued = await falRequest(`https://queue.fal.run/${FAL_LIPSYNC_MODEL}`, {
    method: 'POST',
    body: JSON.stringify({ video_url: videoUrl, audio_url: audioUrl }),
  });
  const statusUrl = String(queued.status_url || '');
  const responseUrl = String(queued.response_url || '');
  if (!statusUrl || !responseUrl) throw new Error(`fal did not queue the request: ${JSON.stringify(queued).slice(0, 400)}`);

  const deadline = Date.now() + 10 * 60 * 1000;
  let status = String(queued.status || 'IN_QUEUE');
  while (status !== 'COMPLETED') {
    if (Date.now() > deadline) throw new Error('fal lip-sync timed out after 10 minutes');
    await new Promise(resolve => setTimeout(resolve, 4000));
    const poll = await falRequest(statusUrl);
    status = String(poll.status || '');
    if (status === 'FAILED' || status === 'ERROR') {
      throw new Error(`fal lip-sync failed: ${JSON.stringify(poll).slice(0, 600)}`);
    }
  }

  const result = await falRequest(responseUrl);
  const url = String(result?.video?.url || '');
  if (!url) throw new Error(`fal returned no video: ${JSON.stringify(result).slice(0, 400)}`);
  const local = path.join(workDir, `lipsync-fal-${index}.mp4`);
  await download(url, local);
  const duration = await probeDuration(local);
  if (duration + 0.25 < expectedDuration) {
    throw new Error(`Lip-sync output does not cover the line: ${duration.toFixed(2)}s < ${expectedDuration.toFixed(2)}s`);
  }
  return { local, provider: 'fal_kling_lipsync', model: FAL_LIPSYNC_MODEL, duration };
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

// MuseTalk returns a whole frame with a regenerated rectangular face block. Its
// edge is visible, and where the block overlaps the green plate it shifts those
// pixels enough that the chroma key stops removing them — which is why a dark
// rectangle appeared over the avatar for exactly the duration of the line.
//
// Only the mouth is worth keeping. The provider's own output locates it: the
// static part of the block differs from the carrier by a roughly constant
// amount, while the mouth differs by an amount that CHANGES every frame. Cells
// are therefore ranked by the temporal deviation of the difference, not by its
// magnitude.
async function frameSize(file) {
  const data = await probeJson(file);
  const video = (data.streams || []).find(stream => stream.codec_type === 'video');
  if (!video) throw new Error(`No video stream in ${file}`);
  return { width: Number(video.width), height: Number(video.height) };
}

// Providers quietly conform frame sizes. Rescaling to match would shift the whole
// face and light up the difference pass everywhere instead of on the mouth, so
// the frame is centred back to size at its original scale.
async function conformFrameSize(file, target, index) {
  const size = await frameSize(file);
  if (size.width === target.width && size.height === target.height) return file;
  log(`Lip-sync output is ${size.width}x${size.height}; conforming to ${target.width}x${target.height} without rescaling`);
  const out = path.join(workDir, `conformed-${index}.mp4`);
  await run('ffmpeg', ['-y', '-i', file, '-an', '-vf', [
    `crop=min(iw\,${target.width}):min(ih\,${target.height})`,
    `pad=${target.width}:${target.height}:(ow-iw)/2:(oh-ih)/2:color=0x${BACKGROUND_HEX}`,
    'setsar=1',
  ].join(','), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-pix_fmt', 'yuv420p', out]);
  return out;
}

async function locateLipSyncPatch(bedFile, syncedFile) {
  const raw = path.join(workDir, `lipsync-diff-${crypto.randomBytes(3).toString('hex')}.raw`);
  await run('ffmpeg', ['-y', '-i', bedFile, '-i', syncedFile,
    '-filter_complex', `[0:v][1:v]blend=all_mode=difference,format=gray,scale=${GRID_W}:${GRID_H}:flags=area`,
    '-pix_fmt', 'gray', '-f', 'rawvideo', raw]);
  const bytes = await fs.readFile(raw);
  await fs.rm(raw, { force: true });

  const cells = GRID_W * GRID_H;
  const frameCount = Math.floor(bytes.length / cells);
  if (frameCount < 4) throw new Error('Could not compare the lip-sync output with its carrier');

  const deviation = new Array(cells).fill(0);
  let maxDeviation = 0;
  for (let cell = 0; cell < cells; cell++) {
    let sum = 0;
    for (let frame = 0; frame < frameCount; frame++) sum += bytes[frame * cells + cell];
    const mean = sum / frameCount;
    let variance = 0;
    for (let frame = 0; frame < frameCount; frame++) {
      const delta = bytes[frame * cells + cell] - mean;
      variance += delta * delta;
    }
    deviation[cell] = Math.sqrt(variance / frameCount);
    if (deviation[cell] > maxDeviation) maxDeviation = deviation[cell];
  }

  // A provider can return a technically valid MP4 whose mouth never moves. That
  // is a failed render, not a successful one.
  if (maxDeviation < 1.5) {
    throw new Error(`Lip-sync output has no moving region: peak temporal deviation ${maxDeviation.toFixed(2)}`);
  }

  // The provider's block spans the whole face, and its noisiest region is the
  // eyes, not the mouth — ranking cells by deviation alone put the patch over
  // his eyes and left the mouth untouched, which is exactly what "the mouth
  // still does not move" looks like. The mouth is always in the lower part of a
  // face, so the search is restricted there.
  let meanDiff = new Array(cells).fill(0);
  for (let cell = 0; cell < cells; cell++) {
    let sum = 0;
    for (let frame = 0; frame < frameCount; frame++) sum += bytes[frame * cells + cell];
    meanDiff[cell] = sum / frameCount;
  }
  const blockThreshold = Math.max(3, Math.max(...meanDiff) * 0.25);
  let bMinX = GRID_W; let bMaxX = -1; let bMinY = GRID_H; let bMaxY = -1;
  for (let cell = 0; cell < cells; cell++) {
    if (meanDiff[cell] < blockThreshold) continue;
    const x = cell % GRID_W;
    const y = Math.floor(cell / GRID_W);
    bMinX = Math.min(bMinX, x); bMaxX = Math.max(bMaxX, x);
    bMinY = Math.min(bMinY, y); bMaxY = Math.max(bMaxY, y);
  }
  if (bMaxX < 0) throw new Error('Lip-sync output does not differ from its carrier');
  const blockW = bMaxX - bMinX + 1;
  const blockH = bMaxY - bMinY + 1;
  const mouthTop = bMinY + blockH * 0.5;

  const threshold = Math.max(1.2, maxDeviation * 0.30);
  let weight = 0; let cxSum = 0; let cySum = 0; let moving = 0;
  for (let cell = 0; cell < cells; cell++) {
    const x = cell % GRID_W;
    const y = Math.floor(cell / GRID_W);
    if (x < bMinX || x > bMaxX || y < mouthTop || y > bMaxY) continue;
    if (deviation[cell] < threshold) continue;
    moving += 1;
    cxSum += x * deviation[cell];
    cySum += y * deviation[cell];
    weight += deviation[cell];
  }

  const base = await frameSize(bedFile);
  const scaleX = base.width / GRID_W;
  const scaleY = base.height / GRID_H;
  let centreX;
  let centreY;
  let spreadX;
  let spreadY;
  let located;

  if (moving >= 3) {
    const meanX = cxSum / weight;
    const meanY = cySum / weight;
    let varX = 0; let varY = 0;
    for (let cell = 0; cell < cells; cell++) {
      const x = cell % GRID_W;
      const y = Math.floor(cell / GRID_W);
      if (x < bMinX || x > bMaxX || y < mouthTop || y > bMaxY) continue;
      if (deviation[cell] < threshold) continue;
      varX += deviation[cell] * (x - meanX) ** 2;
      varY += deviation[cell] * (y - meanY) ** 2;
    }
    centreX = (meanX + 0.5) * scaleX;
    centreY = (meanY + 0.5) * scaleY;
    spreadX = Math.sqrt(varX / weight) * scaleX;
    spreadY = Math.sqrt(varY / weight) * scaleY;
    located = 'motion_in_lower_face';
  } else {
    // Nothing moved measurably in the lower face. Fall back to where a mouth
    // sits in a detected face block rather than patching the wrong feature.
    centreX = (bMinX + blockW * 0.47 + 0.5) * scaleX;
    centreY = (bMinY + blockH * 0.76 + 0.5) * scaleY;
    spreadX = blockW * 0.13 * scaleX;
    spreadY = blockH * 0.10 * scaleY;
    located = 'face_block_geometry';
  }

  const halfW = clamp(Math.max(spreadX * 1.9, blockW * scaleX * 0.20), base.width * 0.045, base.width * 0.105);
  const halfH = clamp(Math.max(spreadY * 1.9, blockH * scaleY * 0.14), base.height * 0.055, base.height * 0.130);

  const even = value => Math.max(2, Math.round(value / 2) * 2);
  let width = even(halfW * 2);
  let height = even(halfH * 2);
  let x = even(clamp(centreX - width / 2, 0, base.width - width));
  let y = even(clamp(centreY - height / 2, 0, base.height - height));
  width = Math.min(width, base.width - x);
  height = Math.min(height, base.height - y);

  return {
    x, y, width, height,
    peak_deviation: Number(maxDeviation.toFixed(2)),
    moving_cells: moving,
    centre: [Math.round(centreX), Math.round(centreY)],
    located_by: located,
    face_block: [
      Math.round(bMinX * scaleX), Math.round(bMinY * scaleY),
      Math.round(blockW * scaleX), Math.round(blockH * scaleY),
    ],
  };
}

// Keep the provider's mouth, discard everything else it touched.
async function blendLipSyncPatch(bedFile, rawSyncedFile, index) {
  const syncedFile = await conformFrameSize(rawSyncedFile, await frameSize(bedFile), index);
  const patch = await locateLipSyncPatch(bedFile, syncedFile);
  const mask = path.join(workDir, `lipsync-mask-${index}.png`);
  await run('ffmpeg', ['-y', '-f', 'lavfi', '-i', `color=black:s=${patch.width}x${patch.height}`,
    '-vf', "geq=lum='255*clip(1.35-1.35*hypot((X-W/2)/(W/2),(Y-H/2)/(H/2)),0,1)'",
    '-frames:v', '1', mask]);

  const bedDuration = await probeDuration(bedFile);
  const out = path.join(workDir, `lipsync-blended-${index}.mp4`);
  await run('ffmpeg', ['-y', '-i', bedFile, '-i', syncedFile, '-loop', '1', '-i', mask,
    '-filter_complex', [
      `[1:v]crop=${patch.width}:${patch.height}:${patch.x}:${patch.y}[roi]`,
      `[2:v]format=gray,scale=${patch.width}:${patch.height}[m]`,
      '[roi][m]alphamerge[patchv]',
      `[0:v][patchv]overlay=${patch.x}:${patch.y}:format=auto[out]`,
    ].join(';'),
    '-map', '[out]', '-an', ...avatarEncodeArgs(), '-t', bedDuration.toFixed(3), out]);

  log(`Lip-sync patch ${patch.width}x${patch.height}+${patch.x}+${patch.y} (peak deviation ${patch.peak_deviation}, ${patch.moving_cells} cells)`);
  return { file: out, patch };
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
  const reference = referenceStill(assets);
  const referenceFile = reference
    ? await cachedDownload(reference.video_url, path.extname(new URL(reference.video_url).pathname) || '.jpg')
    : null;
  if (referenceFile) log(`Persona reference still: ${reference.label || reference.id}`);
  const segments = [];
  const comments = [];
  let cursor = 0;

  for (const event of plan.events || []) {
    const hasComment = request.voice_lipsync === true && typeof event.comment === 'string' && event.comment.trim().length > 0;
    let duration = clamp(Number(event.duration ?? 2.4), 0.8, 8);
    let asset = null;
    let localOverride = null;
    let lipsyncMeta = null;
    let start = clamp(Number(event.time), 0, Math.max(0, totalDuration - 0.1));

    // The asset has to be chosen before the gap is filled: a reaction is placed
    // by its peak, so its start depends on which clip plays. Filling neutral up
    // to the event time first would push the whole reaction a peak-offset late,
    // which is exactly what happened — a peak measured at 9.4s for an event
    // scheduled at 4.5s.
    if (!hasComment) {
      asset = chooseAsset(assets, String(event.type), Number(event.intensity ?? 0.35))
        || neutralAssets[neutralState.index % neutralAssets.length];
      const local = await cachedDownload(asset.video_url, asset.video_url.toLowerCase().includes('.webm') ? '.webm' : '.mp4');
      const full = await assetDuration(asset, local);
      const peak = assetPeak(asset, full);
      start = Number(event.time) - peak;
      duration = full;
    }

    if (start < cursor + 0.08) start = cursor + 0.08;
    if (start >= totalDuration - 0.05) break;
    if (start > cursor) segments.push(...neutralChunks(cursor, start, neutralAssets, neutralState));

    if (hasComment) {
      const useAvatar = Boolean(reference && FAL_KEY && LIPSYNC_MODE === 'avatar');
      const useStill = !useAvatar && Boolean(referenceFile && FAL_KEY);
      if (!useStill && !carriers.length) {
        throw new Error('Voice render requires one enabled speech-ready reusable avatar asset; refusing to fake lip-sync on an unvalidated reaction clip.');
      }
      await progress(jobId, 'tts_generating', { active_comment: event.comment.trim(), absolute_start_s: start });
      const tts = await createTts(event.comment.trim(), comments.length);
      const audioUpload = await uploadToBucket(tts.local, `tmp/lipsync/${jobId}-${comments.length}-voice.mp3`, 'audio/mpeg');

      let baseFile = null;
      let carrierIds = [];
      let synced;
      let generated = null;

      if (useAvatar) {
        await progress(jobId, 'avatar_generating', {
          padded_tts_duration_s: Number(tts.duration.toFixed(3)),
          lipsync_provider: 'fal_kling_ai_avatar',
          lipsync_model: FAL_AVATAR_MODEL,
          absolute_start_s: start,
        });
        generated = await falKlingAvatar({
          index: comments.length,
          imageUrl: reference.video_url,
          audioUrl: audioUpload.url,
          expectedDuration: tts.duration,
        });
        synced = generated;
      } else if (useStill) {
        await progress(jobId, 'speech_still_building', {
          padded_tts_duration_s: Number(tts.duration.toFixed(3)),
          lipsync_source: 'persona_reference_still',
        });
        baseFile = await buildStillVideo(referenceFile, tts.duration, comments.length);
        const baseUpload = await uploadToBucket(baseFile, `tmp/lipsync/${jobId}-${comments.length}-still.mp4`, 'video/mp4');
        await progress(jobId, 'lipsync_fal_running', {
          lipsync_provider: 'fal_kling_lipsync',
          lipsync_model: FAL_LIPSYNC_MODEL,
          absolute_start_s: start,
        });
        synced = await falKlingLipSync({
          index: comments.length,
          videoUrl: baseUpload.url,
          audioUrl: audioUpload.url,
          expectedDuration: tts.duration,
        });
      } else {
        await progress(jobId, 'speech_bed_building', { padded_tts_duration_s: Number(tts.duration.toFixed(3)) });
        const bed = await buildSpeechBed(carriers, tts.duration, comments.length, carrierState);
        baseFile = bed.file;
        carrierIds = bed.carrierIds;
        const bedUpload = await uploadToBucket(bed.file, `tmp/lipsync/${jobId}-${comments.length}-bed.mp4`, 'video/mp4');
        await progress(jobId, 'lipsync_hf_running', {
          lipsync_provider: 'huggingface_public_musetalk',
          lipsync_space: 'trymonolith/MuseTalk',
          absolute_start_s: start,
        });
        synced = await hfMuseTalkLipSync({
          index: comments.length,
          videoUrl: bedUpload.url,
          audioUrl: audioUpload.url,
          expectedDuration: tts.duration,
        });
      }

      // A generated performance is coherent everywhere; the mouth patch exists
      // only to discard a repainted block, so applying it here could only add a
      // seam that is not there.
      let finalSpeech;
      let patch = null;
      if (generated) {
        finalSpeech = referenceFile ? await returnToAnchor(generated.local, referenceFile, comments.length) : generated.local;
      } else {
        const blended = await blendLipSyncPatch(baseFile, synced.local, comments.length);
        patch = blended.patch;
        finalSpeech = useStill ? await addMicroDrift(blended.file, comments.length) : blended.file;
      }

      const plate = await sampleBackgroundColour(finalSpeech);
      const keyDrift = Math.hypot(
        plate.rgb[0] - CHROMA_KEY_RGB[0],
        plate.rgb[1] - CHROMA_KEY_RGB[1],
        plate.rgb[2] - CHROMA_KEY_RGB[2],
      );
      if (keyDrift > 34) {
        log(`WARNING: the spoken clip's plate is 0x${plate.hex}, ${keyDrift.toFixed(0)} away from the calibrated key 0x${BACKGROUND_HEX}; its edges may key differently`);
      }

      const source = generated ? 'generated_from_reference' : useStill ? 'reference_still' : 'speech_bed';
      duration = tts.duration;
      asset = carriers[0] || neutralAssets[0];
      localOverride = finalSpeech;
      lipsyncMeta = { ...synced, carrier_ids: carrierIds, patch, source, plate_hex: plate.hex, plate_drift: Number(keyDrift.toFixed(1)) };
      comments.push({
        start,
        gain_db: tts.gain_db,
        loudness_lufs: tts.loudness_lufs,
        text: event.comment.trim(),
        audioUrl: audioUpload.url,
        local: tts.local,
        duration: tts.duration,
        lead_in_s: SPEECH_PAD_S,
        lipsync_provider: synced.provider,
        lipsync_duration: synced.duration,
        lipsync_cached: synced.cached === true,
        lipsync_source: source,
        speech_carrier_ids: carrierIds,
        lipsync_patch: patch,
        plate_hex: plate.hex,
        plate_drift: Number(keyDrift.toFixed(1)),
      });
    } else {
    }

    duration = Math.min(duration, totalDuration - start);
    segments.push({ start, duration, asset, localOverride, kind: hasComment ? 'comment' : 'reaction', event, lipsyncMeta, peak_s: assetPeak(asset, duration) });
    cursor = start + duration;
  }

  if (cursor < totalDuration) segments.push(...neutralChunks(cursor, totalDuration, neutralAssets, neutralState));
  if (!segments.length) segments.push(...neutralChunks(0, totalDuration, neutralAssets, neutralState));
  return { segments, comments };
}

let BACKGROUND_HEX = '00ff00';
let CHROMA_KEY_RGB = [0, 255, 0];
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

function deliveryVideoKbps(durationSeconds) {
  const budgetBits = MAX_RESULT_BYTES * 8 * 0.94;
  const kbps = Math.floor(budgetBits / Math.max(1, durationSeconds) / 1000) - AUDIO_KBPS;
  return Math.round(clamp(kbps, 1500, 12000));
}

// A CRF encode constrained by VBV keeps short renders at full quality and only
// bites on long ones, where the plan limit would otherwise reject the upload.
async function shrinkResult(file, durationSeconds, kbps) {
  const out = path.join(workDir, 'final-shrunk.mp4');
  await run('ffmpeg', ['-y', '-i', file,
    '-c:v', 'libx264', '-preset', 'medium', '-b:v', `${kbps}k`, '-maxrate', `${kbps}k`, '-bufsize', `${kbps * 2}k`,
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', `${AUDIO_KBPS}k`, '-ar', '48000', '-movflags', '+faststart', out]);
  return out;
}

// Captions use ElevenLabs Scribe rather than the multimodal model that reads the
// source. That is not a contradiction of the rule against STT for source
// understanding — understanding needs the picture, captions need word-level
// timings, and Scribe is the one that returns them.
// Captions need word timings, and the only transcriber that gives them for
// free is the one running on this machine. The hosted route stays as a
// fallback for environments without Python, but it is not the normal path.
async function transcribeLocally(audioFile) {
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'transcribe_local.py');
  const model = process.env.WHISPER_MODEL || 'small';
  const started = Date.now();
  const { stdout } = await run('python3', [script, audioFile, '--model', model]);
  const data = JSON.parse(stdout.trim());
  const words = (Array.isArray(data?.words) ? data.words : [])
    .map(w => ({ text: String(w.text || '').trim(), start: Number(w.start), end: Number(w.end) }))
    .filter(w => w.text && Number.isFinite(w.start) && Number.isFinite(w.end));
  log(`Transcribed locally with ${data.provider} in ${((Date.now() - started) / 1000).toFixed(0)}s: ${words.length} words, language ${data.language} (${data.language_probability})`);
  return { provider: data.provider, words, language: data.language };
}

async function transcribeSource(sourceFile) {
  const audio = path.join(workDir, 'caption-audio.mp3');
  await run('ffmpeg', ['-y', '-i', sourceFile, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '64k', audio]);
  return transcribeLocally(audio);
}

function assTime(seconds) {
  const t = Math.max(0, seconds);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  return `${h}:${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
}

// Short lines, held briefly. Long paragraphs are unreadable on a phone and
// cover more of the frame than they earn.
function groupWords(words, maxWords = 5, maxSeconds = 2.4) {
  const lines = [];
  let current = [];
  for (const word of words) {
    if (!current.length) { current = [word]; continue; }
    const span = word.end - current[0].start;
    const gap = word.start - current[current.length - 1].end;
    if (current.length >= maxWords || span > maxSeconds || gap > 0.7) {
      lines.push(current);
      current = [word];
    } else current.push(word);
  }
  if (current.length) lines.push(current);
  return lines.map(group => ({
    start: group[0].start,
    end: Math.max(group[group.length - 1].end, group[0].start + 0.5),
    text: group.map(w => w.text).join(' '),
  }));
}

async function buildSubtitles(transcript, layout) {
  const lines = groupWords(transcript.words);
  if (!lines.length) return null;

  // Keep the band clear of the cut-out rather than trusting it not to collide:
  // the avatar frame spans the full width of the canvas, so a caption at the
  // bottom would sit across it whenever he is in a bottom corner.
  const atTop = layout.captions === 'top';
  const avatarAtTop = String(layout.avatar || '').startsWith('top_');
  const alignment = atTop ? 8 : 2;
  // MarginV is measured from the edge the text is aligned to, so clearing the
  // cut-out costs its HEIGHT, not the y of its top edge.
  const collides = atTop === avatarAtTop;
  const marginV = collides ? AVATAR_H + 40 : 120;

  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${OUT_W}`,
    `PlayResY: ${OUT_H}`,
    'WrapStyle: 2',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, Italic, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    // White fill, hard black outline and a soft shadow — readable over anything.
    `Style: Caption,DejaVu Sans,64,&H00FFFFFF,&H00000000,&H00000000,1,0,1,5,2,${alignment},90,90,${marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  const body = lines.map(line =>
    `Dialogue: 0,${assTime(line.start)},${assTime(line.end)},Caption,,0,0,0,,${line.text.replace(/\n/g, ' ')}`);

  const file = path.join(workDir, 'captions.ass');
  await fs.writeFile(file, `${header.join('\n')}\n${body.join('\n')}\n`);
  log(`Captions: ${lines.length} lines, ${atTop ? 'top' : 'bottom'} band, margin ${marginV}px`);
  return file;
}

async function composeFinal(source, avatarTrack, comments, totalDuration, sourceHasAudio, despillAvailable, layout, plateFile, subtitleFile, subject) {
  const out = path.join(workDir, 'final.mp4');
  const args = ['-y', '-i', source, '-i', avatarTrack];
  const plateIndex = plateFile ? 2 + comments.length : -1;
  for (const comment of comments) args.push('-i', comment.local);
  if (plateFile) {
    // A still plate has to be looped to cover the timeline; a clip does not.
    if (/\.(png|jpe?g|webp|avif)$/i.test(plateFile)) args.push('-loop', '1', '-i', plateFile);
    else args.push('-stream_loop', '-1', '-i', plateFile);
  }

  const key = [
    'format=rgba',
    `chromakey=0x${BACKGROUND_HEX}:${CHROMA_SIMILARITY}:0.06`,
    despillAvailable ? 'despill=type=green:mix=0.5:expand=0' : null,
  ].filter(Boolean).join(',');

  const corner = String(layout?.avatar || 'bottom_right');
  const cut = subject || { x: 0, width: AVATAR_W };
  const pos = avatarPosition(corner, cut.width);
  const shift = String(layout?.source_shift || 'none');
  // Push the source band clear of the corner the cut-out is taking.
  const srcY = shift === 'down' ? '(H-h)-40' : shift === 'up' ? '40' : '(H-h)/2';

  const filters = [];
  if (plateFile) {
    // The uploaded plate replaces the blurred source as the canvas fill, which
    // is the point of having one: a top corner sits on filler, and filler made
    // of the blurred source is exactly what it should not look like.
    filters.push(`[${plateIndex}:v]scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=increase,crop=${OUT_W}:${OUT_H},setsar=1[bg]`);
    filters.push(`[0:v]scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=decrease[fg]`);
  } else {
    filters.push('[0:v]split=2[srcbg][srcfg]');
    filters.push(`[srcbg]scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=increase,crop=${OUT_W}:${OUT_H},gblur=sigma=28,eq=brightness=-0.13[bg]`);
    filters.push(`[srcfg]scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=decrease[fg]`);
  }
  filters.push(`[bg][fg]overlay=(W-w)/2:${srcY}[base]`);
  filters.push(`[1:v]${key},crop=${cut.width}:${AVATAR_H}:${cut.x}:0[avatar]`);
  // Flush to the corner: the reference frame already cuts his body at the
  // right and bottom edges, so any margin would expose those straight cuts.
  if (subtitleFile) {
    filters.push(`[base][avatar]overlay=${pos.x}:${pos.y}:format=auto[composited]`);
    filters.push(`[composited]subtitles='${subtitleFile.replace(/'/g, "\\'")}'[vout]`);
  } else {
    filters.push(`[base][avatar]overlay=${pos.x}:${pos.y}:format=auto[vout]`);
  }

  let audioMap = null;
  if (comments.length) {
    const labels = [];
    comments.forEach((comment, index) => {
      const inputIndex = 2 + index;
      const delay = Math.max(0, Math.round(comment.start * 1000));
      const label = `c${index}`;
      filters.push(`[${inputIndex}:a]aresample=48000,volume=${Number(comment.gain_db ?? 0).toFixed(2)}dB,adelay=delays=${delay}:all=1,apad=whole_dur=${totalDuration.toFixed(3)},atrim=duration=${totalDuration.toFixed(3)}[${label}]`);
      labels.push(`[${label}]`);
    });
    if (labels.length === 1) filters.push(`${labels[0]}anull[voice]`);
    else filters.push(`${labels.join('')}amix=inputs=${labels.length}:duration=first:normalize=0[voice]`);

    if (sourceHasAudio) {
      filters.push(`[0:a]aresample=48000,apad=whole_dur=${totalDuration.toFixed(3)},atrim=duration=${totalDuration.toFixed(3)}[srca]`);
      filters.push('[voice]asplit=2[voice_sc][voice_mix]');
      filters.push('[srca][voice_sc]sidechaincompress=threshold=0.03:ratio=12:attack=5:release=280[ducked]');
      filters.push('[ducked][voice_mix]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.89:attack=5:release=60[aout]');
      audioMap = '[aout]';
    } else {
      filters.push('[voice]alimiter=limit=0.89:attack=5:release=60[voiceout]');
      audioMap = '[voiceout]';
    }
  }

  args.push('-filter_complex', filters.join(';'), '-map', '[vout]');
  if (audioMap) args.push('-map', audioMap);
  else if (sourceHasAudio) args.push('-map', '0:a:0');
  const kbps = deliveryVideoKbps(totalDuration);
  args.push('-t', totalDuration.toFixed(3), '-c:v', 'libx264', '-preset', 'medium', '-crf', '21',
    '-maxrate', `${kbps}k`, '-bufsize', `${kbps * 2}k`, '-pix_fmt', 'yuv420p');
  if (audioMap || sourceHasAudio) args.push('-c:a', 'aac', '-b:a', `${AUDIO_KBPS}k`, '-ar', '48000');
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
    // Distinct code so a draining loop knows the queue is empty and stops,
    // rather than paying for another pass.
    log('No queued reaction job; exiting cleanly.');
    process.exit(3);
  }

  claimedJob = claim.job;
  const assets = claim.assets || [];
  const request = claimedJob.render_meta?.render_request || {};
  if (!claimedJob.reaction_plan || typeof claimedJob.reaction_plan !== 'object') throw new Error('Queued render job has no saved reaction_plan');
  const neutralPool = enabledAssets(assets).filter(asset => asset.reaction_type === 'neutral' && asset.speech_ready !== true);
  if (!neutralPool.length) throw new Error('No enabled neutral avatar asset');
  if (request.voice_lipsync === true && !speechCarriers(assets).length && !(referenceStill(assets) && FAL_KEY)) {
    throw new Error('Voice render requires either a persona reference still with FAL_KEY, or one enabled speech-ready avatar asset');
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
  CHROMA_KEY_RGB = background.rgb;
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
  const layout = claimedJob.reaction_plan?.layout || null;
  const plateAsset = layout?.needs_background ? backgroundPlate(assets) : null;
  const plateFile = plateAsset
    ? await cachedDownload(plateAsset.video_url, path.extname(new URL(plateAsset.video_url).pathname) || '.jpg')
    : null;
  if (layout?.needs_background && !plateFile) {
    log('Layout asked for a top corner but no background plate is enabled; falling back to bottom-right');
  }
  const effectiveLayout = layout && (!layout.needs_background || plateFile)
    ? layout
    : { avatar: 'bottom_right', captions: layout?.captions || 'none', source_shift: 'none', needs_background: false };
  log(`Layout: avatar=${effectiveLayout.avatar} shift=${effectiveLayout.source_shift} plate=${plateFile ? 'yes' : 'no'} captions=${effectiveLayout.captions}`);

  // Captions only when the source has speech and does not already carry its own.
  let subtitleFile = null;
  let captionMeta = { requested: effectiveLayout.captions, applied: false };
  if (effectiveLayout.captions !== 'none' && claimedJob.reaction_plan?.has_speech !== false && sourceHasAudio) {
    await progress(claimedJob.id, 'captions_transcribing', { caption_zone: effectiveLayout.captions });
    try {
      // libass is not universally compiled in; without it the burn would fail
      // at the very last filter, after every expensive stage has already run.
      if (!(await ffmpegHasFilter('subtitles'))) throw new Error('this ffmpeg has no subtitles filter (libass missing)');
      const transcript = await transcribeSource(source);
      subtitleFile = await buildSubtitles(transcript, effectiveLayout);
      captionMeta = {
        requested: effectiveLayout.captions,
        applied: Boolean(subtitleFile),
        provider: transcript.provider,
        language: transcript.language || null,
        word_count: transcript.words.length,
      };
    } catch (error) {
      // A caption failure must not cost the whole render.
      log('Captions skipped:', error instanceof Error ? error.message : String(error));
      captionMeta = { requested: effectiveLayout.captions, applied: false, error: String(error).slice(0, 200) };
    }
  }

  const subject = await subjectBounds(referenceLocal, background.hex, chroma.similarity);
  log(`Subject occupies ${subject.width}px of the ${AVATAR_W}px avatar frame, from x=${subject.x}`);

  let final = await composeFinal(source, avatarTrack, comments, duration, sourceHasAudio, despillAvailable, effectiveLayout, plateFile, subtitleFile, subject);
  let finalBytes = (await fs.stat(final)).size;
  if (finalBytes > MAX_RESULT_BYTES) {
    const retryKbps = Math.round(deliveryVideoKbps(duration) * 0.82);
    log(`Result is ${(finalBytes / 1048576).toFixed(1)} MB, over the ${(MAX_RESULT_BYTES / 1048576).toFixed(0)} MB upload limit; re-encoding at ${retryKbps}k`);
    final = await shrinkResult(final, duration, retryKbps);
    finalBytes = (await fs.stat(final)).size;
  }
  if (finalBytes > MAX_RESULT_BYTES) {
    throw new Error(`Result is ${(finalBytes / 1048576).toFixed(1)} MB and still exceeds the ${(MAX_RESULT_BYTES / 1048576).toFixed(0)} MB upload limit`);
  }
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
    layout: effectiveLayout,
    subject_crop: subject,
    captions: captionMeta,
    chroma_key_hex: background.hex,
    chroma_similarity: chroma.similarity,
    chroma_calibration: chroma,
    chroma_despill: despillAvailable,
    source_analysis_mode: claimedJob.render_meta?.source_analysis_mode || 'saved_preview_plan',
    event_count: plan.events?.length || 0,
    segment_count: segments.length,
    transition_mode: 'anchor_hard_cut',
    comment_count: comments.length,
    lipsync_provider: comments[0]?.lipsync_provider || null,
    lipsync_source: comments[0]?.lipsync_source || null,
    speech_pad_s: SPEECH_PAD_S,
    timeline_clock: 'absolute_preserved_hardcut_v2',
    audio_mix: 'measured_voice_ducked_limited_v2',
    voice_target_lufs: VOICE_TARGET_LUFS,
    final_validation: validation,
    result_bytes: finalBytes,
    delivery_video_kbps: deliveryVideoKbps(duration),
    comments: comments.map(comment => ({
      start: comment.start,
      text: comment.text,
      duration: comment.duration,
      lead_in_s: comment.lead_in_s,
      lipsync_provider: comment.lipsync_provider,
      lipsync_duration: comment.lipsync_duration,
      speech_carrier_ids: comment.speech_carrier_ids,
      lipsync_patch: comment.lipsync_patch,
      lipsync_source: comment.lipsync_source,
      lipsync_cached: comment.lipsync_cached,
      plate_hex: comment.plate_hex,
      plate_drift: comment.plate_drift,
      voice_loudness_lufs: comment.loudness_lufs,
      voice_gain_db: comment.gain_db,
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
