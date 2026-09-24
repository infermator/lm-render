/** Optional Podcast V3 editorial treatment on ORIGINAL uncaptioned source.
 * Verbatim canonical words, one ASS dialogue per active-word time, no overlays
 * on top of other words and no extra transcription/voice synthesis. */
export const EDITORIAL_CAPTION_CONTRACT = Object.freeze({
  font_px: 76, max_words: 4, max_chars: 21, max_group_duration_s: 1.55,
  canvas: [1080, 1920], margin_v: 250,
});
const clean = v => String(v || '').trim().replace(/[\u0000-\u001f\u007f]/g, ' ');
const norm = v => clean(v).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const token = v => clean(v).replace(/[^\p{L}\p{N}]+/gu, '');
const punct = v => /^[.,;!?%:]+$/.test(clean(v));
const escapeAss = v => clean(v).replace(/\\/g, '\\\\').replace(/{/g, '\\{').replace(/}/g, '\\}');
const stamp = value => {
  const cs = Math.max(0, Math.round(Number(value) * 100));
  return Math.floor(cs / 360000) + ':' + String(Math.floor(cs / 6000) % 60).padStart(2, '0')
    + ':' + String(Math.floor(cs / 100) % 60).padStart(2, '0') + '.' + String(cs % 100).padStart(2, '0');
};
const phrase = words => words.map((word, i) =>
  (i === 0 || punct(word.text) ? '' : ' ') + clean(word.text)).join('');
export function editorialCaptionGroups(rawWords) {
  const words = (Array.isArray(rawWords) ? rawWords : [])
    .filter(w => Number.isFinite(Number(w?.start)) && Number.isFinite(Number(w?.end))
      && Number(w.end) > Number(w.start) && clean(w.text))
    .sort((a, b) => Number(a.start) - Number(b.start));
  const groups = [];
  let group = [];
  const flush = () => { if (group.length) groups.push(group); group = []; };
  for (const word of words) {
    if (group.length && (String(word.speaker || '') !== String(group.at(-1).speaker || '')
      || Number(word.start) - Number(group.at(-1).end) > 0.65)) flush();
    group.push(word);
    if (group.length >= EDITORIAL_CAPTION_CONTRACT.max_words
      || phrase(group).length >= EDITORIAL_CAPTION_CONTRACT.max_chars
      || Number(word.end) - Number(group[0].start) >= EDITORIAL_CAPTION_CONTRACT.max_group_duration_s
      || /[.!?]$/.test(clean(word.text))) flush();
  }
  flush();
  return groups;
}
function spokenNear(words, at, window = 2) {
  return norm(words.filter(w => Number(w.start) >= at - window
    && Number(w.start) <= at + window).map(w => clean(w.text)).join(' '));
}
export function normalizeEditorialCards(rawCards, words, duration) {
  if (!Array.isArray(rawCards) || !Number.isFinite(duration)) return [];
  return rawCards.filter(c => c && typeof c === 'object')
    .map(c => ({ at_s: Number(c.at_s), text: clean(c.text).slice(0, 44) }))
    .filter(c => Number.isFinite(c.at_s) && c.at_s >= 0 && c.at_s < duration - 0.7
      && c.text.length >= 3 && c.text.length <= 42
      && norm(c.text).length >= 3 && spokenNear(words, c.at_s).includes(norm(c.text)))
    .sort((a, b) => a.at_s - b.at_s)
    .filter((c, i, all) => i === 0 || c.at_s - all[i - 1].at_s >= 3)
    .slice(0, 5)
    .map(c => ({ ...c, text: c.text.toLocaleUpperCase('en'),
      end_s: Math.min(duration, c.at_s + (c.text.length > 25 ? 2.8 : 2.3)) }));
}
function styledPhrase(group, selected, emphasized) {
  let result = '';
  for (let index = 0; index < group.length; index++) {
    const w = group[index], t = clean(w.text);
    const bright = index === selected;
    const foreground = bright && emphasized.has(norm(t)) ? '0068F2FF'
      : bright ? '0046FFAE' : '00FFFFFF';
    result += (index === 0 || punct(t) ? '' : ' ') + '{\\c&H' + foreground + '&}' + escapeAss(t);
  }
  return result;
}
export function buildEditorialCaptionsAss(rawWords, { duration, emphasisWords = [], cards = [] } = {}) {
  const end = Number(duration);
  if (!Number.isFinite(end) || end < 8 || end > 300) throw new Error('Invalid V3 editorial duration');
  const groups = editorialCaptionGroups(rawWords);
  if (!groups.length) throw new Error('No verified canonical words for editorial captions');
  const emphasized = new Set((Array.isArray(emphasisWords) ? emphasisWords : []).map(norm));
  const header = [
    '[Script Info]', 'ScriptType: v4.00+', 'PlayResX: 1080', 'PlayResY: 1920',
    'ScaledBorderAndShadow: yes', 'WrapStyle: 0', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: Editorial,Inter,76,&H00FFFFFF,&H00FFFFFF,&H00101820,&H80000000,-1,0,0,0,100,100,0,0,1,3,0,2,64,64,250,1',
    'Style: Callout,Inter,74,&H0046FFAE,&H0046FFAE,&H00101820,&H50080808,-1,0,0,0,100,100,0,0,3,6,0,8,62,62,132,1',
    '', '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  const events = [header.join('\n')];
  // Unlike independent per-phrase +/-80ms expansion, no two caption groups
  // can overlap: otherwise the two 76px lines stack and cover a speaker.
  for (let g = 0; g < groups.length; g++) {
    const group = groups[g];
    const start = Math.max(0, Number(group[0].start) - (g === 0 ? 0.04 : 0));
    const nextStart = g + 1 < groups.length ? Number(groups[g + 1][0].start) : end;
    const stop = Math.min(end, nextStart, Number(group.at(-1).end) + 0.08);
    if (stop - start < 0.025) continue;
    for (let i = 0; i < group.length; i++) {
      const at = i === 0 ? start : Math.max(start, Number(group[i].start));
      const till = i + 1 === group.length ? stop
        : Math.min(stop, Number(group[i + 1].start));
      if (till - at < 0.025) continue;
      events.push('Dialogue: 0,' + stamp(at) + ',' + stamp(till)
        + ',Editorial,,0,0,0,,' + styledPhrase(group, i, emphasized));
    }
  }
  for (const card of normalizeEditorialCards(cards, rawWords, end)) {
    events.push('Dialogue: 1,' + stamp(card.at_s) + ',' + stamp(card.end_s)
      + ',Callout,,0,0,0,,{\\fad(120,170)}' + escapeAss(card.text));
  }
  return events.join('\n') + '\n';
}
