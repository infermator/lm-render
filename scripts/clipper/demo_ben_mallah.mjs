#!/usr/bin/env node
/**
 * Private, non-publishing, reproducible creative before/after smoke using an
 * EXISTING completed Ben Mallah V3 result as the baseline. This is a finishing
 * pass, NOT a new source render and not an A/B retention claim.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { buildHookAss, normalizeCreativeMedia, zoomFilter } from './creative_media.mjs';
import { wordsForWindow } from './podcast_media.mjs';
import { checkRenderedVideo } from './content_qc.mjs';
import { captionCompositeFilter } from './ffmpeg_filters.mjs';

const url = String(process.env.SHOTLEE_SUPABASE_URL || process.env.SUPABASE_URL || '').replace(/\/$/, '');
const key = String(process.env.SHOTLEE_SUPABASE_SERVICE_ROLE_KEY || process.env.MAM_SUPABASE_SERVICE_ROLE_KEY || '');
const root = process.env.CLIPPER_DEMO_OUT || path.resolve('clipper-demo-output');
if (!url || !key) throw new Error('Expected private storage credentials (SUPABASE_URL + MAM_SUPABASE_SERVICE_ROLE_KEY)');
fs.mkdirSync(root, { recursive: true });
const sourceStart = 3920;
const duration = 46.55;
const transcriptSha = '3d63ac1737002880e09b72fd83af0e0de8f5671f8e67fddb8f02d4d609907caa';
const vodId = '09f68e91-d8f9-4755-92d9-c720a4059a11';
const oldRender = '9af55619-1bce-4131-acb7-e85971d021dc'; // v14: licensed Mixkit bed
const candidateId = 'f25a54d7-373c-410e-a5aa-97a5af7bcccb';
const output = {
  before: path.join(root, 'ben-mallah-before-v14.mp4'),
  after: path.join(root, 'ben-mallah-after-creative-preview.mp4'),
  compare: path.join(root, 'ben-mallah-comparison-10s.mp4'),
  report: path.join(root, 'report.json'),
};
async function privateGet(storagePath, maxBytes) {
  const objectUrl = url + '/storage/v1/object/clipper-media/' + storagePath.split('/').map(encodeURIComponent).join('/');
  const response = await fetch(objectUrl, { headers: { Authorization: 'Bearer ' + key, apikey: key },
    signal: AbortSignal.timeout(110000) });
  if (!response.ok) throw new Error('Private preview asset unavailable: HTTP ' + response.status);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0 || bytes.length > maxBytes) throw new Error('Unexpected demo asset size');
  return bytes;
}
function run(args) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', ...args],
    { encoding: 'utf8', timeout: 210000, maxBuffer: 1024 * 1024 });
  if (r.error || r.status !== 0) throw new Error('ffmpeg preview failed: ' + String(r.error?.message || r.stderr || r.status).slice(-1000));
}
const original = await privateGet('renders/' + candidateId + '/' + oldRender + '/video.mp4', 160 * 1024 * 1024);
fs.writeFileSync(output.before, original);
const zipped = await privateGet('podcasts/' + vodId + '/analysis/' + transcriptSha + '.json.gz', 32 * 1024 * 1024);
if (crypto.createHash('sha256').update(zipped).digest('hex') !== transcriptSha)
  throw new Error('Canonical transcript checksum mismatch');
const artifact = JSON.parse(gunzipSync(zipped, { maxOutputLength: 128 * 1024 * 1024 }).toString('utf8'));
if (artifact.vod_id !== vodId) throw new Error('Transcript source does not match baseline VOD');
const words = wordsForWindow(artifact, sourceStart, sourceStart + duration);
if (words.length < 15) throw new Error('Not enough verified Ben Mallah source words for preview');
fs.writeFileSync(path.join(root, 'transcript-words.json'), JSON.stringify(words, null, 2));
const spoken = words.map(w => w.text).join(' ').toLowerCase().replace(/[^a-z0-9]+/g, ' ');
const firstPhrase = spoken.includes('you don t use the 50 rule')
  ? "You don't use the 50% rule"
  : words.slice(0, 8).map(w => w.text).join(' ').replace(/\s+([,.!?])/g, '$1');
const accent = words.find(w => Number(w.start) >= 8 && Number(w.start) <= 17 && /^(expenses|payroll|rents|cashflow|money|profit|revenue)[,.!?]?$/i.test(w.text))
  || words.find(w => Number(w.start) >= 8 && Number(w.start) <= 15 && /\w/.test(w.text));
if (!accent) throw new Error('Could not find source-grounded zoom anchor');
const emphasized = words.filter(w => /\$[\d,]+|million|thousand/i.test(w.text)).map(w => w.text).slice(0, 3);
const plan = normalizeCreativeMedia({
  schema_version: 'clipper-creative-v1',
  enabled: true,
  editing_style: 'balanced',
  hook_text: firstPhrase,
  emphasis_words: emphasized,
  zoom_cues: [{ at_s: Number(accent.start), duration_s: 0.75, scale: 1.09, anchor: accent.text }],
  music_curve: [],
}, words, duration);
if (!plan.hookText || plan.zoomCues.length !== 1) throw new Error('Grounded creative demo plan was rejected');
const hookAss = buildHookAss(plan.hookText, duration);
const hookPath = path.join(root, 'ben-mallah-hook.ass');
fs.writeFileSync(hookPath, hookAss, 'utf8');
// The comparison baseline already has baked-in V3 captions and licensed music.
// Do not draw an unrelated second caption layer or remaster/replace its music.
const zoom = zoomFilter(plan.zoomCues, 'base', 'hook_source');
const videoFilter = '[0:v]scale=1080:1920[base];' + zoom
  + ';' + '[hook_source]subtitles=filename=' + "'" + hookPath.replace(/'/g, "\\'") + "'" + '[v]';
run(['-i', output.before, '-filter_complex', videoFilter, '-map', '[v]', '-map', '0:a?',
  '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-b:a', '160k', '-r', '30', '-movflags', '+faststart', output.after]);
const qcBefore = checkRenderedVideo(output.before, { sourceHasAudio: true, expectedDuration: duration });
const qcAfter = checkRenderedVideo(output.after, { sourceHasAudio: true, expectedDuration: duration });
if (!qcBefore.passed || !qcAfter.passed) throw new Error('Before/after clip QC failed: ' + JSON.stringify({ qcBefore, qcAfter }));
run(['-i', output.before, '-i', output.after, '-filter_complex',
  "[0:v]trim=duration=10,setpts=PTS-STARTPTS,scale=540:960,drawtext=text='BEFORE':fontcolor=white:fontsize=30:x=24:y=909:box=1:boxcolor=black@0.7:boxborderw=8[l];"
  + "[1:v]trim=duration=10,setpts=PTS-STARTPTS,scale=540:960,drawtext=text='AFTER':fontcolor=white:fontsize=30:x=24:y=909:box=1:boxcolor=black@0.7:boxborderw=8[r];"
  + '[l][r]hstack=inputs=2[v]', '-map', '[v]', '-map', '1:a?', '-t', '10', '-c:v', 'libx264',
  '-preset', 'veryfast', '-crf', '24', '-c:a', 'aac', '-b:a', '128k', output.compare]);
const report = {
  schema_version: 'clipper-ben-mallah-creative-demo-v1',
  original_render_id: oldRender,
  baseline_version: 14,
  baseline_license: 'licensed',
  original_clip_source_window_s: [sourceStart, sourceStart + duration],
  original_transcript_sha256: transcriptSha,
  transcript_words: words.length,
  applied_creative_plan: plan,
  before_qc: qcBefore,
  after_qc: qcAfter,
  disclaimer: 'Preview finishes an existing 9:16 captioned/mixed render. It does not demonstrate the upstream V3 re-transcription, framing or full remaster stages.',
};
fs.writeFileSync(output.report, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ...report, files: output }, null, 2));
