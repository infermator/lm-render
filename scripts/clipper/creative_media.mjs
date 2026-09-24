/** CLIPPER V2/V3 optional creative render layer. Never imported by Reaction V1. */
export const CREATIVE_SCHEMA = 'clipper-creative-v1';

const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const norm = value => String(value || '').normalize('NFKC').toLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const clean = (value, max) => String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ')
  .replace(/\s+/g, ' ').trim().slice(0, max);
const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const round = value => Number(value.toFixed(3));
const wordsText = words => words.map(word => String(word.text || '')).join(' ');

/** Validate the LLM data AGAIN at the renderer boundary. Never emit shell/ffmpeg commands from AI. */
export function normalizeCreativeMedia(raw, words, duration) {
  const disabled = { enabled: false, style: 'minimal', hookText: '', emphasisWords: [],
    zoomCues: [], musicCurve: [] };
  if (!raw || typeof raw !== 'object' || raw.schema_version !== CREATIVE_SCHEMA
    || raw.enabled !== true || !Number.isFinite(duration) || duration < 8) return disabled;
  const speech = norm(wordsText(words));
  const literal = value => {
    const text = clean(value, 60);
    const key = norm(text);
    return key.length >= 3 && speech.includes(key) ? text : '';
  };
  const style = ['minimal', 'balanced', 'dynamic'].includes(raw.editing_style)
    ? raw.editing_style : 'minimal';
  const hookText = literal(raw.hook_text);
  const emphasisWords = Array.isArray(raw.emphasis_words)
    ? [...new Set(raw.emphasis_words.map(value => literal(value)).filter(Boolean))].slice(0, 7) : [];
  const rawCues = Array.isArray(raw.zoom_cues) ? raw.zoom_cues : [];
  const zoomCues = style === 'minimal' ? [] : rawCues.map(cue => {
    if (!cue || typeof cue !== 'object') return null;
    const at = number(cue.at_s), span = number(cue.duration_s), scale = number(cue.scale);
    const anchor = literal(cue.anchor);
    if (at === null || span === null || scale === null || !anchor) return null;
    if (at < 1 || at + span >= duration - 0.4 || span < 0.35 || span > 1.5
      || scale < 1.04 || scale > 1.16) return null;
    // Ground timing in *actual* selected clip words, not the model's guess.
    const anchorWords = norm(anchor).split(' ').filter(Boolean);
    let anchored = false;
    for (let i = 0; i <= words.length - anchorWords.length; i++) {
      const phrase = norm(words.slice(i, i + anchorWords.length).map(word => word.text).join(' '));
      if (phrase === anchorWords.join(' ') && Math.abs(Number(words[i].start) - at) <= 2) {
        anchored = true; break;
      }
    }
    return anchored ? { at_s: round(at), duration_s: round(span), scale: round(scale), anchor } : null;
  }).filter(Boolean).sort((a, b) => a.at_s - b.at_s)
    .filter((cue, index, all) => index === 0 || cue.at_s >= all[index - 1].at_s + all[index - 1].duration_s + 1)
    .slice(0, 3);
  const curve = Array.isArray(raw.music_curve) ? raw.music_curve : [];
  const musicCurve = curve.map(point => {
    if (!point || typeof point !== 'object') return null;
    const at = number(point.at_s), intensity = number(point.intensity);
    if (at === null || intensity === null || at < 0 || at > duration
      || intensity < 0.35 || intensity > 1) return null;
    return { at_s: round(at), intensity: round(intensity) };
  }).filter(Boolean).sort((a, b) => a.at_s - b.at_s)
    .filter((point, index, all) => index === 0 || point.at_s - all[index - 1].at_s >= 0.25)
    .slice(0, 5);
  return { enabled: true, style, hookText, emphasisWords, zoomCues, musicCurve };
}

function assTimestamp(seconds) {
  const cs = Math.max(0, Math.round(seconds * 100));
  const h = Math.floor(cs / 360000), m = Math.floor(cs % 360000 / 6000);
  const s = Math.floor(cs % 6000 / 100);
  return h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0')
    + '.' + String(cs % 100).padStart(2, '0');
}

/** Only short literal transcript phrases, escaped for ASS. No font asset downloads. */
export function buildHookAss(hookText, duration) {
  const text = clean(hookText, 55);
  if (!text || !Number.isFinite(duration) || duration <= 0) return '';
  const safe = text.replace(/\\/g, '\\\\').replace(/{/g, '\\{').replace(/}/g, '\\}');
  return [
    '[Script Info]', 'ScriptType: v4.00+', 'PlayResX: 324', 'PlayResY: 576',
    'ScaledBorderAndShadow: yes', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: Hook,Inter,17,&H00FFFFFF,&H00FFFFFF,&H00000000,&H78000000,-1,0,0,0,100,100,0,0,1,2,0,8,19,19,88,1',
    '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    'Dialogue: 0,0:00:00.00,' + assTimestamp(Math.min(2.2, duration)) + ',Hook,,0,0,0,,' + safe, '',
  ].join('\n');
}

/** Static 1080x1920 crop comes from speaker-aware track; only zoom its output.
 * d=1 preserves frames and timestamps; the caption layer is applied AFTER it. */
export function zoomFilter(cues, inputLabel, outputLabel, fps = 30) {
  if (!Array.isArray(cues) || !cues.length) return null;
  const cases = cues.map(cue => 'between(on/' + fps + '\\,' + cue.at_s + '\\,'
    + round(cue.at_s + cue.duration_s) + ')\\,' + cue.scale + '\\,');
  let expression = '1';
  for (let i = cases.length - 1; i >= 0; i--) expression = 'if(' + cases[i] + expression + ')';
  return '[' + inputLabel + ']fps=' + fps + ",zoompan=z='" + expression
    + "':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=1080x1920:fps="
    + fps + '[' + outputLabel + ']';
}

/** A frame-evaluated volume multiplier before speech sidechain compression. */
export function musicCurveFilter(curve, inputLabel = 'music_pre', outputLabel = 'music_dynamic') {
  if (!Array.isArray(curve) || curve.length < 2) return '[' + inputLabel + ']anull[' + outputLabel + ']';
  let expr = String(curve.at(-1).intensity);
  for (let i = curve.length - 2; i >= 0; i--) {
    const a = curve[i], b = curve[i + 1];
    const span = Math.max(0.25, b.at_s - a.at_s);
    const ramp = a.intensity + '+(' + round(b.intensity - a.intensity)
      + ')*(t-' + a.at_s + ')/' + round(span);
    expr = 'if(lt(t\\,' + b.at_s + ')\\,max(0.35\\,min(1\\,' + ramp + '))\\,' + expr + ')';
  }
  return '[' + inputLabel + "]volume='" + expr + "':eval=frame[" + outputLabel + ']';
}
