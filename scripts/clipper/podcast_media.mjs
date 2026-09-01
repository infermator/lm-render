// ASS uses the explicit 324x576 script canvas below. MarginV=96 therefore
// preserves the visual lane of the older SRT profile (MarginV=48 on libass's
// implicit 288-line canvas) instead of dropping captions against the UI-safe
// bottom edge.
export const PODCAST_CAPTION_MARGIN_V = 96;
export const PODCAST_CAPTION_FORCE_STYLE = `FontName=Inter,FontSize=15,Bold=1,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,Outline=1,Shadow=0,Alignment=2,MarginV=${PODCAST_CAPTION_MARGIN_V}`;

const CAPTION_ACCENTS = [
  { name: 'lime', rgb: [174, 255, 70] },
  { name: 'yellow', rgb: [255, 215, 62] },
  { name: 'coral', rgb: [255, 75, 92] },
  { name: 'cyan', rgb: [51, 224, 255] },
  { name: 'magenta', rgb: [255, 91, 210] },
];

function srgbChannel(value) {
  const normalized = Math.max(0, Math.min(255, Number(value) || 0)) / 255;
  return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

function luminance(rgb) {
  return 0.2126 * srgbChannel(rgb[0]) + 0.7152 * srgbChannel(rgb[1]) + 0.0722 * srgbChannel(rgb[2]);
}

function contrastRatio(left, right) {
  const brighter = Math.max(luminance(left), luminance(right));
  const darker = Math.min(luminance(left), luminance(right));
  return (brighter + 0.05) / (darker + 0.05);
}

function assBgr(rgb) {
  return [rgb[2], rgb[1], rgb[0]].map(value => Math.round(value).toString(16).padStart(2, '0')).join('').toUpperCase();
}

export function chooseCaptionAccent(rawSamples) {
  const samples = (Array.isArray(rawSamples) ? rawSamples : []).map(sample => (
    Array.isArray(sample) ? sample : [sample?.r, sample?.g, sample?.b]
  )).filter(sample => sample.length >= 3 && sample.every(value => Number.isFinite(Number(value))))
    .map(sample => sample.slice(0, 3).map(Number));
  const backgrounds = samples.length ? samples : [[48, 48, 48]];
  const ranked = CAPTION_ACCENTS.map(accent => {
    // The readable caption gradient darkens the lane substantially. Score
    // against that actual visual contract, while also preferring a hue unlike
    // the underlying source so the active word does not disappear into it.
    const darkened = backgrounds.map(background => background.map(channel => channel * 0.45));
    const minimumContrast = Math.min(...darkened.map(background => contrastRatio(accent.rgb, background)));
    const colorDistance = Math.min(...backgrounds.map(background => Math.sqrt(
      accent.rgb.reduce((sum, channel, index) => sum + (channel - background[index]) ** 2, 0),
    ))) / 441.67;
    return { ...accent, score: minimumContrast * 1.5 + colorDistance * 2 };
  }).sort((left, right) => right.score - left.score || left.name.localeCompare(right.name));
  const selected = ranked[0];
  const blackContrast = contrastRatio(selected.rgb, [0, 0, 0]);
  const whiteContrast = contrastRatio(selected.rgb, [255, 255, 255]);
  return {
    name: selected.name,
    rgb: selected.rgb,
    ass_bgr: assBgr(selected.rgb),
    text_ass_bgr: blackContrast >= whiteContrast ? '000000' : 'FFFFFF',
    contrast_score: Number(selected.score.toFixed(3)),
  };
}

export function validateSoundtrackPlan(raw) {
  if (!raw || typeof raw !== 'object' || raw.enabled !== true) return null;
  const id = String(raw.track_id || '').toLowerCase();
  const bucket = String(raw.storage_bucket || '');
  const objectPath = String(raw.storage_path || '');
  const bytes = Math.floor(Number(raw.bytes || 0));
  const contentType = String(raw.content_type || '').toLowerCase();
  const gainDb = Number(raw.mix_gain_db ?? -8);
  if (raw.schema_version !== 'clipper-soundtrack-v1') throw new Error('Soundtrack plan schema is invalid');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) {
    throw new Error('Soundtrack track ID is invalid');
  }
  if (bucket !== 'clipper-media' || !objectPath.startsWith(`music/${id}/`) || objectPath.includes('..') || objectPath.includes('\\')) {
    throw new Error('Soundtrack storage identity is invalid');
  }
  if (!Number.isFinite(bytes) || bytes < 1 || bytes > 100 * 1024 * 1024) throw new Error('Soundtrack size is invalid');
  if (!contentType.startsWith('audio/')) throw new Error('Soundtrack content type is invalid');
  if (!Number.isFinite(gainDb) || gainDb < -30 || gainDb > -6) throw new Error('Soundtrack mix gain is invalid');
  return {
    id,
    bucket,
    path: objectPath,
    bytes,
    content_type: contentType,
    gain_db: gainDb,
    title: String(raw.title || '').slice(0, 160),
    artist: String(raw.artist || '').slice(0, 160),
    license_type: String(raw.license_type || ''),
    attribution: String(raw.attribution || '').trim() || null,
    selection: String(raw.selection || 'unknown'),
    match_score: Number.isFinite(Number(raw.match_score)) ? Number(raw.match_score) : null,
  };
}

export function soundtrackStartOffset(trackDurationValue, clipDurationValue, seedValue) {
  const trackDuration = Math.max(0, Number(trackDurationValue) || 0);
  const clipDuration = Math.max(0, Number(clipDurationValue) || 0);
  const maxOffset = Math.max(0, trackDuration - Math.min(trackDuration, clipDuration));
  if (maxOffset <= 0.05) return 0;
  let hash = 2166136261;
  for (const char of String(seedValue || '')) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return Number((((hash >>> 0) / 0xffffffff) * maxOffset).toFixed(3));
}

// Final programme trim, applied after the mix and before the limiter.
//
// The reference render measured -15.2 LUFS integrated, which was asked to come
// down slightly. This is a fixed offset rather than a loudnorm pass on purpose:
// it lowers the programme without touching dynamics or re-levelling speech that
// the source already balanced.
//
// Worth knowing before lowering it further: YouTube only turns loud uploads
// down, never quiet ones up, so anything under about -14 LUFS simply plays
// quieter than the videos around it.
const PROGRAMME_TRIM_DB = -1.5;

export function podcastSoundtrackAudioFilter({ duration: durationValue, gainDb: gainValue, sourceHasAudio = true }) {
  const duration = Number(durationValue);
  const gainDb = Number(gainValue);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('Soundtrack mix duration is invalid');
  if (!Number.isFinite(gainDb) || gainDb < -30 || gainDb > -6) throw new Error('Soundtrack mix gain is invalid');
  const fadeOutDuration = Math.min(1.2, Math.max(0.25, duration / 8));
  const fadeOutStart = Math.max(0, duration - fadeOutDuration);
  const music = `[1:a]aformat=sample_rates=48000:channel_layouts=stereo,loudnorm=I=-18:LRA=7:TP=-2,volume=${gainDb.toFixed(2)}dB,atrim=0:${duration.toFixed(3)},asetpts=PTS-STARTPTS,afade=t=in:st=0:d=0.45,afade=t=out:st=${fadeOutStart.toFixed(3)}:d=${fadeOutDuration.toFixed(3)}[music_pre]`;
  if (!sourceHasAudio) return `${music};[music_pre]volume=${PROGRAMME_TRIM_DB.toFixed(2)}dB,alimiter=limit=0.95:attack=5:release=50[a]`;
  return [
    music,
    `[0:a]aformat=sample_rates=48000:channel_layouts=stereo,apad=whole_dur=${duration.toFixed(3)},atrim=0:${duration.toFixed(3)},asplit=2[source_mix][speech_key]`,
    // Keep the bed audible beneath a podcast voice. The previous 0.03/10:1
    // contract pushed a normalized -14 dB bed to roughly -42 LUFS on the
    // reference clip, which was functionally dry. This gentler detector keeps
    // speech about 16 dB forward while preserving the track's rhythm.
    '[music_pre][speech_key]sidechaincompress=threshold=0.06:ratio=4:attack=20:release=450:makeup=1[ducked_music]',
    `[source_mix][ducked_music]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,volume=${PROGRAMME_TRIM_DB.toFixed(2)}dB,alimiter=limit=0.95:attack=5:release=50[a]`,
  ].join(';');
}

export function validatePodcastWindow(startValue, endValue) {
  const start = Number(startValue);
  const end = Number(endValue);
  const duration = end - start;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    throw new Error('Invalid podcast candidate timestamp range');
  }
  if (duration < 15 || duration > 180.01) {
    throw new Error(`Podcast duration contract violated (${duration.toFixed(1)}s; expected 15–180s)`);
  }
  return { start, end, duration };
}

export function validateAlignmentArtifactMetadata(vodIdValue, raw) {
  const vodId = String(vodIdValue || '');
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Podcast alignment artifact metadata is missing');
  }
  const bucket = String(raw.bucket || '');
  const sha256 = String(raw.sha256 || '').toLowerCase();
  const objectPath = String(raw.path || '');
  const bytes = Math.floor(Number(raw.bytes || 0));
  if (bucket !== 'clipper-media') throw new Error('Podcast alignment artifact bucket is invalid');
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('Podcast alignment artifact SHA-256 is invalid');
  if (objectPath !== `podcasts/${vodId}/alignment/${sha256}.flac`) {
    throw new Error('Podcast alignment artifact path is not content-addressed for this VOD');
  }
  if (!Number.isFinite(bytes) || bytes < 1 || bytes > 512 * 1024 * 1024) {
    throw new Error('Podcast alignment artifact size is invalid');
  }
  if (String(raw.codec || '').toLowerCase() !== 'flac' || Number(raw.sample_rate) !== 8000 || Number(raw.channels) !== 1) {
    throw new Error('Podcast alignment artifact format is invalid');
  }
  return { bucket, path: objectPath, sha256, bytes, codec: 'flac', sample_rate: 8000, channels: 1 };
}

function artifactSegments(artifact) {
  return Array.isArray(artifact?.transcript?.segments) ? artifact.transcript.segments : [];
}

function absoluteTranscriptWords(artifact) {
  const words = [];
  for (const segment of artifactSegments(artifact)) {
    for (const word of Array.isArray(segment?.words) ? segment.words : []) {
      const start = Number(word?.start_s);
      const end = Number(word?.end_s);
      const text = String(word?.text || '').trim();
      if (!text || !Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
      words.push({ start, end, text });
    }
  }
  return words.sort((left, right) => left.start - right.start || left.end - right.end);
}

function sentenceTerminal(text) {
  return /[.!?][\]})"'’”]*$/.test(String(text || '').trim());
}

export function refinePodcastSpeechWindow(artifact, startValue, endValue, options = {}) {
  const original = validatePodcastWindow(startValue, endValue);
  const tailSeconds = Math.max(0.35, Math.min(1, Number(options.tailSeconds ?? 0.55)));
  const pauseSeconds = Math.max(tailSeconds, Math.min(1.5, Number(options.pauseSeconds ?? 0.65)));
  const extensionLimit = Math.max(0, Math.min(12, Number(options.maxExtensionSeconds ?? 12)));
  const vodDuration = Number(options.vodDurationS);
  const maximumEnd = Math.min(
    Number.isFinite(vodDuration) && vodDuration > 0 ? vodDuration : Number.POSITIVE_INFINITY,
    original.start + 180,
    original.end + extensionLimit,
  );
  const words = absoluteTranscriptWords(artifact);
  let lastIndex = -1;
  for (let index = 0; index < words.length && words[index].start < original.end; index += 1) lastIndex = index;
  if (lastIndex < 0) {
    return {
      ...original,
      original_end_s: original.end,
      extension_s: 0,
      changed: false,
      verified: false,
      usable: false,
      reason: 'no_transcript_words',
    };
  }

  const lastAtPlan = words[lastIndex];
  const nextAtPlan = words[lastIndex + 1] || null;
  const existingTail = original.end - lastAtPlan.end;
  const existingPause = !nextAtPlan || nextAtPlan.start - lastAtPlan.end >= pauseSeconds;
  if (existingTail >= tailSeconds && existingPause) {
    return {
      ...original,
      original_end_s: original.end,
      extension_s: 0,
      changed: false,
      verified: true,
      usable: true,
      reason: 'existing_natural_tail',
    };
  }

  let chosen = lastAtPlan;
  let terminalFound = sentenceTerminal(lastAtPlan.text)
    && lastAtPlan.end >= original.end - 0.2
    && existingPause;
  let pauseFound = false;
  // The widest breath in the window, kept as a last resort. Continuous speech
  // with no punctuation and no full pause used to abort the whole render; this
  // is what lets it end on the best break available instead.
  let widestGapWord = null;
  let widestGap = 0;
  for (let index = lastIndex; index < words.length && !terminalFound && !pauseFound; index += 1) {
    const word = words[index];
    if (word.start >= maximumEnd) break;
    if (index > lastIndex) {
      const prior = words[index - 1];
      if (word.start - prior.end >= pauseSeconds && prior.end >= original.end - 0.2) {
        chosen = prior;
        pauseFound = true;
        break;
      }
    }
    chosen = word;
    const next = words[index + 1] || null;
    const gapAfter = next ? next.start - word.end : Number.POSITIVE_INFINITY;
    if (word.end >= original.end - 0.2 && gapAfter > widestGap) {
      widestGap = gapAfter;
      widestGapWord = word;
    }
    const hasPauseAfter = !next || gapAfter >= pauseSeconds;
    if (word.end >= original.end - 0.2 && sentenceTerminal(word.text) && hasPauseAfter) {
      terminalFound = true;
      break;
    }
    if (word.end >= original.end - 0.2 && hasPauseAfter) {
      pauseFound = true;
    }
  }

  const verified = terminalFound || pauseFound;
  // No sentence end and no full pause: cut on the widest gap between words
  // rather than abandoning the clip. The ending is worse than a real boundary,
  // but it still lands between words instead of through one, and the caller is
  // told which of the three it got.
  const fellBack = !verified && Boolean(widestGapWord);
  const endWord = verified ? chosen : (widestGapWord || chosen);
  const refinedEnd = verified || fellBack
    ? Math.max(original.end, Math.min(maximumEnd, endWord.end + tailSeconds))
    : original.end;
  return {
    start: original.start,
    end: Number(refinedEnd.toFixed(3)),
    duration: Number((refinedEnd - original.start).toFixed(3)),
    original_end_s: original.end,
    extension_s: Number((refinedEnd - original.end).toFixed(3)),
    changed: refinedEnd > original.end + 0.05,
    verified,
    // Whether the render may proceed at all. Only a window with no transcript
    // words behind it has nothing safe to cut on.
    usable: verified || fellBack,
    widest_gap_s: fellBack ? Number(widestGap.toFixed(3)) : null,
    reason: terminalFound ? 'sentence_terminal'
      : pauseFound ? 'speech_pause'
      : fellBack ? 'widest_word_gap'
      : 'no_safe_boundary',
  };
}

export function wordsForWindow(artifact, start, end) {
  const words = [];
  for (const segment of artifactSegments(artifact)) {
    for (const word of Array.isArray(segment?.words) ? segment.words : []) {
      const wordStart = Number(word?.start_s);
      const wordEnd = Number(word?.end_s);
      const text = String(word?.text || '').trim();
      if (!text || !Number.isFinite(wordStart) || !Number.isFinite(wordEnd)) continue;
      if (wordEnd <= start || wordStart >= end) continue;
      words.push({
        start: Math.max(0, wordStart - start),
        end: Math.min(end - start, Math.max(wordStart, wordEnd) - start),
        text,
        speaker: String(word?.speaker || segment?.speaker || '').trim() || null,
      });
    }
  }
  return words.sort((left, right) => left.start - right.start);
}

export function srtTimestamp(seconds) {
  const ms = Math.max(0, Math.round(Number(seconds || 0) * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const milli = ms % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(milli).padStart(3, '0')}`;
}

function captionGroups(words) {
  const groups = [];
  let group = [];
  for (const word of words) {
    if (group.length && word.speaker && group[0].speaker && word.speaker !== group[0].speaker) {
      groups.push(group);
      group = [];
    }
    group.push(word);
    const duration = Number(group.at(-1).end) - Number(group[0].start);
    if (group.length >= 6 || duration >= 2.6 || /[.!?]$/.test(String(word.text))) {
      groups.push(group);
      group = [];
    }
  }
  if (group.length) groups.push(group);
  return groups;
}

export function buildTranscriptSrt(words) {
  return captionGroups(words).map((items, index) => {
    const text = items.map(item => String(item.text || '').trim()).filter(Boolean).join(' ').replace(/\s+([,.;!?])/g, '$1');
    return `${index + 1}\n${srtTimestamp(items[0].start)} --> ${srtTimestamp(items.at(-1).end)}\n${text}\n`;
  }).join('\n');
}

function assTimestamp(seconds) {
  const centiseconds = Math.max(0, Math.round(Number(seconds || 0) * 100));
  const h = Math.floor(centiseconds / 360000);
  const m = Math.floor((centiseconds % 360000) / 6000);
  const s = Math.floor((centiseconds % 6000) / 100);
  const cs = centiseconds % 100;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function escapeAssText(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/{/g, '\\{').replace(/}/g, '\\}').replace(/\r?\n/g, '\\N');
}

function captionLine(items, activeIndex, accent) {
  return items.map((item, index) => {
    const text = escapeAssText(String(item.text || '').trim());
    if (index !== activeIndex) return text;
    // BorderStyle=3 is a real opaque rectangular word chip. Resetting to this
    // style for only the active token avoids the glyph-shaped coloured halo
    // produced by xbord/ybord while keeping the rest of the phrase stable.
    return `{\\rActiveWord}${text}{\\rPodcastCaption}`;
  }).filter(Boolean).join(' ').replace(/\s+([,.;!?])/g, '$1');
}

export function buildTranscriptAss(words, accentValue = chooseCaptionAccent([])) {
  const accent = accentValue && typeof accentValue === 'object' ? accentValue : chooseCaptionAccent([]);
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: 324
PlayResY: 576
ScaledBorderAndShadow: yes
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: PodcastCaption,Inter,15,&H00FFFFFF,&H00FFFFFF,&H00000000,&H70000000,-1,0,0,0,100,100,0,0,1,0.8,0,2,18,18,${PODCAST_CAPTION_MARGIN_V},1
Style: ActiveWord,Inter,15,&H00${accent.text_ass_bgr},&H00${accent.text_ass_bgr},&H00${accent.ass_bgr},&H00${accent.ass_bgr},-1,0,0,0,100,100,0,0,3,1.8,0,2,18,18,${PODCAST_CAPTION_MARGIN_V},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`;
  const events = [];
  for (const items of captionGroups(words)) {
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      const next = items[index + 1];
      const start = Math.max(0, Number(item.start));
      const naturalEnd = Math.max(start + 0.06, Number(item.end));
      const end = next ? Math.max(start + 0.06, Number(next.start)) : naturalEnd;
      events.push(`Dialogue: 0,${assTimestamp(start)},${assTimestamp(end)},PodcastCaption,,0,0,0,,${captionLine(items, index, accent)}`);
    }
  }
  return `${header}\n${events.join('\n')}\n`;
}

function sourceSpeakerIntervals(artifact) {
  const turns = Array.isArray(artifact?.diarization?.turns) ? artifact.diarization.turns : [];
  if (turns.length) return turns;
  return artifactSegments(artifact).map(segment => ({
    start_s: segment?.start_s,
    end_s: segment?.end_s,
    speaker: segment?.speaker,
  }));
}

export function speakerAt(artifact, absoluteTime) {
  const interval = sourceSpeakerIntervals(artifact).find(item => (
    Number(item?.start_s) <= absoluteTime && Number(item?.end_s) > absoluteTime
  ));
  return String(interval?.speaker || '').trim() || null;
}

export function speakerIntervalsForWindow(artifact, start, end) {
  const intervals = sourceSpeakerIntervals(artifact).map(item => {
    const itemStart = Number(item?.start_s);
    const itemEnd = Number(item?.end_s);
    const speaker = String(item?.speaker || '').trim();
    if (!speaker || !Number.isFinite(itemStart) || !Number.isFinite(itemEnd) || itemEnd <= start || itemStart >= end) return null;
    return {
      start: Math.max(start, itemStart) - start,
      end: Math.min(end, itemEnd) - start,
      speaker,
    };
  }).filter(Boolean).sort((left, right) => left.start - right.start);

  const merged = [];
  for (const interval of intervals) {
    const prior = merged.at(-1);
    if (prior && prior.speaker === interval.speaker && interval.start - prior.end <= 0.4) {
      prior.end = Math.max(prior.end, interval.end);
    } else {
      merged.push({ ...interval });
    }
  }
  return merged.slice(0, 160);
}

export function normalizedSpeakerCenters(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return Object.fromEntries(Object.entries(raw).map(([speaker, value]) => {
    const center = Number(value);
    return [String(speaker).slice(0, 80), Number.isFinite(center) ? Math.max(0, Math.min(1, center)) : null];
  }).filter(([, center]) => center != null));
}

export function resolvePodcastFraming({ localCenters, speakerPositions, intervals }) {
  const rawCenters = normalizedSpeakerCenters(localCenters);
  const centers = { ...rawCenters };
  for (const [speaker, position] of Object.entries(speakerPositions || {})) {
    if (position === 'left') centers[speaker] = 0.25;
    if (position === 'center') centers[speaker] = 0.5;
    if (position === 'right') centers[speaker] = 0.75;
  }

  // Everyone diarization heard, before dropping the ones we could not place.
  // Keeping the two counts apart is the whole point: a speaker with no measured
  // centre used to vanish here, so "two people talk but we located one" became
  // indistinguishable from "one person talks".
  const heardSpeakers = [...new Set((intervals || [])
    .map(interval => String(interval?.speaker || ''))
    .filter(Boolean))];
  const activeSpeakers = heardSpeakers.filter(speaker => Number.isFinite(Number(centers[speaker])));
  if (!activeSpeakers.length) {
    return { mode: 'fit_blur', reason: 'no_positioned_speaker', centers, raw_centers: rawCenters };
  }

  const activeCenters = activeSpeakers.map(speaker => Number(centers[speaker]));
  const spread = Math.max(...activeCenters) - Math.min(...activeCenters);
  if (activeSpeakers.length === 1) {
    if (heardSpeakers.length > 1) {
      // Someone else speaks in this window and we do not know where they are.
      // Cropping is the worst option here, not the safe one: it commits the
      // frame to the one person we happened to locate, so every line the other
      // speaker says is delivered by someone sitting silent on screen. Showing
      // the whole frame keeps whoever is talking visible.
      return {
        mode: 'fit_blur',
        reason: 'unlocalized_speakers',
        centers,
        raw_centers: rawCenters,
        heard_speakers: heardSpeakers.length,
        located_speakers: activeSpeakers.length,
      };
    }
    centers[activeSpeakers[0]] = 0.5;
    return { mode: 'center_crop', reason: 'single_speaker_stable', centers, raw_centers: rawCenters };
  }
  const rawActiveCenters = activeSpeakers
    .map(speaker => Number(rawCenters[speaker]))
    .filter(Number.isFinite);
  const rawSpread = rawActiveCenters.length >= 2
    ? Math.max(...rawActiveCenters) - Math.min(...rawActiveCenters)
    : null;
  if (rawSpread != null && rawSpread < 0.18) {
    for (const speaker of activeSpeakers) centers[speaker] = 0.5;
    return {
      mode: 'center_crop',
      reason: 'measured_positions_not_separated',
      centers,
      raw_centers: rawCenters,
      raw_spread: Number(rawSpread.toFixed(4)),
    };
  }
  if (spread < 0.18) {
    for (const speaker of activeSpeakers) centers[speaker] = 0.5;
    return { mode: 'center_crop', reason: 'speaker_positions_not_separated', centers, raw_centers: rawCenters };
  }
  return {
    mode: 'active_speaker',
    reason: 'separated_multi_speaker',
    centers,
    raw_centers: rawCenters,
    spread: Number(spread.toFixed(4)),
    raw_spread: rawSpread == null ? null : Number(rawSpread.toFixed(4)),
  };
}

export function activeSpeakerCropFilter({ width, height, centers, intervals, captionSuffix = '', outputLabel = 'v' }) {
  const rawWidth = Number(width);
  const rawHeight = Number(height);
  if (!Number.isFinite(rawWidth) || !Number.isFinite(rawHeight) || rawWidth < 2 || rawHeight < 2) return null;
  const sourceWidth = Math.floor(rawWidth);
  const sourceHeight = Math.floor(rawHeight);
  if (!Object.keys(centers || {}).length) return null;

  let cropWidth = Math.min(sourceWidth, Math.round(sourceHeight * 9 / 16));
  let cropHeight = sourceHeight;
  if (cropWidth >= sourceWidth) {
    cropWidth = sourceWidth;
    cropHeight = Math.min(sourceHeight, Math.round(sourceWidth * 16 / 9));
  }
  const defaultY = Math.max(0, Math.round((sourceHeight - cropHeight) / 2));
  const positions = [];
  for (const interval of intervals || []) {
    const center = Number(centers?.[interval.speaker]);
    if (!Number.isFinite(center)) continue;
    const x = Math.max(0, Math.min(sourceWidth - cropWidth, Math.round((center * sourceWidth) - (cropWidth / 2))));
    const start = Number(interval.start);
    if (!Number.isFinite(start)) continue;
    if (positions.at(-1)?.x === x) continue;
    positions.push({ start, x });
  }
  if (!positions.length) return null;

  // Hold the last crop through pauses. Only verified, spatially separated
  // multi-speaker layouts reach this path; edited single-speaker footage uses
  // one stable center crop instead of fighting the source camera cuts.
  let xExpression = String(positions[0].x);
  let previousX = positions[0].x;
  for (const position of positions.slice(1)) {
    const transitionStart = Math.max(0, position.start);
    // Short enough to read as a cut rather than a drift. At 0.35s the move was
    // slow enough to be watched happening, which draws the eye to the reframing
    // instead of to whoever started talking.
    const transitionDuration = 0.16;
    const transitionEnd = transitionStart + transitionDuration;
    const delta = position.x - previousX;
    xExpression = `if(lt(t,${transitionStart.toFixed(3)}),${xExpression},if(lt(t,${transitionEnd.toFixed(3)}),${previousX}+(${delta})*(t-${transitionStart.toFixed(3)})/${transitionDuration.toFixed(3)},${position.x}))`;
    previousX = position.x;
  }
  return `[0:v]crop=${cropWidth}:${cropHeight}:x='${xExpression}':y=${defaultY},scale=1080:1920${captionSuffix}[${outputLabel}]`;
}

/**
 * Compose an offline, shot-aware vertical crop without cutting the timeline.
 *
 * A single crop expression preserves every source frame and changes position
 * exactly on measured camera cuts. Speaker changes inside a held shot use a
 * short smoothstep move so the crop cannot flash between two positions. Every
 * segment must be a finite portrait crop; a 16:9 fallback is invalid here.
 */
export function shotAwareFramingFilter({ width, height, segments, outputLabel = 'v' }) {
  const rawWidth = Number(width);
  const rawHeight = Number(height);
  if (!Number.isFinite(rawWidth) || !Number.isFinite(rawHeight) || rawWidth < 2 || rawHeight < 2) return null;
  const sourceWidth = Math.floor(rawWidth);
  const sourceHeight = Math.floor(rawHeight);
  const rawSegments = Array.isArray(segments) ? segments : [];
  const usable = rawSegments
    .map(segment => ({
      start: segment?.start_s == null ? Number.NaN : Number(segment.start_s),
      end: segment?.end_s == null ? Number.NaN : Number(segment.end_s),
      layout: segment?.layout === 'crop' ? 'crop' : null,
      center: segment?.center_x == null ? Number.NaN : Number(segment.center_x),
      transition: segment?.transition === 'speaker_switch' ? 'speaker_switch' : 'shot_cut',
    }))
    .filter(segment => Number.isFinite(segment.start) && Number.isFinite(segment.end)
      && segment.end - segment.start > 0.02 && segment.layout && Number.isFinite(segment.center))
    .sort((left, right) => left.start - right.start);
  if (!usable.length || usable.length !== rawSegments.length) return null;
  // Do not silently concatenate a damaged or partial plan. A gap would shorten
  // the finished clip and an overlap would repeat material; either condition
  // should hand control back to the established framing fallback.
  if (usable.length > 500 || Math.abs(usable[0].start) > 0.05) return null;
  for (let index = 1; index < usable.length; index += 1) {
    if (Math.abs(usable[index].start - usable[index - 1].end) > 0.05) return null;
  }

  let cropWidth = Math.min(sourceWidth, Math.round(sourceHeight * 9 / 16));
  let cropHeight = sourceHeight;
  if (cropWidth >= sourceWidth) {
    cropWidth = sourceWidth;
    cropHeight = Math.min(sourceHeight, Math.round(sourceWidth * 16 / 9));
  }
  const defaultY = Math.max(0, Math.round((sourceHeight - cropHeight) / 2));
  const xFor = segment => Math.max(0, Math.min(
    sourceWidth - cropWidth,
    Math.round((Math.max(0, Math.min(1, segment.center)) * sourceWidth) - (cropWidth / 2)),
  ));
  let previousX = xFor(usable[0]);
  let xExpression = String(previousX);
  for (const segment of usable.slice(1)) {
    const nextX = xFor(segment);
    if (nextX === previousX) continue;
    const at = Math.max(0, segment.start);
    if (segment.transition === 'speaker_switch') {
      const duration = 0.20;
      const end = at + duration;
      const progress = `(t-${at.toFixed(3)})/${duration.toFixed(3)}`;
      const eased = `(${progress})*(${progress})*(3-2*(${progress}))`;
      xExpression = `if(lt(t,${at.toFixed(3)}),${xExpression},if(lt(t,${end.toFixed(3)}),${previousX}+(${nextX - previousX})*${eased},${nextX}))`;
    } else {
      xExpression = `if(lt(t,${at.toFixed(3)}),${xExpression},${nextX})`;
    }
    previousX = nextX;
  }
  return `[0:v]crop=${cropWidth}:${cropHeight}:x='${xExpression}':y=${defaultY},scale=1080:1920,setsar=1[${outputLabel}]`;
}

const SPEAKER_SAMPLE_BUDGET = 24;

export function sampleTimes(intervals, duration) {
  // Share the sample budget between speakers instead of spending it in time
  // order.
  //
  // Walking the intervals and stopping at the budget gave every sample to
  // whoever spoke first. On a clip where one host tells a long story, the
  // budget was exhausted before the other host's turns were reached, so he was
  // never located, and framing could only fall back to showing the whole 16:9
  // frame inside the 9:16 output. Locating both is what makes an actual
  // speaker-following zoom possible.
  //
  // Within each speaker the longest turns go first: a long turn is far more
  // likely to catch a mouth mid-sentence than a one-word interjection.
  const bySpeaker = new Map();
  for (const interval of intervals) {
    const midpoint = Math.max(0.15, Math.min(duration - 0.15, (Number(interval.start) + Number(interval.end)) / 2));
    if (!Number.isFinite(midpoint)) continue;
    const speaker = interval.speaker;
    if (!bySpeaker.has(speaker)) bySpeaker.set(speaker, []);
    bySpeaker.get(speaker).push({
      time_s: Number(midpoint.toFixed(3)),
      speaker,
      length: Number(interval.end) - Number(interval.start),
    });
  }
  for (const turns of bySpeaker.values()) turns.sort((left, right) => right.length - left.length);

  const samples = [];
  const seen = new Set();
  let progressed = true;
  while (samples.length < SPEAKER_SAMPLE_BUDGET && progressed) {
    progressed = false;
    for (const turns of bySpeaker.values()) {
      if (samples.length >= SPEAKER_SAMPLE_BUDGET) break;
      const next = turns.shift();
      if (!next) continue;
      progressed = true;
      const key = `${next.speaker}:${next.time_s.toFixed(1)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      samples.push({ time_s: next.time_s, speaker: next.speaker });
    }
  }

  if (samples.length < 4) {
    for (const fraction of [0.18, 0.4, 0.62, 0.84]) {
      const time = Math.max(0.15, Math.min(duration - 0.15, duration * fraction));
      samples.push({ time_s: Number(time.toFixed(3)), speaker: null });
    }
  }
  return samples.slice(0, SPEAKER_SAMPLE_BUDGET);
}

// A crop only needs to sit still when the camera does.
//
// The single-speaker path deliberately held one centre "instead of fighting the
// source camera cuts". That is right for a locked-off camera and wrong for a
// multicam edit: the same speaker sits in a different part of the frame in each
// shot, so one centre chosen from the median of all shots points between them -
// at the table rather than at anyone - and a subject framed at the edge of a
// wide shot gets cropped in half.
//
// When the measured face positions move across the clip, the crop follows them.
export const SHOT_TRACKING_MIN_SPREAD = 0.12;
// How far a sample has to land from the current shot before it is even a
// candidate for a cut, and how close the confirming sample has to land to it.
const SHOT_TRACKING_MIN_STEP = 0.08;
// Wide enough that two adjacent wrong readings are outvoted by their
// neighbours, narrow enough that a shot lasting three samples still survives.
const SHOT_TRACKING_MEDIAN_WINDOW = 5;
const SHOT_TRACKING_MIN_SAMPLES_TO_SMOOTH = 12;

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Group measured face positions into shots, and require a cut to prove itself
 * before the crop moves to it.
 *
 * The previous version moved the crop to every sample that differed enough
 * from the last one it had committed to. That reacted to a single wrong
 * detection exactly like a real cut: on the reference clip one frame reading
 * the taxidermy lion as the biggest face was enough to drag the crop off a
 * correctly-framed close-up, because nothing distinguished "this measurement
 * is wrong" from "the camera cut". A real cut is confirmed by what the camera
 * shows next; a bad detection is not - the sample right after it typically
 * lands back where the shot actually was. So a candidate cut is only taken
 * once a second sample lands near it too, and each shot's crop position is the
 * median of every sample inside it, which outvotes the rare bad reading that
 * does make it into a confirmed shot.
 */
export function shotTrackedFraming(samples) {
  const usable = (samples || [])
    .map(sample => ({ time_s: Number(sample?.time_s), center_x: Number(sample?.center_x) }))
    .filter(sample => Number.isFinite(sample.time_s) && Number.isFinite(sample.center_x))
    .sort((left, right) => left.time_s - right.time_s);
  if (usable.length < 3) return null;

  const positions = usable.map(sample => sample.center_x);
  const spread = Math.max(...positions) - Math.min(...positions);
  // A locked-off camera keeps every measurement in the same place. Tracking
  // there would only chase face-detection noise, so leave it a static crop.
  if (spread < SHOT_TRACKING_MIN_SPREAD) return null;

  // No smoothing pass here.
  //
  // A rolling median lived here to stop a false detection off a fixed prop
  // defining a shot, back when detection was a Haar cascade that read a
  // taxidermy lion as a face. The face model does not report that prop at all,
  // so the filter had nothing left to remove and was instead erasing real
  // cuts: the pan to the second host lasted two samples, which a five-wide
  // median flattened into the surrounding close-up, leaving him framed hard
  // left with a painting filling the rest of the shot.
  //
  // Requiring two samples to agree is enough on its own now that the readings
  // being agreed on are real faces.
  const smoothed = usable;

  // Group into shots, but a run of just one sample that nothing afterwards
  // confirms is dropped rather than trusted.
  const rawGroups = [[smoothed[0]]];
  for (const sample of smoothed.slice(1)) {
    const currentGroup = rawGroups[rawGroups.length - 1];
    const groupMedian = median(currentGroup.map(item => item.center_x));
    if (Math.abs(sample.center_x - groupMedian) < SHOT_TRACKING_MIN_STEP) {
      currentGroup.push(sample);
    } else {
      rawGroups.push([sample]);
    }
  }
  const confirmedGroups = [];
  for (const group of rawGroups) {
    if (group.length >= 2) {
      confirmedGroups.push(group);
      continue;
    }
    // An unconfirmed single sample merges into whichever confirmed neighbour
    // is closer, rather than forming - or breaking - a shot on its own.
    const solo = group[0];
    const previous = confirmedGroups[confirmedGroups.length - 1];
    const previousDistance = previous
      ? Math.abs(solo.center_x - median(previous.map(item => item.center_x)))
      : Infinity;
    if (previous && previousDistance < SHOT_TRACKING_MIN_STEP * 2) {
      previous.push(solo);
    } else {
      // No confirmed shot to fold into yet (or it is genuinely far from both
      // neighbours): keep it, but it still needs another sample later to
      // become a shot boundary, which the merge above handles on the next
      // pass if one arrives.
      confirmedGroups.push(group);
    }
  }
  const shots = confirmedGroups.filter(group => group.length >= 2);
  if (shots.length < 2) return null;

  const centers = {};
  const intervals = [];
  shots.forEach((group, index) => {
    const key = `shot_${index}`;
    centers[key] = Number(median(group.map(item => item.center_x)).toFixed(4));
    intervals.push({
      speaker: key,
      start: index === 0 ? 0 : group[0].time_s,
      end: shots[index + 1]?.[0]?.time_s ?? group[group.length - 1].time_s,
    });
  });
  return { centers, intervals, spread: Number(spread.toFixed(4)), shots: intervals.length };
}

// Camera cuts do not wait for speaker turns.
//
// Speech midpoints are the right places to ask "who is this", but they are the
// wrong places to ask "where is the shot". On the reference clip 16 turns over
// 72s put samples ~4.5s apart and clustered around turn boundaries, so the crop
// had no measurement anywhere near most cuts and simply held the previous
// framing through them. Shot tracking needs an even grid over the clip.
export const SHOT_SAMPLE_INTERVAL_S = 2;
// Sized so a normal clip never needs thinning at all: a 72s clip produces ~36
// grid samples plus its speech midpoints and still fits. The frame analysis
// accepts up to 64.
export const MAX_ANALYSIS_SAMPLES = 60;

export function shotSampleTimes(duration) {
  const total = Number(duration);
  if (!Number.isFinite(total) || total <= 1) return [];
  const step = Math.max(SHOT_SAMPLE_INTERVAL_S, total / MAX_ANALYSIS_SAMPLES);
  const times = [];
  for (let time = 0.3; time < total - 0.2; time += step) {
    times.push(Number(time.toFixed(3)));
  }
  return times;
}

/**
 * Everything the frame analysis should look at: speech midpoints so speakers
 * can be identified, plus an even grid so camera cuts are caught wherever they
 * fall. Grid samples carry no speaker and never vote on who sits where.
 */
export function analysisSamples(intervals, duration) {
  const speech = sampleTimes(intervals, duration);
  const seen = new Set(speech.map(sample => sample.time_s.toFixed(1)));
  const merged = [...speech];
  for (const time of shotSampleTimes(duration)) {
    const key = time.toFixed(1);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push({ time_s: time, speaker: null });
  }
  merged.sort((left, right) => left.time_s - right.time_s);
  if (merged.length <= MAX_ANALYSIS_SAMPLES) return merged;
  // Thin the list evenly instead of truncating it. Sorting by time and then
  // slicing the first N silently drops the END of the clip: on a 72s clip the
  // last measurement landed at 58.5s, so the final fourteen seconds had nothing
  // to aim at and the crop held its last position straight through them - which
  // is exactly where the framing was reported wrong.
  const step = merged.length / MAX_ANALYSIS_SAMPLES;
  const thinned = [];
  for (let index = 0; index < MAX_ANALYSIS_SAMPLES; index += 1) {
    thinned.push(merged[Math.min(merged.length - 1, Math.floor(index * step))]);
  }
  return thinned;
}
