import { spawnSync } from 'node:child_process';

/** Verify the final MP4, never just the creative plan. Only clear corruption blocks publication. */
function ffmpegDiagnostics(args, timeout = 120000) {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-nostdin', '-loglevel', 'info', ...args],
    { encoding: 'utf8', timeout, maxBuffer: 3 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error('content_qc_ffmpeg_failed: '
    + String(result.error?.message || result.stderr || 'unknown').slice(-350));
  return String(result.stderr || '');
}

function intervals(log, prefix) {
  return [...log.matchAll(new RegExp(prefix + ':\s*([0-9.]+).*?(?:end|duration):\s*([0-9.]+)', 'g'))]
    .map(match => [Number(match[1]), Number(match[2])]);
}

/** Returns a structured report. Fail closed for extensive black video or no audio
 * when a source audio track was expected; freeze/silence can be editorial. */
export function checkRenderedVideo(videoPath, { sourceHasAudio = true, expectedDuration = null } = {}) {
  const videoLog = ffmpegDiagnostics([
    '-i', videoPath, '-vf',
    'fps=3,scale=320:-2,blackdetect=d=1.0:pic_th=0.98,freezedetect=n=-60dB:d=3',
    '-an', '-f', 'null', '-',
  ]);
  let audioLog = '';
  if (sourceHasAudio) {
    audioLog = ffmpegDiagnostics([
      '-i', videoPath, '-af', 'silencedetect=noise=-40dB:d=2,volumedetect',
      '-vn', '-f', 'null', '-',
    ]);
  }
  const black = [...videoLog.matchAll(/black_start:\s*([0-9.]+)\s+black_end:\s*([0-9.]+)\s+black_duration:\s*([0-9.]+)/g)]
    .map(match => ({ start_s: Number(match[1]), duration_s: Number(match[3]) }));
  const frozen = [...videoLog.matchAll(/freeze_start:\s*([0-9.]+)/g)].length;
  const silence = [...audioLog.matchAll(/silence_start:\s*([0-9.]+)/g)].length;
  const maxDb = audioLog.match(/max_volume:\s*(-?[0-9.]+)\s*dB/);
  const meanDb = audioLog.match(/mean_volume:\s*(-?[0-9.]+)\s*dB/);
  const peak = maxDb ? Number(maxDb[1]) : null;
  const mean = meanDb ? Number(meanDb[1]) : null;
  const errors = [];
  const warnings = [];
  if (black.some(span => span.duration_s >= 1.5))
    errors.push('full_black_video_over_1_5s');
  if (sourceHasAudio && (mean === null || mean < -55))
    errors.push('missing_or_nearly_silent_audio');
  if (sourceHasAudio && peak !== null && peak >= -0.25)
    warnings.push('audio_peak_near_full_scale');
  if (sourceHasAudio && mean !== null && mean < -30)
    warnings.push('quiet_audio');
  if (silence > 0) warnings.push('speech_or_music_silence_' + silence);
  if (frozen > 0) warnings.push('possible_static_or_frozen_frames_' + frozen);
  return {
    schema_version: 'clipper-content-qc-v1',
    passed: errors.length === 0,
    errors, warnings,
    metrics: { black_spans: black, frozen_spans: frozen, silence_spans: silence,
      peak_db: peak, mean_db: mean, expected_duration_s: expectedDuration },
  };
}
