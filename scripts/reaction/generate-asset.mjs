/**
 * Generates one reusable persona reaction clip and registers it in MAM.
 *
 * The persona's HQ still is passed as BOTH the first and the last frame, so every
 * clip opens and closes on the identical anchor pose. That is what lets the
 * renderer join segments with hard cuts and loop a clip without a visible seam —
 * the whole timeline strategy depends on it, so it is not optional here.
 *
 *   node scripts/reaction/generate-asset.mjs smirk_a
 *   node scripts/reaction/generate-asset.mjs --list
 *
 * Needs FAL_KEY, SUPABASE_URL and MAM_SUPABASE_SERVICE_ROLE_KEY.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

function run(bin, args) {
  // ffmpeg writes its banner and per-frame progress to stderr; inherited, it
  // buries the one line that matters.
  return execFileSync(bin, ['-hide_banner', '-loglevel', 'error', ...args], { encoding: 'utf8' });
}

const BACKEND = String(process.env.VIDEO_BACKEND || 'fal').trim(); // fal | openrouter
const FAL_KEY = String(process.env.FAL_KEY || '').trim();
const OPENROUTER_KEY = String(process.env.OPENROUTER_API_KEY || '').trim();

// OpenRouter serves video on its own endpoint, not through /api/v1/models —
// which is why a check against that list wrongly concluded it had no video
// models at all. Kling v3 standard is $0.126/s here against $0.084/s on fal.
const OPENROUTER_MODEL = String(process.env.OPENROUTER_VIDEO_MODEL || 'kwaivgi/kling-v3.0-std').trim();
const OPENROUTER_PRICE_PER_S = Number(process.env.OPENROUTER_VIDEO_PRICE_PER_S || 0.126);
const SUPABASE_URL = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_KEY = String(process.env.MAM_SUPABASE_SERVICE_ROLE_KEY || '');
const PERSONA = String(process.env.REACTION_PERSONA || 'default').trim();
const MODEL = String(process.env.FAL_VIDEO_MODEL || 'fal-ai/kling-video/v3/standard/image-to-video').trim();

// Field names differ per family, and getting one wrong costs a round trip
// through the queue before the API says so.
const MODEL_SPECS = {
  'fal-ai/kling-video/v3/standard/image-to-video': { start: 'start_image_url', end: 'end_image_url', pricePerS: 0.084, durationAsString: true },
  'fal-ai/kling-video/v3/pro/image-to-video':      { start: 'start_image_url', end: 'end_image_url', pricePerS: 0.112, durationAsString: true },
  'fal-ai/kling-video/o1/standard/image-to-video': { start: 'start_image_url', end: 'end_image_url', pricePerS: 0.084, durationAsString: true },
  'bytedance/seedance-2.0/image-to-video':         { start: 'image_url', end: 'end_image_url', pricePerS: 0.24, durationAsString: true },
  'fal-ai/bytedance/seedance/v1/pro/image-to-video': { start: 'image_url', end: 'end_image_url', pricePerS: 0.05, durationAsString: true, extra: { resolution: '1080p' } },
  'fal-ai/veo3.1/fast/first-last-frame-to-video':  { start: 'first_frame_url', end: 'last_frame_url', pricePerS: 0.15, durations: [4, 6, 8], extra: { generate_audio: false, resolution: '1080p' } },
  'fal-ai/wan-flf2v':                              { start: 'start_image_url', end: 'end_image_url', pricePerS: 0.02 },
};
const SPEC = MODEL_SPECS[MODEL] || { start: 'start_image_url', end: 'end_image_url', pricePerS: 0.112, durationAsString: true };
const PRICE_PER_S = Number(process.env.FAL_VIDEO_PRICE_PER_S || SPEC.pricePerS);

// Anchoring both ends in the request costs the performance. Measured on the same
// model, prompt and seed budget: with an end frame the smirk peaked at 1.79
// against the first frame, without it at 9.47. Forced to land back on an
// identical frame within three seconds, the model simply barely moves.
//
// So the clip is generated free and anchored afterwards, by morphing its tail
// back to the reference still. That restores the anchor (7.27 -> 0.72) while
// leaving the expression untouched (9.47 -> 9.45).
const USE_END_FRAME = process.env.FAL_END_FRAME === '1';
const ANCHOR_FADE_S = Number(process.env.FAL_ANCHOR_FADE_S || 0.45);
const ANCHOR_MODE = String(process.env.FAL_ANCHOR_MODE || 'pingpong').trim(); // pingpong | trim | morph | none

// Asking for the return in the prompt is not the same as pinning the last frame
// in the request. The flat attempts did both at once; this is the direction on
// its own.
// Piling on instructions made this worse, not better. A short prompt is the
// baseline these models are actually tuned for.
const MINIMAL = process.env.FAL_PROMPT_MODE === 'minimal';
const MINIMAL_COMMON = 'Static locked-off camera, plain green screen background, photoreal, same person and framing as the image.';

const RELEASE_DIRECTION = ' Finally the expression drains away completely and he returns to the same calm, neutral, attentive watching face he had at the very start, settling back into exactly the posture and gaze he began with, and holds it there.';
const BUCKET = 'reaction-media';

// Shared by every clip. Lifted out of the per-clip prompts so a change lands
// everywhere at once and the clips stay a matched set.
// Deliberately short. The first attempt spent nine sentences forbidding motion
// against one describing the performance, and the model obeyed the majority: the
// smirk was not readable at all.
//
// No @Image1/@Image2 references: that syntax belongs to the o1 endpoint and v3
// rejects the request outright with "Invalid reference index 1 for image".
// Detailed but deliberately silent about the ending. Asking the model to finish
// on the reference pose is what flattened every earlier attempt; the tail is
// morphed home afterwards instead.
const COMMON = [
  'Photoreal footage of the exact same young man from the reference image, in the same black hoodie with the same white wired earbuds, seated in the same chair against the same flat chroma-green studio backdrop.',
  'He sits on the right of the frame in a medium close-up, turned in a three-quarter view away from the camera, watching something off-screen to his left at eye level. He never looks into the lens and never turns to face the camera.',
  'The camera is locked off on a tripod: no pan, no tilt, no zoom, no handheld drift, no reframing, no cuts.',
  'Lighting stays exactly as in the reference — soft key from the front left, his face, jaw and chin evenly lit, the green backdrop clean, flat and evenly lit with no shadows falling on it.',
  'His head and shoulders stay in the same place in the frame; only his face performs.',
  'Skin is photoreal and unretouched, with visible pores, stubble and natural texture. Hair keeps its individual strands. No beauty filter, no smoothing, no waxy or plastic CGI look, no cartoon exaggeration.',
  'He does not speak, does not mouth words, and his hands never enter the frame.',
].join(' ');

const NEGATIVE = [
  'talking, mouthing words, speaking,',
  'turning toward camera, head turn, profile change, camera movement, zoom, reframing, posture change,',
  'hands, hand gestures, objects, furniture, background change, background motion, uneven green,',
  'identity change, different face, plastic skin, beauty filter, blur, distort, low quality',
].join(' ');

const PRESETS = {
  neutral_a: {
    minimal: 'He watches something off-screen, calm and attentive. He breathes and blinks once. Nothing else changes.',
    label: 'Neutral A',
    reactionType: 'neutral',
    duration: 5,
    performance: 'A still idle beat: breathing, one blink, no expression change.',
  },
  neutral_b: {
    minimal: 'He watches something off-screen, calm and still. He blinks once and breathes. No expression change.',
    label: 'Neutral B',
    reactionType: 'neutral',
    duration: 5,
    performance: 'A quiet idle beat, three seconds of a man simply watching. He breathes. He blinks once, unhurried. His eyes drift a few degrees along whatever he is watching and come back. His head and shoulders settle by a couple of millimetres, the way a person shifts without noticing. His expression stays calm, attentive and completely neutral from the first frame to the last — no amusement, no surprise, no reaction of any kind. The stillness is the performance.',
  },
  smirk_a: {
    minimal: 'He watches something off-screen, then smirks — one corner of his mouth lifts, amused and knowing — then his face relaxes back to neutral.',
    label: 'Smirk A',
    reactionType: 'smirk',
    duration: 5,
    performance: 'He watches, neutral. Then something in what he is watching quietly amuses him, and it surfaces on his face: one corner of his mouth draws up and back into a clear, lopsided smirk, the cheek on that side lifting with it, the eyes narrowing slightly and creasing at the outer corner the way a real smile reaches the eyes. He holds it, enjoying it privately. It is the look of someone thinking "of course that happened" — knowing, a little smug, entirely closed-mouthed. No wide grin, no teeth, no laugh. Then it eases off and his face relaxes.',
  },
  cringe_a: {
    minimal: 'He watches something off-screen, then winces with second-hand embarrassment, then his face relaxes back to neutral.',
    label: 'Cringe A',
    reactionType: 'cringe',
    duration: 5,
    performance: 'He watches, neutral. Then something lands awkwardly and he winces with second-hand embarrassment: the mouth pulls tight and sideways, the nose wrinkles, one eye squints half shut, the brow tightens, the chin tucks slightly and his head draws back an inch as if to get away from it. His shoulders lift a fraction. It is the face of someone watching another person embarrass themselves — pained and sympathetic, not disgusted, not frightened, not comic. He holds the wince a moment, then lets it drain away.',
  },
  disbelief_a: {
    minimal: 'He watches something off-screen, narrows his eyes in disbelief and shakes his head once slowly, then his face relaxes back to neutral.',
    label: 'Disbelief A',
    reactionType: 'disbelief',
    duration: 5,
    performance: 'He watches, neutral. Then something he cannot accept happens, and disbelief settles over his face: the eyes narrow, one eyebrow climbs while the other stays down, the lips press together and push slightly to one side, the jaw sets. He gives a single slow shake of the head, small but unmistakable, the way someone says "no way" without speaking. He keeps watching throughout. Then his face loosens again.',
  },
  surprise_a: {
    minimal: 'He watches something off-screen, then his eyes widen and eyebrows lift in surprise, then his face relaxes back to neutral.',
    label: 'Surprise A',
    reactionType: 'surprise',
    duration: 5,
    performance: 'He watches, neutral. Then something genuinely unexpected happens: his eyes widen, his eyebrows jump up, his lips part slightly and his head pulls back and up a little as the moment registers. The whole face opens for a beat. It is real, human surprise — the flinch of not seeing something coming — not shock, not fear, not exaggerated reaction acting. Then it settles and his expression closes again.',
  },
  suspicious_a: {
    minimal: 'He watches something off-screen, then narrows his eyes suspiciously and leans in slightly, then his face relaxes back to neutral.',
    label: 'Suspicious A',
    reactionType: 'suspicious',
    duration: 5,
    performance: 'He watches, neutral. Then doubt creeps in: both eyes narrow into a sceptical squint, one eyebrow lowers, one side of his mouth tightens, and his head tilts a few degrees and leans in slightly, as if trying to see what he is missing. He studies it. It is the look of someone who does not buy what he is being shown. He holds the scrutiny, then eases back.',
  },
  smirk_b: {
    minimal: 'He watches something off-screen, then a slow half-smile pulls at one side of his mouth as he tilts his head slightly, then it fades and he goes neutral again.',
    label: 'Smirk B',
    reactionType: 'smirk',
    duration: 5,
    performance: 'A slower, more knowing smirk with a small head tilt, then a return to neutral.',
  },
  cringe_b: {
    minimal: 'He watches something off-screen, then sucks air through his teeth and screws up one side of his face in second-hand embarrassment, then relaxes back to neutral.',
    label: 'Cringe B',
    reactionType: 'cringe',
    duration: 5,
    performance: 'A sharper wince with a tightened mouth, then a return to neutral.',
  },
  surprise_b: {
    minimal: 'He watches something off-screen, then his head pulls back and his eyebrows shoot up in surprise, then he settles back to neutral.',
    label: 'Surprise B',
    reactionType: 'surprise',
    duration: 5,
    performance: 'Surprise carried by a backward head movement rather than the eyes alone.',
  },
  disbelief_b: {
    minimal: 'He watches something off-screen, then blinks slowly and tilts his head in flat disbelief, then his face relaxes back to neutral.',
    label: 'Disbelief B',
    reactionType: 'disbelief',
    duration: 5,
    performance: 'Deadpan disbelief with a slow blink and a head tilt, then a return to neutral.',
  },
  laugh_a: {
    minimal: 'He watches something off-screen, then laughs quietly with his mouth closed, shoulders shaking, then his face relaxes back to neutral.',
    label: 'Laugh A',
    reactionType: 'laugh',
    duration: 5,
    performance: 'He watches, neutral. Then something genuinely funny gets him and he laughs, but silently and with his mouth closed: the cheeks push up, the eyes crease and narrow almost shut, the nostrils flare slightly, and his shoulders and chest shake two or three times with the laugh while his head dips forward. It is warm, involuntary and clearly visible, the laugh of someone trying not to make noise. Then he recovers and his face settles.',
  },
};

function fail(message) {
  console.error(`[generate-asset] ${message}`);
  process.exit(1);
}

async function fal(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { Authorization: `Key ${FAL_KEY}`, 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!response.ok) throw new Error(`fal ${response.status}: ${JSON.stringify(data).slice(0, 800)}`);
  return data;
}

async function openrouter(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { Authorization: `Bearer ${OPENROUTER_KEY}`, 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!response.ok) throw new Error(`openrouter ${response.status}: ${JSON.stringify(data).slice(0, 800)}`);
  return data;
}

// Returns a URL for the finished clip.
async function generateOnOpenRouter({ prompt, imageUrl, duration, useEndFrame }) {
  const frames = [{ type: 'image_url', image_url: { url: imageUrl }, frame_type: 'first_frame' }];
  if (useEndFrame) frames.push({ type: 'image_url', image_url: { url: imageUrl }, frame_type: 'last_frame' });

  const queued = await openrouter('https://openrouter.ai/api/v1/videos', {
    method: 'POST',
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      prompt,
      duration,
      aspect_ratio: '16:9',
      generate_audio: false,
      frame_images: frames,
    }),
  });
  const id = String(queued.id || '');
  const pollUrl = String(queued.polling_url || (id ? `https://openrouter.ai/api/v1/videos/${id}` : ''));
  if (!pollUrl) fail(`OpenRouter did not queue the job: ${JSON.stringify(queued).slice(0, 400)}`);

  const deadline = Date.now() + 20 * 60 * 1000;
  let status = String(queued.status || 'queued');
  let last = queued;
  while (!['completed', 'failed', 'cancelled', 'expired'].includes(status)) {
    if (Date.now() > deadline) fail('OpenRouter video job timed out after 20 minutes');
    await new Promise(resolve => setTimeout(resolve, 6000));
    last = await openrouter(pollUrl);
    if (String(last.status || '') !== status) console.log(`[generate-asset] ${last.status}`);
    status = String(last.status || '');
  }
  if (status !== 'completed') fail(`OpenRouter video job ${status}: ${JSON.stringify(last).slice(0, 600)}`);

  const direct = Array.isArray(last.unsigned_urls) ? String(last.unsigned_urls[0] || '') : '';
  return direct || `https://openrouter.ai/api/v1/videos/${id}/content?index=0`;
}

async function supabase(pathname, options = {}) {
  const response = await fetch(`${SUPABASE_URL}${pathname}`, {
    ...options,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      ...(options.headers || {}),
    },
  });
  if (!response.ok) throw new Error(`supabase ${pathname} -> ${response.status}: ${(await response.text()).slice(0, 400)}`);
  return response;
}

async function main() {
  const key = String(process.argv[2] || '').trim();
  if (!key || key === '--list') {
    console.log('Presets:');
    for (const [name, preset] of Object.entries(PRESETS)) {
      console.log(`  ${name.padEnd(14)} ${preset.label.padEnd(12)} ${preset.reactionType.padEnd(11)} ${preset.duration}s`);
    }
    process.exit(key ? 0 : 1);
  }
  const preset = PRESETS[key];
  if (!preset) fail(`Unknown preset "${key}". Run with --list.`);
  if (BACKEND === 'fal' && !FAL_KEY) fail('FAL_KEY missing');
  if (BACKEND === 'openrouter' && !OPENROUTER_KEY) fail('OPENROUTER_API_KEY missing');
  if (!SUPABASE_URL || !SUPABASE_KEY) fail('SUPABASE_URL / MAM_SUPABASE_SERVICE_ROLE_KEY missing');

  const query = new URLSearchParams({
    persona: `eq.${PERSONA}`,
    reaction_type: 'eq.reference',
    enabled: 'is.true',
    select: 'id,label,video_url',
    limit: '1',
  });
  const rows = await (await supabase(`/rest/v1/reaction_assets?${query}`)).json();
  const reference = rows[0];
  if (!reference) fail(`No enabled reference still for persona "${PERSONA}". Upload one in Reaction Lab first.`);
  console.log(`[generate-asset] reference: ${reference.video_url}`);

  const prompt = MINIMAL
    ? `${preset.minimal || preset.performance} ${MINIMAL_COMMON}`
    : `${preset.performance}${process.env.FAL_RELEASE === '1' ? RELEASE_DIRECTION : ''} ${COMMON}`;
  let duration = preset.duration;
  if (SPEC.durations && !SPEC.durations.includes(duration)) {
    duration = SPEC.durations.reduce((best, value) => (Math.abs(value - preset.duration) < Math.abs(best - preset.duration) ? value : best));
    console.log(`[generate-asset] ${MODEL} only offers ${SPEC.durations.join('/')}s; using ${duration}s`);
  }

  const payload = {
    prompt,
    ...(MINIMAL ? {} : { negative_prompt: NEGATIVE }),
    [SPEC.start]: reference.video_url,
    duration: SPEC.durationAsString === false ? duration : String(duration),
    ...(SPEC.extra || {}),
  };
  if (USE_END_FRAME) payload[SPEC.end] = reference.video_url;
  else console.log('[generate-asset] end frame OFF — the clip will not return to the anchor on its own');

  const backendModel = BACKEND === 'openrouter' ? OPENROUTER_MODEL : MODEL;
  const pricePerS = BACKEND === 'openrouter' ? OPENROUTER_PRICE_PER_S : PRICE_PER_S;
  console.log(`[generate-asset] ${preset.label} — ${duration}s via ${backendModel} (~$${(duration * pricePerS).toFixed(2)})`);

  let videoUrl;
  if (BACKEND === 'openrouter') {
    videoUrl = await generateOnOpenRouter({ prompt, imageUrl: reference.video_url, duration, useEndFrame: USE_END_FRAME });
  } else {
  const queued = await fal(`https://queue.fal.run/${MODEL}`, { method: 'POST', body: JSON.stringify(payload) });
  const statusUrl = String(queued.status_url || '');
  const responseUrl = String(queued.response_url || '');
  if (!statusUrl || !responseUrl) fail(`fal did not queue: ${JSON.stringify(queued).slice(0, 400)}`);

  const deadline = Date.now() + 20 * 60 * 1000;
  let status = String(queued.status || 'IN_QUEUE');
  while (status !== 'COMPLETED') {
    if (Date.now() > deadline) fail('fal timed out after 20 minutes');
    await new Promise(resolve => setTimeout(resolve, 6000));
    const poll = await fal(statusUrl);
    if (String(poll.status || '') !== status) console.log(`[generate-asset] ${poll.status}`);
    status = String(poll.status || '');
    if (status === 'FAILED' || status === 'ERROR') fail(`fal failed: ${JSON.stringify(poll).slice(0, 600)}`);
  }

  const result = await fal(responseUrl);
  videoUrl = String(result?.video?.url || '');
  if (!videoUrl) fail(`fal returned no video: ${JSON.stringify(result).slice(0, 400)}`);
  }

  // fal's own URLs are temporary, so the clip is stored in our bucket before it
  // is registered — the library has to survive without them.
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'reaction-gen-'));
  const local = path.join(workDir, `${key}.mp4`);
  const download = await fetch(videoUrl, BACKEND === 'openrouter' && videoUrl.includes('openrouter.ai')
    ? { headers: { Authorization: `Bearer ${OPENROUTER_KEY}` } }
    : undefined);
  if (!download.ok) fail(`Could not download the generated clip: HTTP ${download.status}`);
  const bytes = Buffer.from(await download.arrayBuffer());
  await fs.writeFile(local, bytes);

  // Restore the anchor the request deliberately did not ask for.
  let upload = local;
  let loopReport = null;

  // Cutting beats blending. A cross-dissolve back to the still ghosts, because
  // the head has drifted by then and two positions get double-exposed. Instead
  // the clip is scanned for the frame that genuinely matches frame 0 and cut
  // there, which is a real loop rather than a disguised one.
  // Forward to the peak of the expression, then the same run reversed. The last
  // frame IS the first frame, so the loop is exact by construction rather than
  // by luck — and the reverse of an expression forming is an expression fading,
  // which is what the reaction does anyway.
  //
  // Trimming to the closest frame was not enough: the model never returns to its
  // own opening frame. The hair alone keeps drifting, and a difference pass shows
  // clear outlines around the head and the earbud cable at the best match found.
  if (!USE_END_FRAME && ANCHOR_MODE === 'pingpong') {
    const grid = path.join(workDir, 'scan.raw');
    const W = 48; const H = 44;
    run('ffmpeg', ['-y', '-i', local, '-vf', `scale=${W}:${H}`, '-pix_fmt', 'gray', '-f', 'rawvideo', grid]);
    const bytes = await fs.readFile(grid);
    const cells = W * H;
    const frames = [];
    for (let i = 0; i + cells <= bytes.length; i += cells) frames.push(bytes.subarray(i, i + cells));
    const distance = (a, b) => {
      let total = 0;
      for (let i = 0; i < cells; i++) total += Math.abs(a[i] - b[i]);
      return total / cells;
    };
    // An idle clip has no peak to find — the largest difference from frame 0 is
    // just whichever frame caught a blink. Neutrals ping-pong whole, which also
    // makes them the longest clips in the library, and they are the ones that
    // repeat most.
    let peak = { index: frames.length - 1, score: 0 };
    if (preset.reactionType !== 'neutral') {
      peak = { index: 1, score: -1 };
      for (let i = 1; i < frames.length; i++) {
        const score = distance(frames[0], frames[i]);
        if (score > peak.score) peak = { index: i, score };
      }
    }
    const probe = run('ffprobe', ['-select_streams', 'v:0', '-show_entries', 'stream=r_frame_rate', '-of', 'json', local]);
    const fps = Math.round(eval(JSON.parse(probe).streams[0].r_frame_rate)) || 24;
    const seconds = (peak.index + 1) / fps;

    const forward = path.join(workDir, 'fwd.mp4');
    const reverse = path.join(workDir, 'rev.mp4');
    const list = path.join(workDir, 'pp.txt');
    const enc = ['-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-pix_fmt', 'yuv420p'];
    run('ffmpeg', ['-y', '-i', local, '-t', seconds.toFixed(3), '-an', ...enc, forward]);
    run('ffmpeg', ['-y', '-i', forward, '-vf', 'reverse', '-an', ...enc, reverse]);
    await fs.writeFile(list, `file '${forward}'\nfile '${reverse}'\n`);
    upload = path.join(workDir, 'pingpong.mp4');
    run('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', upload]);

    loopReport = {
      mode: 'pingpong',
      peak_s: Number(seconds.toFixed(3)),
      peak_distance: Number(peak.score.toFixed(2)),
      exact: true,
    };
    console.log(`[generate-asset] ping-pong loop: forward to the peak at ${seconds.toFixed(2)}s, then reversed`);
  }

  if (!USE_END_FRAME && ANCHOR_MODE === 'trim') {
    const grid = path.join(workDir, 'scan.raw');
    const W = 48; const H = 44;
    run('ffmpeg', ['-y', '-i', local, '-vf', `scale=${W}:${H}`, '-pix_fmt', 'gray', '-f', 'rawvideo', grid]);
    const bytes = await fs.readFile(grid);
    const cells = W * H;
    const frames = [];
    for (let i = 0; i + cells <= bytes.length; i += cells) frames.push(bytes.subarray(i, i + cells));

    const distance = (a, b) => {
      let total = 0;
      for (let i = 0; i < cells; i++) total += Math.abs(a[i] - b[i]);
      return total / cells;
    };
    let noise = 0;
    for (let i = 0; i < 4; i++) noise += distance(frames[i], frames[i + 1]);
    noise /= 4;

    const probe = run('ffprobe', ['-select_streams', 'v:0', '-show_entries', 'stream=r_frame_rate', '-of', 'json', local]);
    const fps = Math.round(eval(JSON.parse(probe).streams[0].r_frame_rate)) || 24;

    // Anything before this is still inside the reaction itself.
    const earliest = Math.floor(frames.length * 0.45);
    let best = { index: frames.length - 1, score: Infinity };
    for (let i = earliest; i < frames.length; i++) {
      const score = distance(frames[0], frames[i]);
      if (score < best.score) best = { index: i, score };
    }

    const seconds = (best.index + 1) / fps;
    loopReport = {
      loop_point_s: Number(seconds.toFixed(3)),
      loop_distance: Number(best.score.toFixed(2)),
      noise_floor: Number(noise.toFixed(2)),
      ratio: Number((best.score / Math.max(0.01, noise)).toFixed(2)),
      seamless: best.score <= noise * 2.2,
    };
    console.log(`[generate-asset] loop point ${seconds.toFixed(2)}s — distance ${best.score.toFixed(2)} against a ${noise.toFixed(2)} noise floor (${loopReport.ratio}x)`);
    if (!loopReport.seamless) {
      console.log('[generate-asset] WARNING: the clip never returns close enough to its first frame to loop seamlessly');
    }

    upload = path.join(workDir, 'looped.mp4');
    run('ffmpeg', ['-y', '-i', local, '-an', '-t', seconds.toFixed(3), '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-pix_fmt', 'yuv420p', upload]);
  }

  if (!USE_END_FRAME && ANCHOR_MODE === 'morph') {
    const refFile = path.join(workDir, 'reference' + (path.extname(new URL(reference.video_url).pathname) || '.png'));
    const refResponse = await fetch(reference.video_url);
    if (!refResponse.ok) fail(`Could not download the reference still: HTTP ${refResponse.status}`);
    await fs.writeFile(refFile, Buffer.from(await refResponse.arrayBuffer()));

    const probe = run('ffprobe', [ '-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate', '-show_entries', 'format=duration', '-of', 'json', local]);
    const info = JSON.parse(probe);
    const stream = info.streams[0];
    const clipDuration = Number(info.format.duration);
    const fps = Math.round(eval(stream.r_frame_rate)) || 24;
    const fade = Math.min(ANCHOR_FADE_S, clipDuration / 4);

    const anchorClip = path.join(workDir, 'anchor.mp4');
    run('ffmpeg', ['-y', '-loop', '1', '-i', refFile,
      '-vf', `scale=${stream.width}:${stream.height}:force_original_aspect_ratio=increase,crop=${stream.width}:${stream.height},fps=${fps},setsar=1`,
      '-c:v', 'libx264', '-crf', '16', '-pix_fmt', 'yuv420p', '-t', (fade + 0.4).toFixed(3), anchorClip]);

    upload = path.join(workDir, 'anchored.mp4');
    run('ffmpeg', ['-y', '-i', local, '-i', anchorClip, '-an',
      '-filter_complex', `[0:v][1:v]xfade=transition=fade:duration=${fade.toFixed(3)}:offset=${(clipDuration - fade).toFixed(3)}[v]`,
      '-map', '[v]', '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-pix_fmt', 'yuv420p',
      '-t', clipDuration.toFixed(3), upload]);
    console.log(`[generate-asset] anchored the tail back to the reference over ${fade.toFixed(2)}s`);
  }
  const uploadBytes = await fs.readFile(upload);
  // The renderer cuts neutral chunks on this value, so it has to be what the
  // stored file actually is — a ping-pong is roughly twice the peak offset,
  // never the duration that was requested.
  const storedDuration = Number(JSON.parse(
    run('ffprobe', ['-show_entries', 'format=duration', '-of', 'json', upload]),
  ).format.duration);

  const assetId = crypto.randomUUID();
  const storagePath = `assets/${PERSONA}/${assetId}/${key}.mp4`;
  await supabase(`/storage/v1/object/${BUCKET}/${storagePath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'video/mp4', 'x-upsert': 'true' },
    body: uploadBytes,
  });
  const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${storagePath}`;

  // Registered disabled. Nothing enters the reaction vocabulary until a human
  // has watched it — the whole point of generating these one at a time.
  await supabase('/rest/v1/reaction_assets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({
      id: assetId,
      persona: PERSONA,
      reaction_type: preset.reactionType,
      label: `${preset.label}${process.env.FAL_LABEL_SUFFIX || ''}`,
      video_url: publicUrl,
      storage_path: storagePath,
      duration_s: Number(storedDuration.toFixed(3)),
      speech_ready: false,
      anchor_role: preset.reactionType === 'neutral' ? 'neutral' : 'none',
      enabled: false,
      metadata: {
        preset: key,
        generated_by: BACKEND === 'openrouter' ? OPENROUTER_MODEL : MODEL,
        anchored: USE_END_FRAME ? 'first_and_last_frame_are_the_reference_still' : `first_frame_only_${ANCHOR_MODE}`,
        loop: loopReport,
        prompt_mode: MINIMAL ? 'minimal' : 'detailed',
        generated_at: new Date().toISOString(),
        requested_duration_s: duration,
        backend: BACKEND,
        cost_estimate_usd: Number((duration * (BACKEND === 'openrouter' ? OPENROUTER_PRICE_PER_S : PRICE_PER_S)).toFixed(3)),
      },
    }),
  });

  await fs.rm(workDir, { recursive: true, force: true });
  console.log(`[generate-asset] stored ${(uploadBytes.length / 1048576).toFixed(1)} MB`);
  console.log(`[generate-asset] ${publicUrl}`);
  console.log('[generate-asset] registered DISABLED — enable it in Reaction Lab once it passes review');
}

main().catch(error => fail(error instanceof Error ? error.message : String(error)));
