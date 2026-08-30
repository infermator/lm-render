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
  const gainDb = Number(raw.mix_gain_db ?? -14);
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

export function podcastSoundtrackAudioFilter({ duration: durationValue, gainDb: gainValue, sourceHasAudio = true }) {
  const duration = Number(durationValue);
  const gainDb = Number(gainValue);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('Soundtrack mix duration is invalid');
  if (!Number.isFinite(gainDb) || gainDb < -30 || gainDb > -6) throw new Error('Soundtrack mix gain is invalid');
  const fadeOutDuration = Math.min(1.2, Math.max(0.25, duration / 8));
  const fadeOutStart = Math.max(0, duration - fadeOutDuration);
  const music = `[1:a]aformat=sample_rates=48000:channel_layouts=stereo,loudnorm=I=-18:LRA=7:TP=-2,volume=${gainDb.toFixed(2)}dB,atrim=0:${duration.toFixed(3)},asetpts=PTS-STARTPTS,afade=t=in:st=0:d=0.45,afade=t=out:st=${fadeOutStart.toFixed(3)}:d=${fadeOutDuration.toFixed(3)}[music_pre]`;
  if (!sourceHasAudio) return `${music};[music_pre]alimiter=limit=0.95:attack=5:release=50[a]`;
  return [
    music,
    `[0:a]aformat=sample_rates=48000:channel_layouts=stereo,apad=whole_dur=${duration.toFixed(3)},atrim=0:${duration.toFixed(3)},asplit=2[source_mix][speech_key]`,
    '[music_pre][speech_key]sidechaincompress=threshold=0.03:ratio=10:attack=20:release=450:makeup=1[ducked_music]',
    '[source_mix][ducked_music]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.95:attack=5:release=50[a]',
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
      reason: 'existing_natural_tail',
    };
  }

  let chosen = lastAtPlan;
  let terminalFound = sentenceTerminal(lastAtPlan.text)
    && lastAtPlan.end >= original.end - 0.2
    && existingPause;
  let pauseFound = false;
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
    const hasPauseAfter = !next || next.start - word.end >= pauseSeconds;
    if (word.end >= original.end - 0.2 && sentenceTerminal(word.text) && hasPauseAfter) {
      terminalFound = true;
      break;
    }
    if (word.end >= original.end - 0.2 && hasPauseAfter) {
      pauseFound = true;
    }
  }

  const verified = terminalFound || pauseFound;
  const refinedEnd = verified
    ? Math.max(original.end, Math.min(maximumEnd, chosen.end + tailSeconds))
    : original.end;
  return {
    start: original.start,
    end: Number(refinedEnd.toFixed(3)),
    duration: Number((refinedEnd - original.start).toFixed(3)),
    original_end_s: original.end,
    extension_s: Number((refinedEnd - original.end).toFixed(3)),
    changed: refinedEnd > original.end + 0.05,
    verified,
    reason: terminalFound ? 'sentence_terminal' : pauseFound ? 'speech_pause' : 'no_safe_boundary',
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

  const activeSpeakers = [...new Set((intervals || [])
    .map(interval => String(interval?.speaker || ''))
    .filter(speaker => speaker && Number.isFinite(Number(centers[speaker]))))];
  if (!activeSpeakers.length) {
    return { mode: 'fit_blur', reason: 'no_positioned_speaker', centers, raw_centers: rawCenters };
  }

  const activeCenters = activeSpeakers.map(speaker => Number(centers[speaker]));
  const spread = Math.max(...activeCenters) - Math.min(...activeCenters);
  if (activeSpeakers.length === 1) {
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
    const transitionDuration = 0.35;
    const transitionEnd = transitionStart + transitionDuration;
    const delta = position.x - previousX;
    xExpression = `if(lt(t,${transitionStart.toFixed(3)}),${xExpression},if(lt(t,${transitionEnd.toFixed(3)}),${previousX}+(${delta})*(t-${transitionStart.toFixed(3)})/${transitionDuration.toFixed(3)},${position.x}))`;
    previousX = position.x;
  }
  return `[0:v]crop=${cropWidth}:${cropHeight}:x='${xExpression}':y=${defaultY},scale=1080:1920${captionSuffix}[${outputLabel}]`;
}
