import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  PODCAST_CAPTION_FORCE_STYLE,
  activeSpeakerCropFilter,
  buildTranscriptSrt,
  refinePodcastSpeechWindow,
  resolvePodcastFraming,
  speakerAt,
  speakerIntervalsForWindow,
  validateAlignmentArtifactMetadata,
  validatePodcastWindow,
  wordsForWindow,
} from './podcast_media.mjs';

const artifact = {
  transcript: {
    segments: [{
      start_s: 100,
      end_s: 104,
      speaker: 'SPEAKER_00',
      words: [
        { start_s: 100, end_s: 101, text: 'Hello', speaker: 'SPEAKER_00' },
        { start_s: 101, end_s: 102, text: 'world.', speaker: 'SPEAKER_00' },
      ],
    }],
  },
  diarization: { turns: [{ start_s: 99, end_s: 103, speaker: 'SPEAKER_00' }] },
};

test('podcast duration accepts stories without weakening the V2 worker contract', () => {
  assert.equal(validatePodcastWindow(10, 190).duration, 180);
  assert.throws(() => validatePodcastWindow(10, 191), /15–180s/);
});

test('captions reuse absolute transcript word timings and shift them to the cut', () => {
  const words = wordsForWindow(artifact, 99.5, 103);
  assert.deepEqual(words.map(word => word.start), [0.5, 1.5]);
  const srt = buildTranscriptSrt(words);
  assert.match(srt, /00:00:00,500 --> 00:00:02,500/);
  assert.match(srt, /Hello world\./);
});

test('Podcast captions use a lower face-safe lane and restrained outline', () => {
  assert.match(PODCAST_CAPTION_FORCE_STYLE, /Outline=1(?:,|$)/);
  assert.match(PODCAST_CAPTION_FORCE_STYLE, /Alignment=2/);
  assert.match(PODCAST_CAPTION_FORCE_STYLE, /MarginV=48/);
  assert.doesNotMatch(PODCAST_CAPTION_FORCE_STYLE, /Outline=3/);
});

test('Podcast cuts extend through the next sentence and keep a natural tail', () => {
  const boundaryArtifact = {
    transcript: {
      segments: [{
        start_s: 125,
        end_s: 133,
        words: [
          { start_s: 126.8, end_s: 127.2, text: 'Now' },
          { start_s: 127.2, end_s: 127.5, text: "you're" },
          { start_s: 127.5, end_s: 127.9, text: 'sitting' },
          { start_s: 128.1, end_s: 128.5, text: 'there' },
          { start_s: 128.5, end_s: 128.8, text: 'with' },
          { start_s: 128.8, end_s: 129.0, text: 'no' },
          { start_s: 129.0, end_s: 129.7, text: 'cashflow.' },
        ],
      }],
    },
  };
  const refined = refinePodcastSpeechWindow(boundaryArtifact, 100, 128, { vodDurationS: 500 });
  assert.equal(refined.verified, true);
  assert.equal(refined.reason, 'sentence_terminal');
  assert.equal(refined.end, 130.25);
  assert.equal(refined.duration, 30.25);
});

test('Podcast cuts preserve an existing sentence ending and reject unverifiable tails', () => {
  const complete = {
    transcript: { segments: [{ words: [{ start_s: 120, end_s: 126.5, text: 'Done.' }] }] },
  };
  assert.deepEqual(
    refinePodcastSpeechWindow(complete, 100, 127.5),
    {
      start: 100,
      end: 127.5,
      duration: 27.5,
      original_end_s: 127.5,
      extension_s: 0,
      changed: false,
      verified: true,
      reason: 'existing_natural_tail',
    },
  );

  const runOn = {
    transcript: {
      segments: [{
        words: Array.from({ length: 40 }, (_, index) => ({
          start_s: 120 + index * 0.45,
          end_s: 120.4 + index * 0.45,
          text: 'continuing',
        })),
      }],
    },
  };
  const unsafe = refinePodcastSpeechWindow(runOn, 100, 128, { maxExtensionSeconds: 5 });
  assert.equal(unsafe.verified, false);
  assert.equal(unsafe.reason, 'no_safe_boundary');
  assert.equal(unsafe.end, 128);
});

test('diarization supplies stable framing and eased multi-speaker crop switching', () => {
  assert.equal(speakerAt(artifact, 101), 'SPEAKER_00');
  const intervals = speakerIntervalsForWindow(artifact, 100, 104);
  assert.deepEqual(intervals, [{ start: 0, end: 3, speaker: 'SPEAKER_00' }]);
  assert.deepEqual(resolvePodcastFraming({
    localCenters: { SPEAKER_00: 0.56 },
    speakerPositions: { SPEAKER_00: 'center' },
    intervals,
  }), {
    mode: 'center_crop',
    reason: 'single_speaker_stable',
    centers: { SPEAKER_00: 0.5 },
    raw_centers: { SPEAKER_00: 0.56 },
  });

  const movingIntervals = [
    { start: 0, end: 1.5, speaker: 'SPEAKER_00' },
    { start: 2, end: 4, speaker: 'SPEAKER_01' },
  ];
  const moving = resolvePodcastFraming({
    localCenters: { SPEAKER_00: 0.24, SPEAKER_01: 0.76 },
    speakerPositions: { SPEAKER_00: 'left', SPEAKER_01: 'right' },
    intervals: movingIntervals,
  });
  assert.equal(moving.mode, 'active_speaker');
  assert.equal(moving.reason, 'separated_multi_speaker');
  const filter = activeSpeakerCropFilter({ width: 1920, height: 1080, centers: moving.centers, intervals: movingIntervals });
  assert.match(filter, /lt\(t,2\.000\)/);
  assert.match(filter, /lt\(t,2\.350\)/);
  assert.doesNotMatch(filter, /between\(/);
  assert.match(filter, /scale=1080:1920/);
});

test('nearby multi-speaker positions do not create fake camera motion', () => {
  const framing = resolvePodcastFraming({
    localCenters: { SPEAKER_00: 0.47, SPEAKER_01: 0.56 },
    speakerPositions: { SPEAKER_00: 'left', SPEAKER_01: 'right' },
    intervals: [
      { start: 0, end: 2, speaker: 'SPEAKER_00' },
      { start: 2, end: 4, speaker: 'SPEAKER_01' },
    ],
  });
  assert.equal(framing.mode, 'center_crop');
  assert.equal(framing.reason, 'measured_positions_not_separated');
  assert.deepEqual(framing.centers, { SPEAKER_00: 0.5, SPEAKER_01: 0.5 });
  assert.equal(framing.raw_spread, 0.09);
});

test('alignment proxy metadata is content-addressed and bounded', () => {
  const sha256 = 'a'.repeat(64);
  assert.deepEqual(validateAlignmentArtifactMetadata('vod-1', {
    bucket: 'clipper-media',
    path: `podcasts/vod-1/alignment/${sha256}.flac`,
    sha256,
    bytes: 1024,
    codec: 'flac',
    sample_rate: 8000,
    channels: 1,
  }), {
    bucket: 'clipper-media',
    path: `podcasts/vod-1/alignment/${sha256}.flac`,
    sha256,
    bytes: 1024,
    codec: 'flac',
    sample_rate: 8000,
    channels: 1,
  });
  assert.throws(() => validateAlignmentArtifactMetadata('vod-2', {
    bucket: 'clipper-media',
    path: `podcasts/vod-1/alignment/${sha256}.flac`,
    sha256,
    bytes: 1024,
    codec: 'flac',
    sample_rate: 8000,
    channels: 1,
  }), /content-addressed/);
});

test('Podcast batch materialization stays ephemeral while outputs are uploaded', () => {
  const worker = fs.readFileSync(new URL('./podcast_render.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(worker, /uploadObject\(batchSource/);
  assert.match(worker, /source_storage_path: null/);
  assert.match(worker, /shared_materialization: \{ ephemeral: true/);
});

test('Podcast render owns the same isolated proof-of-origin fallback as transcript ingest', () => {
  const workflow = fs.readFileSync(new URL('../../.github/workflows/clipper-podcast-render.yml', import.meta.url), 'utf8');
  assert.match(workflow, /yt-dlp-getpot-wpc==1\.1\.2/);
  assert.match(workflow, /patch_wpc_provider\.py/);
  assert.match(workflow, /CLIPPER_PODCAST_WPC_ENABLED: '1'/);
  assert.match(workflow, /xvfb-run -a node scripts\/clipper\/podcast_render\.mjs/);
});
