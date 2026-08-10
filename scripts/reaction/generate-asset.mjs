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

const FAL_KEY = String(process.env.FAL_KEY || '').trim();
const SUPABASE_URL = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_KEY = String(process.env.MAM_SUPABASE_SERVICE_ROLE_KEY || '');
const PERSONA = String(process.env.REACTION_PERSONA || 'default').trim();
const MODEL = String(process.env.FAL_VIDEO_MODEL || 'fal-ai/kling-video/v3/pro/image-to-video').trim();
const PRICE_PER_S = Number(process.env.FAL_VIDEO_PRICE_PER_S || 0.112);
const BUCKET = 'reaction-media';

// Shared by every clip. Lifted out of the per-clip prompts so a change lands
// everywhere at once and the clips stay a matched set.
// Deliberately short. The first attempt spent nine sentences forbidding motion
// against one describing the performance, and the model obeyed the majority: the
// smirk was not readable at all.
//
// No @Image1/@Image2 references: that syntax belongs to the o1 endpoint and v3
// rejects the request outright with "Invalid reference index 1 for image".
const COMMON = [
  'The supplied first and last frames are the same photograph, so the clip begins and ends on that identical pose.',
  'Same person, hairstyle, black hoodie, white wired earbuds, framing, lighting and flat chroma-green background throughout, holding the head orientation, body orientation and off-screen gaze of the reference.',
  'Locked-off camera, clean static green background, no camera movement, no hand gestures.',
  'Photoreal skin with visible pores and stubble, no beauty filter, no plastic AI look.',
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
    performance: 'He watches something off-screen with a calm, attentive, neutral expression. Across the clip he breathes, blinks once, lets his eyes drift a few degrees and back, and settles his head and shoulders very slightly. Nothing more happens and there is no emotional reaction.',
  },
  smirk_a: {
    label: 'Smirk A',
    reactionType: 'smirk',
    duration: 3,
    performance: 'A three-beat performance. He watches neutrally, then something amuses him and one corner of his mouth pulls up into a clear, unmistakable one-sided smirk, held long enough to read, while his eyes narrow slightly and his cheek lifts with it. Then it fades and he returns to neutral. Amused and knowing, closed-mouth, no broad grin, no teeth.',
  },
  cringe_a: {
    label: 'Cringe A',
    reactionType: 'cringe',
    duration: 3,
    performance: 'A three-beat performance. He watches neutrally, then something awkward makes him visibly wince with second-hand embarrassment: the mouth pulls tight and to one side, the nose wrinkles, one eye squints, the brow tenses and the head draws back a little. The wince clearly reads, holds a moment, then relaxes back to neutral. Uncomfortable, not disgusted or scared.',
  },
  disbelief_a: {
    label: 'Disbelief A',
    reactionType: 'disbelief',
    duration: 3,
    performance: 'A three-beat performance. He watches neutrally, then reacts with clear disbelief, as if thinking "seriously?": the eyes narrow, one eyebrow lifts while the brow tenses, the lips press together, and he gives one slow, small but definite shake of the head. It reads plainly, then fades back to neutral.',
  },
  surprise_a: {
    label: 'Surprise A',
    reactionType: 'surprise',
    duration: 3,
    performance: 'A three-beat performance. He watches neutrally, then something unexpected lands: his eyes widen clearly, his eyebrows lift, his lips part slightly and his head pulls back a little. Genuine readable surprise rather than shock or exaggerated reaction acting, settling back to neutral.',
  },
  suspicious_a: {
    label: 'Suspicious A',
    reactionType: 'suspicious',
    duration: 3,
    performance: 'A three-beat performance. He watches neutrally, then grows visibly suspicious: both eyes narrow into a clear sceptical squint, one eyebrow lowers, one side of the mouth tightens and his head tilts and leans in very slightly as if looking closer. It holds a moment, then relaxes back to neutral.',
  },
  laugh_a: {
    label: 'Laugh A',
    reactionType: 'laugh',
    duration: 3,
    performance: 'A three-beat performance. He watches neutrally, then something genuinely funny makes him laugh quietly with his mouth closed: cheeks lift, eyes crease and narrow almost shut, shoulders and chest shake two or three times and the head dips. Clearly visible but silent and closed-mouthed, then he settles back to neutral.',
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
  console.log(`[generate-asset] ${preset.label} — ${preset.duration}s via ${MODEL} (~$${(preset.duration * PRICE_PER_S).toFixed(2)})`);

  const queued = await fal(`https://queue.fal.run/${MODEL}`, {
    method: 'POST',
    body: JSON.stringify({
      prompt,
      negative_prompt: NEGATIVE,
      start_image_url: reference.video_url,
      end_image_url: reference.video_url,
      duration: String(preset.duration),
      cfg_scale: 0.5,
    }),
  });
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

  const assetId = crypto.randomUUID();
  const storagePath = `assets/${PERSONA}/${assetId}/${key}.mp4`;
  await supabase(`/storage/v1/object/${BUCKET}/${storagePath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'video/mp4', 'x-upsert': 'true' },
    body: bytes,
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
      label: preset.label,
      video_url: publicUrl,
      storage_path: storagePath,
      duration_s: preset.duration,
      speech_ready: false,
      anchor_role: preset.reactionType === 'neutral' ? 'neutral' : 'none',
      enabled: false,
      metadata: {
        preset: key,
        generated_by: MODEL,
        anchored: 'first_and_last_frame_are_the_reference_still',
        generated_at: new Date().toISOString(),
        cost_estimate_usd: Number((preset.duration * PRICE_PER_S).toFixed(3)),
      },
    }),
  });

  await fs.rm(workDir, { recursive: true, force: true });
  console.log(`[generate-asset] stored ${(bytes.length / 1048576).toFixed(1)} MB`);
  console.log(`[generate-asset] ${publicUrl}`);
  console.log('[generate-asset] registered DISABLED — enable it in Reaction Lab once it passes review');
}

main().catch(error => fail(error instanceof Error ? error.message : String(error)));
