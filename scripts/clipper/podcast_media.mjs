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
  const defaultX = Math.max(0, Math.round((sourceWidth - cropWidth) / 2));
  const defaultY = Math.max(0, Math.round((sourceHeight - cropHeight) / 2));
  let xExpression = String(defaultX);
  for (const interval of [...intervals].reverse()) {
    const center = Number(centers?.[interval.speaker]);
    if (!Number.isFinite(center)) continue;
    const x = Math.max(0, Math.min(sourceWidth - cropWidth, Math.round((center * sourceWidth) - (cropWidth / 2))));
    xExpression = `if(between(t,${Number(interval.start).toFixed(3)},${Number(interval.end).toFixed(3)}),${x},${xExpression})`;
  }
  return `[0:v]crop=${cropWidth}:${cropHeight}:x='${xExpression}':y=${defaultY},scale=1080:1920${captionSuffix}[v]`;
}
