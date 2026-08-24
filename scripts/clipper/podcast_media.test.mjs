import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  activeSpeakerCropFilter,
  buildTranscriptSrt,
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

test('diarization supplies active speaker intervals and crop switching', () => {
  assert.equal(speakerAt(artifact, 101), 'SPEAKER_00');
  const intervals = speakerIntervalsForWindow(artifact, 100, 104);
  assert.deepEqual(intervals, [{ start: 0, end: 3, speaker: 'SPEAKER_00' }]);
  const filter = activeSpeakerCropFilter({ width: 1920, height: 1080, centers: { SPEAKER_00: 0.25 }, intervals });
  assert.match(filter, /between\(t,0\.000,3\.000\)/);
  assert.match(filter, /scale=1080:1920/);
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
