import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  PODCAST_CAPTION_FORCE_STYLE,
  activeSpeakerCropFilter,
  buildTranscriptAss,
  buildTranscriptSrt,
  chooseCaptionAccent,
  podcastSoundtrackAudioFilter,
  refinePodcastSpeechWindow,
  resolvePodcastFraming,
  speakerAt,
  speakerIntervalsForWindow,
  soundtrackStartOffset,
  validateAlignmentArtifactMetadata,
  validatePodcastWindow,
  validateSoundtrackPlan,
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
  assert.match(PODCAST_CAPTION_FORCE_STYLE, /FontName=Inter/);
  assert.match(PODCAST_CAPTION_FORCE_STYLE, /FontSize=15(?:,|$)/);
  assert.match(PODCAST_CAPTION_FORCE_STYLE, /Outline=1(?:,|$)/);
  assert.match(PODCAST_CAPTION_FORCE_STYLE, /Alignment=2/);
  assert.match(PODCAST_CAPTION_FORCE_STYLE, /MarginV=48/);
  assert.doesNotMatch(PODCAST_CAPTION_FORCE_STYLE, /Outline=3/);
});

test('Podcast ASS captions highlight only the currently spoken word', () => {
  const words = wordsForWindow(artifact, 99.5, 103);
  const ass = buildTranscriptAss(words, {
    name: 'yellow', rgb: [255, 215, 62], ass_bgr: '3ED7FF', text_ass_bgr: '000000', contrast_score: 9,
  });
  assert.match(ass, /Fontname, Fontsize/);
  assert.match(ass, /Style: PodcastCaption,Inter,15/);
  assert.match(ass, /Dialogue: 0,0:00:00\.50,0:00:01\.50/);
  assert.match(ass, /\\1c&H00000000&\\3c&H003ED7FF&/);
  assert.match(ass, /Hello\{\\rPodcastCaption\} world\./);
  assert.match(ass, /Hello \{\\1c&H00000000&[^}]+\}world\.\{\\rPodcastCaption\}/);
});

test('caption accent selection is deterministic and keeps active text readable', () => {
  const one = chooseCaptionAccent([[220, 180, 30], [210, 170, 20]]);
  const two = chooseCaptionAccent([{ r: 220, g: 180, b: 30 }, { r: 210, g: 170, b: 20 }]);
  assert.deepEqual(one, two);
  assert.match(one.ass_bgr, /^[0-9A-F]{6}$/);
  assert.match(one.text_ass_bgr, /^(000000|FFFFFF)$/);
  assert.ok(one.contrast_score > 1);
});

test('soundtrack plans accept only private library objects with bounded gain', () => {
  const id = '77777777-7777-4777-8777-777777777777';
  const valid = validateSoundtrackPlan({
    schema_version: 'clipper-soundtrack-v1',
    enabled: true,
    track_id: id,
    storage_bucket: 'clipper-media',
    storage_path: `music/${id}/track.mp3`,
    bytes: 12345,
    content_type: 'audio/mpeg',
    mix_gain_db: -14,
    selection: 'vibe_matched',
  });
  assert.equal(valid.id, id);
  assert.equal(valid.gain_db, -14);
  assert.throws(() => validateSoundtrackPlan({
    ...valid,
    schema_version: 'clipper-soundtrack-v1',
    enabled: true,
    track_id: id,
    storage_bucket: 'clipper-media',
    storage_path: 'renders/not-music.mp3',
    bytes: 123,
    content_type: 'audio/mpeg',
    mix_gain_db: -14,
  }), /storage identity/);
});

test('soundtrack offsets are deterministic and remain inside the non-looping headroom', () => {
  const first = soundtrackStartOffset(240, 60, 'candidate-a');
  assert.equal(first, soundtrackStartOffset(240, 60, 'candidate-a'));
  assert.ok(first >= 0 && first <= 180);
  assert.equal(soundtrackStartOffset(30, 60, 'candidate-a'), 0);
});

test('soundtrack filter normalizes, ducks, fades and limits beneath speech', () => {
  const filter = podcastSoundtrackAudioFilter({ duration: 60, gainDb: -14, sourceHasAudio: true });
  assert.match(filter, /loudnorm=I=-18/);
  assert.match(filter, /volume=-14\.00dB/);
  assert.match(filter, /apad=whole_dur=60\.000/);
  assert.match(filter, /sidechaincompress=/);
  assert.match(filter, /afade=t=out:st=58\.800:d=1\.200/);
  assert.match(filter, /alimiter=limit=0\.95/);
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

test('Podcast cuts ignore punctuation when the same thought immediately continues', () => {
  const continuingThought = {
    transcript: {
      segments: [{
        words: [
          { start_s: 127.4, end_s: 127.8, text: 'You' },
          { start_s: 127.8, end_s: 128.2, text: 'fix' },
          { start_s: 128.2, end_s: 128.6, text: 'them.' },
          { start_s: 128.7, end_s: 129.1, text: 'Then' },
          { start_s: 129.1, end_s: 129.5, text: 'you' },
          { start_s: 129.5, end_s: 130.0, text: 'build' },
          { start_s: 130.0, end_s: 130.3, text: 'the' },
          { start_s: 130.3, end_s: 131.4, text: 'portfolio.' },
          { start_s: 132.2, end_s: 132.5, text: 'Next' },
        ],
      }],
    },
  };
  const refined = refinePodcastSpeechWindow(continuingThought, 100, 128, { vodDurationS: 500 });
  assert.equal(refined.verified, true);
  assert.equal(refined.reason, 'sentence_terminal');
  assert.equal(refined.end, 131.95);
  assert.equal(refined.extension_s, 3.95);
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
  assert.match(worker, /CLIPPER_PODCAST_LOCAL_SOURCE_START_S/);
  assert.match(worker, /Manual Podcast source duration/);
  assert.match(worker, /fs\.copyFileSync\(localSource, downloaded\)/);
  assert.match(worker, /fileURLToPath\(import\.meta\.url\)/);
  assert.match(worker, /path\.join\(CLIPPER_SCRIPT_DIR, 'podcast_speaker_frames\.py'\)/);
  assert.match(worker, /path\.join\(CLIPPER_SCRIPT_DIR, 'podcast_audio_align\.py'\)/);
  assert.doesNotMatch(worker, /path\.resolve\('scripts\/clipper\/podcast_/);
});

test('Podcast render owns the same isolated proof-of-origin fallback as transcript ingest', () => {
  const workflow = fs.readFileSync(new URL('../../.github/workflows/clipper-podcast-render.yml', import.meta.url), 'utf8');
  const wrapper = fs.readFileSync(new URL('./yt-dlp-safe.sh', import.meta.url), 'utf8');
  assert.match(workflow, /yt-dlp-getpot-wpc==1\.1\.2/);
  assert.match(workflow, /patch_wpc_provider\.py/);
  assert.match(workflow, /CLIPPER_PODCAST_WPC_ENABLED: '1'/);
  assert.match(workflow, /xvfb-run -a node scripts\/clipper\/podcast_render\.mjs/);
  assert.match(wrapper, /podcast-default-retry/);
  assert.match(wrapper, /player_client=tv_downgraded;fetch_pot=never/);
  assert.match(wrapper, /run_direct_attempt podcast-direct-progressive/);
  assert.match(wrapper, /CLIPPER_YTDLP_ATTEMPT_TIMEOUT_SECONDS=90 run_attempt podcast-mweb-browser-pot/);
  assert.match(wrapper, /else\n  # V2 sequence remains intentionally unchanged\./);
});

test('both CLIPPER tracks add caption shadows after their existing layout composition', () => {
  const podcastWorker = fs.readFileSync(new URL('./podcast_render.mjs', import.meta.url), 'utf8');
  const streamWorker = fs.readFileSync(new URL('./render.mjs', import.meta.url), 'utf8');
  for (const worker of [podcastWorker, streamWorker]) {
    assert.match(worker, /layoutOutputLabel = .*caption_base/);
    assert.match(worker, /captionCompositeFilter\(/);
    assert.match(worker, /layoutFilter/);
  }
  assert.match(podcastWorker, /buildTranscriptAss/);
  assert.match(podcastWorker, /forceStyle: ''/);
  assert.match(podcastWorker, /strength: 'readable'/);
  assert.match(streamWorker, /creatorGameplayFilter\(facecam, layoutOutputLabel\)/);
});

test('Podcast V3 mixes only validated library music and leaves Stream V2 unchanged', () => {
  const podcastWorker = fs.readFileSync(new URL('./podcast_render.mjs', import.meta.url), 'utf8');
  const streamWorker = fs.readFileSync(new URL('./render.mjs', import.meta.url), 'utf8');
  assert.match(podcastWorker, /validateSoundtrackPlan\(plan\?\.output\?\.soundtrack\)/);
  assert.match(podcastWorker, /podcastSoundtrackAudioFilter/);
  assert.match(podcastWorker, /soundtrack_mixed: Boolean\(soundtrack\)/);
  assert.doesNotMatch(streamWorker, /clipper-soundtrack-v1|podcastSoundtrackAudioFilter/);
});
