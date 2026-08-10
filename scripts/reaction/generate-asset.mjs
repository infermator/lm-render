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

const FAL_KEY = String(process.env.FAL_KEY || '').trim();
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
  neutral_b: {
    label: 'Neutral B',
    reactionType: 'neutral',
    duration: 4,
    performance: 'A quiet idle beat, three seconds of a man simply watching. He breathes. He blinks once, unhurried. His eyes drift a few degrees along whatever he is watching and come back. His head and shoulders settle by a couple of millimetres, the way a person shifts without noticing. His expression stays calm, attentive and completely neutral from the first frame to the last — no amusement, no surprise, no reaction of any kind. The stillness is the performance.',
  },
  smirk_a: {
    label: 'Smirk A',
    reactionType: 'smirk',
    duration: 3,
    performance: 'He watches, neutral. Then something in what he is watching quietly amuses him, and it surfaces on his face: one corner of his mouth draws up and back into a clear, lopsided smirk, the cheek on that side lifting with it, the eyes narrowing slightly and creasing at the outer corner the way a real smile reaches the eyes. He holds it, enjoying it privately. It is the look of someone thinking "of course that happened" — knowing, a little smug, entirely closed-mouthed. No wide grin, no teeth, no laugh. Then it eases off and his face relaxes.',
  },
  cringe_a: {
    label: 'Cringe A',
    reactionType: 'cringe',
    duration: 3,
    performance: 'He watches, neutral. Then something lands awkwardly and he winces with second-hand embarrassment: the mouth pulls tight and sideways, the nose wrinkles, one eye squints half shut, the brow tightens, the chin tucks slightly and his head draws back an inch as if to get away from it. His shoulders lift a fraction. It is the face of someone watching another person embarrass themselves — pained and sympathetic, not disgusted, not frightened, not comic. He holds the wince a moment, then lets it drain away.',
  },
  disbelief_a: {
    label: 'Disbelief A',
    reactionType: 'disbelief',
    duration: 3,
    performance: 'He watches, neutral. Then something he cannot accept happens, and disbelief settles over his face: the eyes narrow, one eyebrow climbs while the other stays down, the lips press together and push slightly to one side, the jaw sets. He gives a single slow shake of the head, small but unmistakable, the way someone says "no way" without speaking. He keeps watching throughout. Then his face loosens again.',
  },
  surprise_a: {
    label: 'Surprise A',
    reactionType: 'surprise',
    duration: 3,
    performance: 'He watches, neutral. Then something genuinely unexpected happens: his eyes widen, his eyebrows jump up, his lips part slightly and his head pulls back and up a little as the moment registers. The whole face opens for a beat. It is real, human surprise — the flinch of not seeing something coming — not shock, not fear, not exaggerated reaction acting. Then it settles and his expression closes again.',
  },
  suspicious_a: {
    label: 'Suspicious A',
    reactionType: 'suspicious',
    duration: 3,
    performance: 'He watches, neutral. Then doubt creeps in: both eyes narrow into a sceptical squint, one eyebrow lowers, one side of his mouth tightens, and his head tilts a few degrees and leans in slightly, as if trying to see what he is missing. He studies it. It is the look of someone who does not buy what he is being shown. He holds the scrutiny, then eases back.',
  },
  laugh_a: {
    label: 'Laugh A',
    reactionType: 'laugh',
    duration: 3,
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
  if (!FAL_KEY) fail('FAL_KEY missing');
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

  const prompt = `${preset.performance} ${COMMON}`;
  let duration = preset.duration;
  if (SPEC.durations && !SPEC.durations.includes(duration)) {
    duration = SPEC.durations.reduce((best, value) => (Math.abs(value - preset.duration) < Math.abs(best - preset.duration) ? value : best));
    console.log(`[generate-asset] ${MODEL} only offers ${SPEC.durations.join('/')}s; using ${duration}s`);
  }

  const payload = {
    prompt,
    negative_prompt: NEGATIVE,
    [SPEC.start]: reference.video_url,
    duration: SPEC.durationAsString === false ? duration : String(duration),
    ...(SPEC.extra || {}),
  };
  if (USE_END_FRAME) payload[SPEC.end] = reference.video_url;
  else console.log('[generate-asset] end frame OFF — the clip will not return to the anchor on its own');

  console.log(`[generate-asset] ${preset.label} — ${duration}s via ${MODEL} (~$${(duration * PRICE_PER_S).toFixed(2)})`);
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
  const videoUrl = String(result?.video?.url || '');
  if (!videoUrl) fail(`fal returned no video: ${JSON.stringify(result).slice(0, 400)}`);

  // fal's own URLs are temporary, so the clip is stored in our bucket before it
  // is registered — the library has to survive without them.
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'reaction-gen-'));
  const local = path.join(workDir, `${key}.mp4`);
  const download = await fetch(videoUrl);
  if (!download.ok) fail(`Could not download the generated clip: HTTP ${download.status}`);
  const bytes = Buffer.from(await download.arrayBuffer());
  await fs.writeFile(local, bytes);

  // Restore the anchor the request deliberately did not ask for.
  let upload = local;
  if (!USE_END_FRAME) {
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
      duration_s: duration,
      speech_ready: false,
      anchor_role: preset.reactionType === 'neutral' ? 'neutral' : 'none',
      enabled: false,
      metadata: {
        preset: key,
        generated_by: MODEL,
        anchored: USE_END_FRAME ? 'first_and_last_frame_are_the_reference_still' : 'first_frame_only',
        generated_at: new Date().toISOString(),
        cost_estimate_usd: Number((duration * PRICE_PER_S).toFixed(3)),
      },
    }),
  });

  await fs.rm(workDir, { recursive: true, force: true });
  console.log(`[generate-asset] stored ${(uploadBytes.length / 1048576).toFixed(1)} MB`);
  console.log(`[generate-asset] ${publicUrl}`);
  console.log('[generate-asset] registered DISABLED — enable it in Reaction Lab once it passes review');
}

main().catch(error => fail(error instanceof Error ? error.message : String(error)));
