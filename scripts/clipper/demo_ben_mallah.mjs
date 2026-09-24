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
import { buildEditorialCaptionsAss, normalizeEditorialCards } from './editorial_captions.mjs';
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
// Editorial v2: the first successful demo used one barely-visible 9% zoom
// and a top quote. Replace it with visible full-clip typography, 5 purposeful
// camera punches and six verified topic cards, using the exact same source
// frames and bit-identical licensed audio. This remains a non-publishing preview.
const rawCards = [
  { at_s: 0, text: "You don't use the 50 % rule." },
  { at_s: 6.1, text: '100 plus units' },
  { at_s: 11.55, text: 'all these expenses' },
  { at_s: 30.8, text: "don't cash flow" },
  { at_s: 37.15, text: 'You flip single family houses' },
  { at_s: 43.3, text: "Don't ever buy a house for cash flow" },
];
const editorialCards = normalizeEditorialCards(rawCards, words, duration);
if (editorialCards.length < 4) throw new Error('Canonical Ben Mallah transcript did not verify enough editorial cards');
const editorialAssPath = path.join(root, 'ben-mallah-editorial.ass');
fs.writeFileSync(editorialAssPath, buildEditorialCaptionsAss(words, {
  duration, cards: rawCards, emphasisWords: ['expenses', 'cash', 'flow', 'flip'],
}), 'utf8');
// The green baked-in legacy captions are inside the source MP4, so a dark
// bottom scrim must be composited BEFORE zoom. Fresh V3 jobs never need it:
// editorial_captions.mjs is drawn directly over the original uncaptioned VOD.
const gradientPath = path.join(root, 'temporary-caption-scrim.png');
run(['-f', 'lavfi', '-i', 'color=c=0x04090F:s=1080x1920:r=30:d=0.1',
  '-vf', "format=yuva420p,geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='if(lt(Y,1320),0,if(lt(Y,1470),246*(Y-1320)/150,if(lt(Y,1765),246,if(lt(Y,1885),246*(1885-Y)/120,0))))'",
  '-frames:v', '1', '-pix_fmt', 'rgba', gradientPath]);
const editorialZooms = [
  [5.05, 7.35, 1.125], [10.6, 13.7, 1.16], [19, 21.5, 1.09],
  [40.15, 41.95, 1.13], [43.3, 46.36, 1.16],
];
let zoomExpression = '1';
for (const [a, stop, scale] of [...editorialZooms].reverse()) {
  zoomExpression = 'if(between(on,' + Math.round(a * 30) + ','
    + Math.round(stop * 30) + '),' + scale + ',' + zoomExpression + ')';
}
const editorialGraph = "[0:v][1:v]overlay=0:0:shortest=1[precovered];"
  + "[precovered]fps=30,zoompan=z='" + zoomExpression
  + "':x='iw/2-iw/zoom/2':y='0':d=1:s=1080x1920:fps=30[zoom];"
  + "[zoom]ass=filename='" + editorialAssPath.replace(/'/g, "\\'") + "'[v]";
run(['-i', output.before, '-loop', '1', '-i', gradientPath,
  '-filter_complex', editorialGraph, '-map', '[v]', '-map', '0:a?',
  '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
  '-c:a', 'copy', '-movflags', '+faststart', output.after]);

const qcBefore = checkRenderedVideo(output.before, { sourceHasAudio: true, expectedDuration: duration });
const qcAfter = checkRenderedVideo(output.after, { sourceHasAudio: true, expectedDuration: duration });
if (!qcBefore.passed || !qcAfter.passed) throw new Error('Before/after clip QC failed: ' + JSON.stringify({ qcBefore, qcAfter }));
// Side-by-side samples seven important moments at the SAME original timestamps,
// not just the first 10 seconds (which hid the payoff and camera treatment).
const moments = [0.12, 5.05, 10.85, 19, 29.35, 36.65, 43.2];
const comparisonGraph = [];
for (const [index, at] of moments.entries()) {
  const stop = Number((at + 1.7).toFixed(3));
  for (const [sourceIndex, name, label] of [[0, 'before', 'BEFORE'], [1, 'after', 'AFTER']]) {
    comparisonGraph.push('[' + sourceIndex + ':v]trim=start=' + at + ':end=' + stop
      + ',setpts=PTS-STARTPTS,fps=30,scale=540:960,setsar=1,drawtext=text=' + label
      + ':fontcolor=white:fontsize=29:box=1:boxcolor=black@0.72:boxborderw=8:x=24:y=908[' + name + index + ']');
  }
  comparisonGraph.push('[before' + index + '][after' + index + ']hstack=inputs=2[v' + index + ']');
  comparisonGraph.push('[1:a]atrim=start=' + at + ':end=' + stop
    + ',asetpts=PTS-STARTPTS[a' + index + ']');
}
comparisonGraph.push(moments.map((_, index) => '[v' + index + '][a' + index + ']').join('')
  + 'concat=n=' + moments.length + ':v=1:a=1[v][a]');
run(['-i', output.before, '-i', output.after, '-filter_complex', comparisonGraph.join(';'),
  '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22',
  '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', output.compare]);

const report = {
  schema_version: 'clipper-ben-mallah-creative-demo-v1',
  original_render_id: oldRender,
  baseline_version: 14,
  baseline_license: 'licensed',
  original_clip_source_window_s: [sourceStart, sourceStart + duration],
  original_transcript_sha256: transcriptSha,
  transcript_words: words.length,
  applied_creative_plan: plan,
  editorial_v2: { caption_px: 76, max_words: 4, cards: editorialCards,
    zoom_windows: editorialZooms, verified_source_words: words.length,
    audio_passthrough: true, original_renderer: 'clipper-v3-podcast' },
  before_qc: qcBefore,
  after_qc: qcAfter,
  disclaimer: 'Preview finishes an existing 9:16 captioned/mixed render. It does not demonstrate the upstream V3 re-transcription, framing or full remaster stages.',
};
fs.writeFileSync(output.report, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ...report, files: output }, null, 2));
