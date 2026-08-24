export const PODCAST_CAPTION_FORCE_STYLE = 'FontName=DejaVu Sans,FontSize=17,Bold=1,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,Outline=1,Shadow=0,Alignment=2,MarginV=48';

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
  if (existingTail >= tailSeconds && (sentenceTerminal(lastAtPlan.text) || existingPause)) {
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
  let terminalFound = sentenceTerminal(lastAtPlan.text) && lastAtPlan.end >= original.end - 0.2;
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
    if (word.end >= original.end - 0.2 && sentenceTerminal(word.text)) {
      terminalFound = true;
      break;
    }
    const next = words[index + 1];
    if (word.end >= original.end - 0.2 && (!next || next.start - word.end >= pauseSeconds)) {
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

export function buildTranscriptSrt(words) {
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
  return groups.map((items, index) => {
    const text = items.map(item => String(item.text || '').trim()).filter(Boolean).join(' ').replace(/\s+([,.;!?])/g, '$1');
    return `${index + 1}\n${srtTimestamp(items[0].start)} --> ${srtTimestamp(items.at(-1).end)}\n${text}\n`;
  }).join('\n');
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

export function activeSpeakerCropFilter({ width, height, centers, intervals, captionSuffix = '' }) {
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
  return `[0:v]crop=${cropWidth}:${cropHeight}:x='${xExpression}':y=${defaultY},scale=1080:1920${captionSuffix}[v]`;
}
