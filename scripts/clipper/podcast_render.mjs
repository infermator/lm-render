#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import {
  activeSpeakerCropFilter,
  buildTranscriptSrt,
  normalizedSpeakerCenters,
  speakerAt,
  speakerIntervalsForWindow,
  validateAlignmentArtifactMetadata,
  validatePodcastWindow,
  wordsForWindow,
} from './podcast_media.mjs';

const MAM_BASE = String(process.env.MAM_BASE || 'https://reaction-lab-coral.vercel.app').replace(/\/$/, '');
const SECRET = String(process.env.BUFFER_PUSH_SECRET || process.env.REACTION_PIPELINE_SECRET || '').trim();
// Match the OG Stream V2 renderer's alias precedence exactly. GitHub currently
// supplies SUPABASE_URL + MAM_SUPABASE_SERVICE_ROLE_KEY; explicit SHOTLEE_*
// names remain the unambiguous local override when both forms exist.
const STORAGE_URL = String(process.env.SHOTLEE_SUPABASE_URL || process.env.SUPABASE_URL || '').replace(/\/$/, '');
const STORAGE_KEY = String(process.env.SHOTLEE_SUPABASE_SERVICE_ROLE_KEY || process.env.MAM_SUPABASE_SERVICE_ROLE_KEY || '').trim();
const EXACT_VOD_ID = String(process.env.VOD_ID || '').trim();
const DISPATCH_TOKEN = String(process.env.DISPATCH_TOKEN || '').trim();
const SHARD_INDEX = Math.max(0, Math.floor(Number(process.env.SHARD_INDEX || 0)));
const WORKER_RUN_ID = [
  process.env.GITHUB_RUN_ID || `local-${Date.now()}`,
  process.env.GITHUB_RUN_ATTEMPT || '1',
  process.env.CLIPPER_WORKER_INSTANCE || String(process.pid),
].join('-');
const STORAGE_BUCKET = 'clipper-media';
const MAX_COMPRESSED_ARTIFACT_BYTES = 32 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 128 * 1024 * 1024;

if (!SECRET) throw new Error('Existing BUFFER_PUSH_SECRET / REACTION_PIPELINE_SECRET is missing');
if (!STORAGE_URL || !STORAGE_KEY) throw new Error('Existing CLIPPER storage credentials are missing');

async function api(route, body, timeoutMs = 180_000) {
  const response = await fetch(`${MAM_BASE}${route}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let payload = {};
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = { error: text }; }
  if (!response.ok) throw new Error(`${route} HTTP ${response.status}: ${payload?.error || text || 'unknown error'}`);
  return payload;
}

async function progress(renderId, stage, message = '') {
  try {
    return await api('/api/clipper/progress', { render_id: renderId, stage, message, worker_run_id: WORKER_RUN_ID });
  } catch (error) {
    console.warn(`[podcast-render] progress ${stage} failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

async function completeRender(payload) {
  let lastError = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await api('/api/clipper/complete', payload);
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (/HTTP 4\d\d/.test(message) || attempt === 3) throw error;
      await new Promise(resolve => setTimeout(resolve, 600 * (2 ** attempt)));
    }
  }
  throw lastError || new Error('Podcast render completion failed');
}

function run(command, args, options = {}) {
  const { redact = [], ...spawnOptions } = options;
  const printable = args.map(value => redact.includes(value) ? '[REDACTED_URL]' : value);
  console.log(`[podcast-render] $ ${command} ${printable.join(' ')}`);
  const result = spawnSync(command, args, { stdio: 'inherit', ...spawnOptions });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited ${result.status}`);
}

function runCapture(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited ${result.status}: ${(result.stderr || '').slice(-1600)}`);
  return result.stdout || '';
}

function findDownloadedFile(dir) {
  const preferred = ['batch.mp4', 'batch.mkv', 'batch.webm', 'batch.mov'];
  for (const name of preferred) {
    const target = path.join(dir, name);
    if (fs.existsSync(target) && fs.statSync(target).size > 1024) return target;
  }
  const match = fs.readdirSync(dir).find(name => /^batch\./.test(name) && fs.statSync(path.join(dir, name)).isFile());
  return match ? path.join(dir, match) : null;
}

function storageObjectUrl(bucket, objectPath) {
  const encoded = objectPath.split('/').map(encodeURIComponent).join('/');
  return `${STORAGE_URL}/storage/v1/object/${encodeURIComponent(bucket)}/${encoded}`;
}

async function downloadArtifact(vod) {
  const bucket = String(vod.transcript_storage_bucket || '');
  const objectPath = String(vod.transcript_storage_path || '');
  const expectedHash = String(vod.transcript_sha256 || '').toLowerCase();
  const expectedBytes = Math.floor(Number(vod.transcript_bytes || 0));
  if (bucket !== STORAGE_BUCKET) throw new Error(`Transcript artifact bucket must be ${STORAGE_BUCKET}`);
  if (!/^[0-9a-f]{64}$/.test(expectedHash)) throw new Error('Transcript artifact SHA-256 is invalid');
  if (objectPath !== `podcasts/${vod.id}/analysis/${expectedHash}.json.gz`) {
    throw new Error('Transcript artifact path is not its content-addressed Podcast object');
  }
  if (expectedBytes < 1 || expectedBytes > MAX_COMPRESSED_ARTIFACT_BYTES) throw new Error('Transcript artifact size is invalid');

  const response = await fetch(storageObjectUrl(bucket, objectPath), {
    headers: { Authorization: `Bearer ${STORAGE_KEY}`, apikey: STORAGE_KEY },
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`Transcript artifact download HTTP ${response.status}`);
  const compressed = Buffer.from(await response.arrayBuffer());
  if (compressed.length !== expectedBytes) throw new Error(`Transcript artifact size mismatch (${compressed.length} != ${expectedBytes})`);
  const actualHash = crypto.createHash('sha256').update(compressed).digest('hex');
  if (actualHash !== expectedHash) throw new Error('Transcript artifact SHA-256 mismatch');
  const decoded = gunzipSync(compressed, { maxOutputLength: MAX_ARTIFACT_BYTES });
  const artifact = JSON.parse(decoded.toString('utf8'));
  if (artifact?.schema_version !== 'clipper-podcast-analysis-v1' || String(artifact?.vod_id || '') !== String(vod.id)) {
    throw new Error('Transcript artifact schema or VOD identity mismatch');
  }
  return artifact;
}

async function downloadAlignmentArtifact(vodId, rawMetadata, root) {
  const metadata = validateAlignmentArtifactMetadata(vodId, rawMetadata);
  const response = await fetch(storageObjectUrl(metadata.bucket, metadata.path), {
    headers: { Authorization: `Bearer ${STORAGE_KEY}`, apikey: STORAGE_KEY },
    signal: AbortSignal.timeout(180_000),
  });
  if (!response.ok) throw new Error(`Podcast alignment artifact download HTTP ${response.status}`);
  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength && contentLength !== metadata.bytes) {
    throw new Error(`Podcast alignment artifact Content-Length mismatch (${contentLength} != ${metadata.bytes})`);
  }
  const payload = Buffer.from(await response.arrayBuffer());
  if (payload.length !== metadata.bytes) {
    throw new Error(`Podcast alignment artifact size mismatch (${payload.length} != ${metadata.bytes})`);
  }
  const actualHash = crypto.createHash('sha256').update(payload).digest('hex');
  if (actualHash !== metadata.sha256) throw new Error('Podcast alignment artifact SHA-256 mismatch');
  const target = path.join(root, 'alignment-master.flac');
  fs.writeFileSync(target, payload);
  return target;
}

function uploadObject(localPath, objectPath, contentType, { upsert = false } = {}) {
  const result = spawnSync('curl', [
    '-fsS', '--connect-timeout', '20', '--max-time', '300',
    '-X', 'POST', storageObjectUrl(STORAGE_BUCKET, objectPath),
    '-H', `Authorization: Bearer ${STORAGE_KEY}`,
    '-H', `apikey: ${STORAGE_KEY}`,
    '-H', `x-upsert: ${upsert ? 'true' : 'false'}`,
    '-H', `Content-Type: ${contentType}`,
    '--data-binary', `@${localPath}`,
  ], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`storage upload exited ${result.status}`);
}

function probe(file) {
  return JSON.parse(runCapture('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file]));
}

function escapeSubtitlePath(filePath) {
  return filePath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

function fitBlurFilter(captionSuffix) {
  return `[0:v]split=2[bg0][fg0];[bg0]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,gblur=sigma=28,eq=brightness=-0.16[bg];[fg0]scale=1080:1920:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2${captionSuffix}[v]`;
}

function centerCropFilter(captionSuffix) {
  return `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920${captionSuffix}[v]`;
}

function sampleTimes(intervals, duration) {
  const samples = [];
  const seen = new Set();
  for (const interval of intervals) {
    const midpoint = Math.max(0.15, Math.min(duration - 0.15, (Number(interval.start) + Number(interval.end)) / 2));
    const key = `${interval.speaker}:${midpoint.toFixed(1)}`;
    if (!seen.has(key) && Number.isFinite(midpoint)) {
      seen.add(key);
      samples.push({ time_s: Number(midpoint.toFixed(3)), speaker: interval.speaker });
    }
    if (samples.length >= 24) break;
  }
  if (samples.length < 4) {
    for (const fraction of [0.18, 0.4, 0.62, 0.84]) {
      const time = Math.max(0.15, Math.min(duration - 0.15, duration * fraction));
      samples.push({ time_s: Number(time.toFixed(3)), speaker: null });
    }
  }
  return samples.slice(0, 24);
}

function estimateSpeakerCenters(source, intervals, duration, work) {
  try {
    const samplesPath = path.join(work, 'speaker-samples.json');
    const samples = sampleTimes(intervals, duration);
    fs.writeFileSync(samplesPath, JSON.stringify(samples), 'utf8');
    const raw = runCapture('python3', [path.resolve('scripts/clipper/podcast_speaker_frames.py'), source, samplesPath]);
    const analysis = JSON.parse(raw);
    return {
      centers: normalizedSpeakerCenters(analysis?.speaker_centers),
      analysis: {
        method: analysis?.method || null,
        source: analysis?.source || null,
        speaker_evidence_count: analysis?.speaker_evidence_count || {},
        samples_inspected: Array.isArray(analysis?.samples) ? analysis.samples.length : 0,
      },
    };
  } catch (error) {
    return {
      centers: {},
      analysis: { error: error instanceof Error ? error.message : String(error) },
    };
  }
}

function extractConfirmationFrames(source, artifact, absoluteStart, duration, work) {
  const frames = [];
  for (const [index, fraction] of [0.14, 0.38, 0.62, 0.86].entries()) {
    const localTime = Math.max(0.1, Math.min(duration - 0.1, duration * fraction));
    const framePath = path.join(work, `confirm-${index}.jpg`);
    run('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y', '-ss', localTime.toFixed(3), '-i', source,
      '-frames:v', '1', '-vf', "scale='min(512,iw)':-2", '-q:v', '7', framePath,
    ]);
    const data = fs.readFileSync(framePath);
    if (data.length > 330_000) throw new Error(`Confirmation frame ${index + 1} is unexpectedly large`);
    const absoluteTime = absoluteStart + localTime;
    frames.push({
      time_s: Number(absoluteTime.toFixed(3)),
      speaker: speakerAt(artifact, absoluteTime),
      data_url: `data:image/jpeg;base64,${data.toString('base64')}`,
    });
  }
  return frames;
}

function centersFromConfirmation(confirmation, fallback) {
  const result = { ...normalizedSpeakerCenters(fallback) };
  for (const [speaker, position] of Object.entries(confirmation?.speaker_positions || {})) {
    if (result[speaker] != null) continue;
    if (position === 'left') result[speaker] = 0.25;
    if (position === 'center') result[speaker] = 0.5;
    if (position === 'right') result[speaker] = 0.75;
  }
  return result;
}

function chooseLayout(plan, confirmation, centers, intervals) {
  const requested = String(plan?.output?.requested_layout || plan?.output?.layout || 'fit_blur');
  if (requested === 'center_crop') return 'center_crop';
  if (!confirmation?.confirmed) return 'fit_blur';
  if (confirmation.held_object || confirmation.screen_content || confirmation.recommended_layout === 'two_shot') return 'fit_blur';
  if (confirmation.recommended_layout === 'center_crop') return 'center_crop';
  const knownIntervals = intervals.filter(interval => Number.isFinite(Number(centers?.[interval.speaker])));
  if (confirmation.recommended_layout === 'active_speaker' && knownIntervals.length) return 'active_speaker';
  return 'fit_blur';
}

function alignAnchor({ batchAudio, alignmentAudio, anchor, expectedLocal, duration, work, index }) {
  const reference = path.join(work, `rss-reference-${index}.wav`);
  run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y', '-ss', anchor.toFixed(3), '-i', String(alignmentAudio),
    '-t', duration.toFixed(3), '-vn', '-ac', '1', '-ar', '4000', '-c:a', 'pcm_s16le', reference,
  ]);
  const raw = runCapture('python3', [
    path.resolve('scripts/clipper/podcast_audio_align.py'), batchAudio, reference,
    expectedLocal.toFixed(3), '--radius-s', '82',
  ]);
  const result = JSON.parse(raw);
  const confidence = Number(result?.confidence);
  const margin = Number(result?.margin);
  if (!result?.ok || !Number.isFinite(confidence) || confidence < 0.24 || !Number.isFinite(margin) || margin < 0.008) {
    throw new Error(`audio_alignment_unverified: weak RSS/YouTube correlation at ${anchor.toFixed(1)}s (confidence=${confidence.toFixed?.(3) || confidence}, margin=${margin.toFixed?.(3) || margin})`);
  }
  return result;
}

function alignCandidateAudio({ batchAudio, alignmentAudio, audioSourceKind, start, end, batchStart, work }) {
  if (audioSourceKind === 'youtube_fallback') {
    // Transcript audio and delivery video came from the same canonical
    // YouTube source. Their timestamps share one clock, and trying to pass the
    // watch-page URL to ffmpeg as though it were an RSS enclosure is invalid.
    return {
      schema_version: 'clipper-podcast-av-alignment-v1',
      verified: true,
      source_mode: 'youtube_fallback_same_source',
      rss_to_video_shift_s: 0,
      anchor_spread_s: 0,
      anchors: [],
    };
  }
  if (!alignmentAudio) throw new Error('audio_alignment_unverified: podcast alignment audio is missing');
  const duration = end - start;
  const referenceDuration = Math.max(6, Math.min(12, duration * 0.22));
  const firstAnchor = Math.min(end - referenceDuration, start + Math.max(2, Math.min(8, duration * 0.15)));
  const lastAnchor = Math.max(firstAnchor, end - referenceDuration - 2);
  const anchors = [firstAnchor];
  if (lastAnchor - firstAnchor >= referenceDuration + 2) anchors.push(lastAnchor);
  const matches = anchors.map((anchor, index) => alignAnchor({
    batchAudio,
    alignmentAudio,
    anchor,
    expectedLocal: anchor - batchStart,
    duration: referenceDuration,
    work,
    index,
  }));
  const shifts = matches.map((match, index) => (
    batchStart + Number(match.match_start_s) - anchors[index]
  ));
  if (shifts.some(value => !Number.isFinite(value))) throw new Error('audio_alignment_unverified: non-finite RSS/YouTube offset');
  const spread = Math.max(...shifts) - Math.min(...shifts);
  if (spread > 0.8) {
    throw new Error(`audio_alignment_unverified: RSS/YouTube offset changes ${spread.toFixed(3)}s inside this clip (dynamic insertion or different master)`);
  }
  const shift = shifts.reduce((total, value) => total + value, 0) / shifts.length;
  return {
    schema_version: 'clipper-podcast-av-alignment-v1',
    verified: true,
    rss_to_video_shift_s: Number(shift.toFixed(6)),
    anchor_spread_s: Number(spread.toFixed(6)),
    anchors: anchors.map((anchor, index) => ({ rss_time_s: anchor, ...matches[index] })),
  };
}

async function completeFailure(render, message, extra = {}) {
  try {
    await completeRender({
      render_id: render.id,
      ok: false,
      render_meta: { worker: 'lm-render/clipper-v3-podcast', worker_run_id: WORKER_RUN_ID, ...extra },
      error: String(message).slice(0, 2800),
    });
  } catch (error) {
    console.error(`[podcast-render] failed to report ${render.id}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function renderCandidate({ render, candidate, vod, artifact, batchSource, batchAudio, alignmentAudio, batchStart, batchIdentity, root }) {
  const plan = render.edit_plan || {};
  const { start, end, duration } = validatePodcastWindow(
    plan?.candidate?.start_s ?? candidate.clip_start_s,
    plan?.candidate?.end_s ?? candidate.clip_end_s,
  );
  const work = path.join(root, String(render.id));
  fs.mkdirSync(work, { recursive: true });
  await progress(render.id, 'materializing_cuts', 'Verifying RSS-to-YouTube audio alignment before cutting');
  const alignment = alignCandidateAudio({
    batchAudio,
    alignmentAudio,
    audioSourceKind: vod.audio_source_kind,
    start,
    end,
    batchStart,
    work,
  });
  const localStart = start + alignment.rss_to_video_shift_s - batchStart;
  const batchDuration = Number(probe(batchSource).format?.duration || 0);
  if (localStart < -0.05 || localStart + duration > batchDuration + 0.05) {
    throw new Error('audio_alignment_unverified: aligned candidate falls outside the shared materialization');
  }
  await progress(render.id, 'materializing_cuts', `Cutting aligned ${duration.toFixed(1)}s podcast window`);
  const source = path.join(work, 'candidate-source.mp4');
  run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y', '-ss', Math.max(0, localStart).toFixed(3), '-i', batchSource,
    '-t', duration.toFixed(3), '-map', '0:v:0', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'veryfast',
    '-crf', '20', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', source,
  ]);

  const intervals = speakerIntervalsForWindow(artifact, start, end);
  const speakerEstimate = estimateSpeakerCenters(source, intervals, duration, work);
  await progress(render.id, 'visual_confirm', 'Checking speaker positions and visual preservation from four sampled frames');
  let visualConfirmation = null;
  let visualConfirmationError = null;
  try {
    const frames = extractConfirmationFrames(source, artifact, start, duration, work);
    const confirmed = await api('/api/clipper/podcast/confirm', {
      render_id: render.id,
      worker_run_id: WORKER_RUN_ID,
      frames,
      local_speaker_centers: speakerEstimate.centers,
    });
    visualConfirmation = confirmed.confirmation || null;
  } catch (error) {
    visualConfirmationError = error instanceof Error ? error.message : String(error);
    if (/HTTP 409|stale|unowned/i.test(visualConfirmationError)) throw error;
    console.warn(`[podcast-render] visual confirmation fallback for ${render.id}: ${visualConfirmationError}`);
  }

  const centers = centersFromConfirmation(visualConfirmation, speakerEstimate.centers);
  const layout = chooseLayout(plan, visualConfirmation, centers, intervals);
  const captionPath = path.join(work, 'captions.srt');
  const captionWords = plan?.output?.captions === false ? [] : wordsForWindow(artifact, start, end);
  const srt = buildTranscriptSrt(captionWords);
  if (srt.trim()) fs.writeFileSync(captionPath, srt, 'utf8');
  const captionSuffix = srt.trim()
    ? `,subtitles='${escapeSubtitlePath(captionPath)}':force_style='FontName=DejaVu Sans,FontSize=18,Bold=1,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,Outline=3,Shadow=0,Alignment=2,MarginV=190'`
    : '';

  const sourceProbe = probe(source);
  const sourceVideo = (sourceProbe.streams || []).find(stream => stream.codec_type === 'video') || {};
  const activeFilter = layout === 'active_speaker' ? activeSpeakerCropFilter({
    width: sourceVideo.width,
    height: sourceVideo.height,
    centers,
    intervals,
    captionSuffix,
  }) : null;
  const actualLayout = activeFilter ? 'active_speaker' : layout === 'center_crop' ? 'center_crop' : 'fit_blur';
  const filter = activeFilter || (actualLayout === 'center_crop' ? centerCropFilter(captionSuffix) : fitBlurFilter(captionSuffix));
  await progress(render.id, 'composing', `Rendering 1080x1920 podcast edit (${actualLayout})`);
  const output = path.join(work, 'video.mp4');
  run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y', '-i', source, '-filter_complex', filter,
    '-map', '[v]', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-r', String(Number(plan?.output?.fps || 30)),
    '-movflags', '+faststart', output,
  ]);

  const resultProbe = probe(output);
  const resultVideo = (resultProbe.streams || []).find(stream => stream.codec_type === 'video') || {};
  const outputDuration = Number(resultProbe.format?.duration || 0);
  if (Number(resultVideo.width) !== 1080 || Number(resultVideo.height) !== 1920) {
    throw new Error(`Unexpected podcast output geometry ${resultVideo.width}x${resultVideo.height}`);
  }
  if (!Number.isFinite(outputDuration) || Math.abs(outputDuration - duration) > 1.5) {
    throw new Error(`Unexpected podcast output duration ${outputDuration.toFixed(2)}s for ${duration.toFixed(2)}s plan`);
  }

  const lease = await progress(render.id, 'uploading', 'Uploading immutable podcast render');
  if (!lease || lease.ignored) throw new Error('stale_worker_run: Podcast render lease changed before upload');
  // Keep the established signer namespace so Podcast outputs work through the
  // same Shotlee edge fallback as Stream V2 results.
  const resultStoragePath = `renders/${candidate.id}/${render.id}/video.mp4`;
  // Retrying the same leased render id may find an orphan object uploaded just
  // before a lost completion response. Upsert is safe for that unpublished row.
  uploadObject(output, resultStoragePath, 'video/mp4', { upsert: true });
  await progress(render.id, 'finalizing', 'Persisting podcast render result and QC');
  await completeRender({
    render_id: render.id,
    ok: true,
    // Podcast batch materialization is intentionally runner-ephemeral. Keeping
    // it would make source video, rather than final outputs, the dominant
    // compounding storage cost. Stream V2 retains its established source copy.
    source_storage_path: null,
    result_storage_path: resultStoragePath,
    render_meta: {
      worker: 'lm-render/clipper-v3-podcast',
      worker_run_id: WORKER_RUN_ID,
      source_window_s: [start, end],
      shared_materialization: { ephemeral: true, identity: batchIdentity, start_s: batchStart },
      audio_alignment: alignment,
      layout: actualLayout,
      requested_layout: plan?.output?.requested_layout || plan?.output?.layout || null,
      transcript_reuse: {
        schema_version: artifact.schema_version,
        storage_path: vod.transcript_storage_path,
        sha256: vod.transcript_sha256,
        word_count: captionWords.length,
        captions_created: Boolean(srt.trim()),
      },
      speaker_framing: {
        intervals: intervals.length,
        centers,
        local_analysis: speakerEstimate.analysis,
      },
      visual_confirmation: visualConfirmation,
      visual_confirmation_error: visualConfirmationError,
      ffprobe: resultProbe,
    },
    qc_json: {
      passed: true,
      width: Number(resultVideo.width),
      height: Number(resultVideo.height),
      duration_s: outputDuration,
      transcript_captions: Boolean(srt.trim()),
      visual_confirmation: Boolean(visualConfirmation),
    },
  });
  console.log(`[podcast-render] completed ${render.id} -> ${resultStoragePath}`);
}

async function main() {
  const claim = await api('/api/clipper/podcast/render/claim', {
    vod_id: EXACT_VOD_ID || undefined,
    worker_run_id: WORKER_RUN_ID,
    batch_size: 5,
    shard_index: SHARD_INDEX,
    dispatch_token: DISPATCH_TOKEN || undefined,
  });
  const renders = Array.isArray(claim.renders) ? claim.renders : [];
  const candidates = Array.isArray(claim.candidates) ? claim.candidates : [];
  if (!renders.length) {
    console.log('[podcast-render] queue empty');
    process.exitCode = 3;
    return;
  }
  const vod = claim.vod;
  const candidateById = new Map(candidates.map(candidate => [String(candidate.id), candidate]));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `clipper-podcast-${String(vod.id).slice(0, 8)}-`));
  const batchStart = Number(claim.batch?.materialization_start_s);
  const batchEnd = Number(claim.batch?.materialization_end_s);
  const batchDuration = batchEnd - batchStart;
  const completed = new Set();
  let failures = 0;

  try {
    if (!Number.isFinite(batchStart) || !Number.isFinite(batchEnd) || batchStart < 0 || batchDuration <= 0 || batchDuration > 900.01) {
      throw new Error(`Invalid shared podcast materialization window (${batchStart}-${batchEnd})`);
    }
    for (const render of renders) await progress(render.id, 'downloading', `Materializing one shared ${batchDuration.toFixed(1)}s source window`);
    const sourcePattern = path.join(root, 'batch.%(ext)s');
    run('yt-dlp', [
      '--no-playlist', '--js-runtimes', 'node', '--remote-components', 'ejs:github',
      '--download-sections', `*${batchStart}-${batchEnd}`, '--force-keyframes-at-cuts',
      '--merge-output-format', 'mp4', '-f', 'bv*+ba/b', '-o', sourcePattern, String(vod.video_source_url),
    ]);
    const downloaded = findDownloadedFile(root);
    if (!downloaded) throw new Error('yt-dlp completed without a podcast video source');

    for (const render of renders) await progress(render.id, 'normalizing', 'Normalizing the shared podcast source once');
    const batchSource = path.join(root, 'batch-source.mp4');
    run('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y', '-i', downloaded, '-map', '0:v:0', '-map', '0:a?',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', '-b:a', '192k',
      '-movflags', '+faststart', batchSource,
    ]);
    const batchAudio = path.join(root, 'batch-audio.wav');
    run('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y', '-i', batchSource,
      '-vn', '-ac', '1', '-ar', '4000', '-c:a', 'pcm_s16le', batchAudio,
    ]);
    const artifact = await downloadArtifact(vod);
    const audioSourceKind = String(vod.audio_source_kind || '');
    if (!['rss', 'direct', 'youtube_fallback'].includes(audioSourceKind)) {
      throw new Error(`Unsupported Podcast alignment source kind: ${audioSourceKind || 'missing'}`);
    }
    let alignmentAudio = null;
    if (audioSourceKind !== 'youtube_fallback') {
      for (const render of renders) await progress(render.id, 'normalizing', 'Loading the verified reusable RSS alignment proxy');
      alignmentAudio = await downloadAlignmentArtifact(vod.id, artifact?.ingest_meta?.alignment_audio, root);
    }
    const batchIdentity = crypto.createHash('sha256')
      .update(renders.map(render => String(render.id)).sort().join('\n'))
      .digest('hex').slice(0, 16);
    for (const render of renders) {
      const candidate = candidateById.get(String(render.candidate_id));
      if (!candidate) {
        failures += 1;
        await completeFailure(render, 'Claimed podcast render has no matching candidate', { shared_materialization_id: batchIdentity });
        completed.add(render.id);
        continue;
      }
      try {
        await renderCandidate({ render, candidate, vod, artifact, batchSource, batchAudio, alignmentAudio, batchStart, batchIdentity, root });
      } catch (error) {
        failures += 1;
        const message = error instanceof Error ? error.stack || error.message : String(error);
        console.error(`[podcast-render] failed ${render.id}: ${message}`);
        await completeFailure(render, message, { shared_materialization_id: batchIdentity });
      }
      completed.add(render.id);
    }
  } catch (error) {
    failures += renders.length - completed.size;
    const message = error instanceof Error ? error.stack || error.message : String(error);
    console.error(`[podcast-render] batch failed: ${message}`);
    for (const render of renders) {
      if (!completed.has(render.id)) await completeFailure(render, message, { failure_scope: 'shared_materialization' });
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  if (failures) process.exitCode = 1;
}

await main();
