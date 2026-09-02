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
  analysisSamples,
  sampleTimes,
  shotAwareFramingFilter,
  shotTrackedFraming,
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

test('Podcast captions preserve the established face-safe lane and restrained outline', () => {
  assert.match(PODCAST_CAPTION_FORCE_STYLE, /FontName=Inter/);
  assert.match(PODCAST_CAPTION_FORCE_STYLE, /FontSize=15(?:,|$)/);
  assert.match(PODCAST_CAPTION_FORCE_STYLE, /Outline=1(?:,|$)/);
  assert.match(PODCAST_CAPTION_FORCE_STYLE, /Alignment=2/);
  assert.match(PODCAST_CAPTION_FORCE_STYLE, /MarginV=96/);
  assert.doesNotMatch(PODCAST_CAPTION_FORCE_STYLE, /Outline=3/);
});

test('Podcast ASS captions keep one stable base line and isolate the active word', () => {
  const words = wordsForWindow(artifact, 99.5, 103);
  const ass = buildTranscriptAss(words, {
    name: 'yellow', rgb: [255, 215, 62], ass_bgr: '3ED7FF', text_ass_bgr: '000000', contrast_score: 9,
  });
  assert.match(ass, /Fontname, Fontsize/);
  assert.match(ass, /Style: PodcastCaption,Inter,15/);
  assert.match(ass, /Style: ActiveWord,Inter,15,[^\n]+,3,1\.8,0,2,18,18,96,1/);
  assert.match(ass, /Style: TransparentWord,Inter,15,&HFF000000/);
  assert.match(ass, /Dialogue: 0,0:00:00\.50,0:00:02\.50,PodcastCaption,,0,0,0,,Hello world\./);
  assert.match(ass, /Dialogue: 1,0:00:00\.50,0:00:01\.50,TransparentWord/);
  assert.match(ass, /Style: ActiveWord,Inter,15,&H00000000,[^\n]+&H003ED7FF,&H003ED7FF/);
  assert.doesNotMatch(ass, /\\x?bord|\\ybord|\\blur/);
  assert.match(ass, /\{\\rActiveWord\}Hello \{\\rTransparentWord\}world\./);
  assert.match(ass, /\{\\rTransparentWord\}Hello \{\\rActiveWord\}world\./);
});

test('Podcast ASS captions never overlap full lines or flash sub-80ms highlights', () => {
  const ass = buildTranscriptAss([
    { start: 0.5, end: 0.54, text: 'I', speaker: 'SPEAKER_00' },
    { start: 0.54, end: 0.58, text: 'am', speaker: 'SPEAKER_00' },
    { start: 0.58, end: 0.9, text: 'ready.', speaker: 'SPEAKER_00' },
  ]);
  const dialogue = ass.split('\n').filter(line => line.startsWith('Dialogue:'));
  assert.equal(dialogue.filter(line => line.startsWith('Dialogue: 0,')).length, 1);
  assert.equal(dialogue.filter(line => line.startsWith('Dialogue: 1,')).length, 1);
  assert.match(dialogue[0], /0:00:00\.50,0:00:00\.90/);
  assert.match(dialogue[1], /0:00:00\.58,0:00:00\.90/);
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
    mix_gain_db: -8,
    selection: 'vibe_matched',
  });
  assert.equal(valid.id, id);
  assert.equal(valid.gain_db, -8);
  assert.throws(() => validateSoundtrackPlan({
    ...valid,
    schema_version: 'clipper-soundtrack-v1',
    enabled: true,
    track_id: id,
    storage_bucket: 'clipper-media',
    storage_path: 'renders/not-music.mp3',
    bytes: 123,
    content_type: 'audio/mpeg',
    mix_gain_db: -8,
  }), /storage identity/);
});

test('soundtrack offsets are deterministic and remain inside the non-looping headroom', () => {
  const first = soundtrackStartOffset(240, 60, 'candidate-a');
  assert.equal(first, soundtrackStartOffset(240, 60, 'candidate-a'));
  assert.ok(first >= 0 && first <= 180);
  assert.equal(soundtrackStartOffset(30, 60, 'candidate-a'), 0);
});

test('soundtrack filter normalizes, ducks, fades and limits beneath speech', () => {
  const filter = podcastSoundtrackAudioFilter({ duration: 60, gainDb: -8, sourceHasAudio: true });
  assert.match(filter, /loudnorm=I=-18/);
  assert.match(filter, /volume=-8\.00dB/);
  assert.match(filter, /apad=whole_dur=60\.000/);
  assert.match(filter, /sidechaincompress=threshold=0\.06:ratio=4/);
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

test('Podcast cuts prefer a real sentence ending and fall back to the widest gap', () => {
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
      usable: true,
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
  // Run-on speech still fails verification - we did not find a real ending and
  // must not pretend otherwise - but it no longer aborts the render. Refusing
  // outright threw away otherwise valid clips whose only fault was that the
  // speaker did not pause within the search window.
  const unsafe = refinePodcastSpeechWindow(runOn, 100, 128, { maxExtensionSeconds: 5 });
  assert.equal(unsafe.verified, false);
  assert.equal(unsafe.usable, true);
  assert.equal(unsafe.reason, 'widest_word_gap');
  assert.ok(unsafe.end >= 128, 'the ending never moves earlier than planned');
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
  // The move should read as a cut, not a drift the eye follows.
  assert.match(filter, /lt\(t,2\.160\)/);
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

test('shot-aware framing preserves the source timeline and never emits a 16:9 insert', () => {
  const filter = shotAwareFramingFilter({
    width: 1920,
    height: 1080,
    outputLabel: 'shot_out',
    segments: [
      { start_s: 0, end_s: 2.069, layout: 'crop', center_x: 0.25, transition: 'shot_cut' },
      { start_s: 2.069, end_s: 7.341, layout: 'crop', center_x: 0.75, transition: 'shot_cut' },
    ],
  });
  assert.match(filter, /crop=608:1080:x='[^']*176[^']*':y='[^']*'/);
  assert.match(filter, /lt\(t,2\.069\)/);
  assert.match(filter, /scale=1080:1920,setsar=1\[shot_out\]/);
  assert.doesNotMatch(filter, /(?:split|trim|concat|gblur|overlay)=?/);
  assert.doesNotMatch(filter, /2\.269/, 'camera cuts must not arrive late through an eased crop');
});

test('shot-aware framing eases a speaker switch inside a held camera shot', () => {
  const filter = shotAwareFramingFilter({
    width: 1920,
    height: 1080,
    segments: [
      { start_s: 0, end_s: 2, layout: 'crop', center_x: 0.25, transition: 'shot_cut' },
      { start_s: 2, end_s: 4, layout: 'crop', center_x: 0.75, transition: 'speaker_switch' },
    ],
  });
  assert.match(filter, /lt\(t,2\.000\)/);
  assert.match(filter, /lt\(t,2\.420\)/);
  assert.match(filter, /3-2\*/);
});

test('shot-aware framing rejects an unusable plan', () => {
  assert.equal(shotAwareFramingFilter({ width: 1920, height: 1080, segments: [] }), null);
  assert.equal(shotAwareFramingFilter({
    width: 1920,
    height: 1080,
    segments: [{ start_s: 0, end_s: 2, layout: 'crop', center_x: null }],
  }), null);
  assert.equal(shotAwareFramingFilter({
    width: 1920,
    height: 1080,
    segments: [{ start_s: 0, end_s: 2, layout: 'fit_blur', center_x: null }],
  }), null);
  assert.equal(shotAwareFramingFilter({
    width: 1920,
    height: 1080,
    segments: [
      { start_s: 0, end_s: 2, layout: 'crop', center_x: 0.5 },
      { start_s: 2.2, end_s: 4, layout: 'crop', center_x: 0.5 },
    ],
  }), null);
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

test('Podcast rendering has no landscape or fit-blur fallback path', () => {
  const worker = fs.readFileSync(new URL('./podcast_render.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(worker, /fit_blur|fitBlurFilter|force_original_aspect_ratio=decrease/);
  assert.match(worker, /const layoutFilter = activeFilter \|\| centerCropFilter\(layoutOutputLabel\)/);
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

test('a second speaker we cannot place stops the crop committing to the first', () => {
  // The reported failure: 30 diarization intervals, but frame analysis located
  // only SPEAKER_00, so framing reported "single_speaker_stable" and hard-cropped
  // the whole clip onto one person. Every line the other host spoke was then
  // delivered by someone sitting silent on screen.
  const framing = resolvePodcastFraming({
    localCenters: { SPEAKER_00: 0.5665 },
    speakerPositions: { SPEAKER_00: 'left' },
    intervals: [
      { speaker: 'SPEAKER_00', start: 0, end: 4 },
      { speaker: 'SPEAKER_01', start: 4, end: 9 },
      { speaker: 'SPEAKER_00', start: 9, end: 14 },
    ],
  });
  assert.equal(framing.mode, 'fit_blur');
  assert.equal(framing.reason, 'unlocalized_speakers');
  assert.equal(framing.heard_speakers, 2);
  assert.equal(framing.located_speakers, 1);
});

test('a genuinely single-speaker window still centre-crops', () => {
  const framing = resolvePodcastFraming({
    localCenters: { SPEAKER_00: 0.5665 },
    speakerPositions: { SPEAKER_00: 'left' },
    intervals: [
      { speaker: 'SPEAKER_00', start: 0, end: 4 },
      { speaker: 'SPEAKER_00', start: 4, end: 9 },
    ],
  });
  assert.equal(framing.mode, 'center_crop');
  assert.equal(framing.reason, 'single_speaker_stable');
});

test('two located speakers far apart still track the active one', () => {
  const framing = resolvePodcastFraming({
    localCenters: { SPEAKER_00: 0.25, SPEAKER_01: 0.75 },
    speakerPositions: { SPEAKER_00: 'left', SPEAKER_01: 'right' },
    intervals: [
      { speaker: 'SPEAKER_00', start: 0, end: 4 },
      { speaker: 'SPEAKER_01', start: 4, end: 9 },
    ],
  });
  assert.equal(framing.mode, 'active_speaker');
});


test('the sample budget is shared between speakers, not spent in time order', () => {
  // The reported failure: one host told a long story, the budget was exhausted
  // walking intervals in time order, and the other host was never sampled - so
  // he could never be located and framing had to show the whole 16:9 frame
  // inside the 9:16 output instead of following whoever was speaking.
  const intervals = [];
  for (let index = 0; index < 24; index += 1) {
    intervals.push({ speaker: 'SPEAKER_00', start: index * 4, end: index * 4 + 3.5 });
  }
  for (let index = 0; index < 6; index += 1) {
    intervals.push({ speaker: 'SPEAKER_01', start: 96 + index * 4, end: 96 + index * 4 + 3.5 });
  }
  const samples = sampleTimes(intervals, 140);
  const perSpeaker = samples.reduce((counts, sample) => {
    counts[sample.speaker] = (counts[sample.speaker] || 0) + 1;
    return counts;
  }, {});
  assert.ok(perSpeaker.SPEAKER_01 >= 6, 'the quieter speaker must still be sampled');
  assert.ok(perSpeaker.SPEAKER_00 > 0);
  assert.equal(samples.length, 24, 'the budget is still respected');
});

test('the longest turn of each speaker is sampled first', () => {
  // A one-word interjection rarely catches a mouth mid-sentence; a long turn
  // usually does.
  const samples = sampleTimes([
    { speaker: 'SPEAKER_00', start: 0, end: 0.4 },
    { speaker: 'SPEAKER_00', start: 10, end: 30 },
    { speaker: 'SPEAKER_01', start: 40, end: 60 },
    { speaker: 'SPEAKER_01', start: 70, end: 70.4 },
  ], 90);
  assert.equal(samples[0].time_s, 20);
  assert.equal(samples[1].time_s, 50);
});


test('continuous speech ends on the widest gap instead of killing the render', () => {
  // Reported as a hard failure: "natural_end_unverified: no sentence ending or
  // speech pause found within 2187.40-2199.40s". A clip whose ending is merely
  // imperfect should not throw away an otherwise valid render.
  // Unpunctuated, tightly packed speech that keeps going past the search limit.
  // It has to run past the limit: reaching the end of the transcript counts as
  // a pause, which would verify the window for the wrong reason.
  const words = [];
  for (let index = 0; index < 90; index += 1) {
    const start = 100 + index * 0.5;
    words.push({ text: 'and', start_s: start, end_s: start + 0.42 });
  }
  const artifact = { transcript: { segments: [{ speaker: 'SPEAKER_00', words }] } };
  const refined = refinePodcastSpeechWindow(artifact, 100, 122);
  assert.equal(refined.verified, false, 'it must not claim a natural ending it did not find');
  assert.equal(refined.usable, true, 'but the render must still be allowed to proceed');
  assert.equal(refined.reason, 'widest_word_gap');
  assert.ok(refined.end >= 122, 'the ending never moves earlier than planned');
});

test('a window with no transcript behind it is still refused', () => {
  const refined = refinePodcastSpeechWindow({ transcript: { segments: [] } }, 100, 122);
  assert.equal(refined.usable, false);
  assert.equal(refined.reason, 'no_transcript_words');
});


test('a multicam edit tracks the subject through the camera cuts', () => {
  // The reported frame: the second host jammed against the right edge, half out
  // of frame, because one centre was held across shots that place him in
  // completely different parts of the picture.
  const tracked = shotTrackedFraming([
    { time_s: 2, center_x: 0.5 },
    { time_s: 20, center_x: 0.5 },
    { time_s: 40, center_x: 0.82 },
    { time_s: 60, center_x: 0.8 },
  ]);
  assert.ok(tracked, 'moving face positions must produce a tracked crop');
  assert.ok(tracked.shots >= 2);
  assert.equal(tracked.intervals[0].start, 0, 'the first shot owns the clip from its very beginning');
  assert.ok(Object.values(tracked.centers).some(center => center > 0.7), 'it must reach the off-centre shot');
});

test('a locked-off camera is left as a static crop', () => {
  // Tracking a camera that never moves would only chase detector jitter.
  assert.equal(shotTrackedFraming([
    { time_s: 2, center_x: 0.50 },
    { time_s: 20, center_x: 0.52 },
    { time_s: 40, center_x: 0.49 },
    { time_s: 60, center_x: 0.51 },
  ]), null);
});

test('detector jitter never moves the frame on its own', () => {
  // One genuine shot change, with noise around it: the noise must not each
  // become its own crop position.
  const tracked = shotTrackedFraming([
    { time_s: 2, center_x: 0.30 },
    { time_s: 10, center_x: 0.31 },
    { time_s: 18, center_x: 0.302 },
    { time_s: 26, center_x: 0.75 },
    { time_s: 34, center_x: 0.757 },
  ]);
  assert.equal(tracked.shots, 2, 'one move, not five');
});

test('too few samples cannot claim to know the shots', () => {
  assert.equal(shotTrackedFraming([{ time_s: 2, center_x: 0.2 }, { time_s: 8, center_x: 0.8 }]), null);
  assert.equal(shotTrackedFraming([]), null);
});

test('one wrong detection inside a real shot does not move the crop', () => {
  // Measured on the reference clip: a close-up of one host, correctly read at
  // ~0.49 by every sample, except one frame where the taxidermy lion measured
  // larger than his face. The previous version treated that single reading
  // exactly like a real cut and dragged the crop onto it. It must not form its
  // own shot, or even pull the shot\'s centre off the real position.
  const tracked = shotTrackedFraming([
    { time_s: 50.3, center_x: 0.2115 }, { time_s: 52.3, center_x: 0.4927 },
    { time_s: 54.3, center_x: 0.4973 }, { time_s: 56.3, center_x: 0.3384 },
    { time_s: 58.3, center_x: 0.4786 }, { time_s: 58.5, center_x: 0.4949 },
  ]);
  // Splitting the run into two nearly-identical positions is harmless - the
  // crop barely moves either way. What must never happen is either outlier
  // (0.21, 0.34) winning a shot on its own and dragging the crop there.
  for (const center of Object.values(tracked.centers)) {
    assert.ok(Math.abs(center - 0.49) < 0.03, `every shot must stay near the real position, got ${center}`);
  }
});

test('a real cut to the second host is confirmed and taken', () => {
  // The reported gap: at a genuine camera cut to the other host, the crop
  // stayed on the first speaker\'s position instead of following the cut.
  // Two samples landing together on the new position must be enough to move.
  const tracked = shotTrackedFraming([
    { time_s: 0.3, center_x: 0.50 }, { time_s: 2.3, center_x: 0.49 }, { time_s: 4.3, center_x: 0.51 },
    { time_s: 16.3, center_x: 0.72 }, { time_s: 18.3, center_x: 0.70 }, { time_s: 20.3, center_x: 0.71 },
    { time_s: 24.3, center_x: 0.50 }, { time_s: 26.3, center_x: 0.49 }, { time_s: 28.3, center_x: 0.50 },
  ]);
  assert.equal(tracked.shots, 3, 'out, to the other host, and back');
  const cutShot = tracked.intervals.find(interval => interval.start === 16.3);
  assert.ok(cutShot, 'the cut at 16.3s must be its own shot rather than folded into a neighbour');
  assert.ok(tracked.centers[cutShot.speaker] > 0.65, 'and framed on the host it cut to, not the midpoint');
});


test('shot sampling covers the clip evenly, not just at speaker turns', () => {
  // 16 turns over 72s put speech samples ~4.5s apart and bunched at turn
  // boundaries, so most camera cuts had no measurement near them and the crop
  // held the previous framing straight through.
  const intervals = [];
  for (let index = 0; index < 16; index += 1) {
    intervals.push({ speaker: 'SPEAKER_00', start: index * 4.5, end: index * 4.5 + 4 });
  }
  const samples = analysisSamples(intervals, 72);
  const gaps = samples.slice(1).map((sample, index) => sample.time_s - samples[index].time_s);
  assert.ok(Math.max(...gaps) <= 2.6, `no cut should sit more than ~2s from a sample (worst ${Math.max(...gaps)})`);
  assert.ok(samples.some(sample => sample.speaker === 'SPEAKER_00'), 'speech samples survive for speaker identity');
  assert.ok(samples.some(sample => sample.speaker === null), 'grid samples are added for shot tracking');
});

test('the analysis sample budget is bounded', () => {
  const intervals = Array.from({ length: 200 }, (_, index) => ({
    speaker: `SPEAKER_0${index % 2}`, start: index * 3, end: index * 3 + 2.5,
  }));
  assert.ok(analysisSamples(intervals, 600).length <= 60);
});


test('thinning samples keeps the end of the clip', () => {
  // Slicing the sorted list dropped the tail: on a 72s clip the last sample
  // landed at 58.5s, leaving the final fourteen seconds unmeasured and the crop
  // frozen on its previous position through them.
  const intervals = Array.from({ length: 40 }, (_, index) => ({
    speaker: 'SPEAKER_00', start: index * 1.8, end: index * 1.8 + 1.5,
  }));
  const samples = analysisSamples(intervals, 72.27);
  const last = samples[samples.length - 1].time_s;
  assert.ok(samples.length <= 60);
  assert.ok(last > 66, `the last sample must be near the end of the clip, got ${last}`);
});

test('a short cut to the other host is kept, not smoothed away', () => {
  // Measured on the reference render across 0:20. The two samples at ~0.377
  // are the second host, who asks a question there - the frames confirm it.
  // An earlier version read them as a false detection off a prop and filtered
  // them out, which left him framed hard left with a painting filling the rest
  // of the shot while he was the one speaking.
  const measured = [
    { time_s: 10.3, center_x: 0.5082 }, { time_s: 12.3, center_x: 0.5066 },
    { time_s: 13.89, center_x: 0.4982 }, { time_s: 14.3, center_x: 0.4979 },
    { time_s: 15.46, center_x: 0.4695 }, { time_s: 16.3, center_x: 0.4719 },
    { time_s: 17.16, center_x: 0.4908 }, { time_s: 18.3, center_x: 0.4592 },
    { time_s: 20.22, center_x: 0.4947 }, { time_s: 20.3, center_x: 0.3775 },
    { time_s: 22.3, center_x: 0.3773 }, { time_s: 23.26, center_x: 0.4911 },
    { time_s: 24.3, center_x: 0.4977 }, { time_s: 26.3, center_x: 0.4939 },
    { time_s: 28.29, center_x: 0.3638 }, { time_s: 30.3, center_x: 0.4689 },
  ];
  const tracked = shotTrackedFraming(measured);
  assert.ok(tracked, 'the cut must produce shots');
  const centers = Object.values(tracked.centers);
  assert.ok(
    centers.some(center => Math.abs(center - 0.377) < 0.03),
    `a shot must land on the second host at ~0.377, got ${JSON.stringify(centers)}`,
  );
  assert.ok(centers.some(center => Math.abs(center - 0.49) < 0.04), 'and the main speaker keeps his own');
});

test('a sustained cut is framed on the person it cut to', () => {
  // The filter that suppresses a two-sample false positive must not also
  // suppress a real cut the camera holds for several seconds.
  const tracked = shotTrackedFraming([
    { time_s: 0.3, center_x: 0.50 }, { time_s: 2.3, center_x: 0.49 }, { time_s: 4.3, center_x: 0.51 },
    { time_s: 6.3, center_x: 0.50 }, { time_s: 8.3, center_x: 0.49 },
    { time_s: 16.3, center_x: 0.72 }, { time_s: 18.3, center_x: 0.70 },
    { time_s: 20.3, center_x: 0.71 }, { time_s: 22.3, center_x: 0.72 },
    { time_s: 24.3, center_x: 0.50 }, { time_s: 26.3, center_x: 0.49 },
    { time_s: 28.3, center_x: 0.50 }, { time_s: 30.3, center_x: 0.51 },
  ]);
  assert.ok(tracked, 'a real cut must still produce shots');
  assert.ok(
    Object.values(tracked.centers).some(center => center > 0.65),
    'and must actually frame the person it cut to',
  );
});

test('framing zooms to the faces and seats them off the top edge', () => {
  // The full-height slice this replaced left a seated speaker's head against
  // the top edge with his chest filling the lower half of the frame, and made
  // anyone in a wide shot too small to see.
  const width = 3840;
  const height = 2160;
  const plan = faceHeight => ({
    segments: [{
      start_s: 0, end_s: 10, layout: 'crop',
      center_x: 0.5, center_y: 0.34, face_h: faceHeight, transition: 'shot_cut',
    }],
    width, height, outputLabel: 'v',
  });

  const filter = shotAwareFramingFilter(plan(0.16));
  const [, cropWidth, cropHeight] = filter.match(/crop=(\d+):(\d+)/).map(Number);
  assert.ok(cropHeight < height, 'a face-sized crop must be tighter than the whole frame');
  assert.equal(cropWidth % 2, 0, 'even dimensions keep the encoder from resampling chroma');
  assert.equal(cropHeight % 2, 0);
  assert.ok(
    Math.abs(cropWidth / cropHeight - 9 / 16) < 0.01,
    `the crop must stay 9:16, got ${cropWidth}x${cropHeight}`,
  );

  // The face must land near the upper third, not at the very top.
  const y = Number(filter.match(/y='(\d+)'/)[1]);
  const faceCentreWithinCrop = (0.34 * height - y) / cropHeight;
  assert.ok(
    faceCentreWithinCrop > 0.3 && faceCentreWithinCrop < 0.55,
    `face should sit around the upper third, landed at ${(faceCentreWithinCrop * 100).toFixed(0)}%`,
  );
});

test('framing never upscales far enough to go soft', () => {
  // A distant face cannot be zoomed to portrait size without visibly degrading
  // the picture; the crop stops before that rather than chasing the target.
  const filter = shotAwareFramingFilter({
    segments: [{ start_s: 0, end_s: 10, layout: 'crop', center_x: 0.5, center_y: 0.44, face_h: 0.02, transition: 'shot_cut' }],
    width: 3840, height: 2160, outputLabel: 'v',
  });
  const [, , cropHeight] = filter.match(/crop=(\d+):(\d+)/).map(Number);
  assert.ok(cropHeight >= 1920 * 0.7, `crop got too small to stay sharp: ${cropHeight}`);
});

test('framing keeps the crop inside the source on every axis', () => {
  // A face near an edge must not push the crop rectangle out of the frame,
  // which ffmpeg would either clamp silently or fail on.
  for (const [cx, cy] of [[0.02, 0.05], [0.98, 0.95], [0.5, 0.5]]) {
    const filter = shotAwareFramingFilter({
      segments: [{ start_s: 0, end_s: 10, layout: 'crop', center_x: cx, center_y: cy, face_h: 0.12, transition: 'shot_cut' }],
      width: 3840, height: 2160, outputLabel: 'v',
    });
    const [, cropWidth, cropHeight] = filter.match(/crop=(\d+):(\d+)/).map(Number);
    const x = Number(filter.match(/x='(\d+)/)[1]);
    const y = Number(filter.match(/y='(\d+)/)[1]);
    assert.ok(x >= 0 && x + cropWidth <= 3840, `x out of bounds at ${cx}: ${x}+${cropWidth}`);
    assert.ok(y >= 0 && y + cropHeight <= 2160, `y out of bounds at ${cy}: ${y}+${cropHeight}`);
  }
});

test('the music bed skips a music video intro', () => {
  // Tracks are harvested from video platforms, where a music video opens with a
  // title card, dialogue or an ambient effect before the song starts. Beginning
  // the bed at zero put that under the first seconds of the clip.
  const trackDuration = 115;
  const clipDuration = 40;
  const offsets = ['a', 'b', 'c', 'd', 'e', 'f'].map(seed => soundtrackStartOffset(trackDuration, clipDuration, seed));
  for (const offset of offsets) {
    assert.ok(offset >= 10, `bed started inside the intro at ${offset}s`);
    assert.ok(offset + clipDuration <= trackDuration, `bed ran past the end of the track at ${offset}s`);
  }
});

test('a track barely longer than the clip still yields a usable offset', () => {
  // Skipping a lead-in must not push the bed past the end of a short track.
  const offset = soundtrackStartOffset(80, 72, 'seed');
  assert.ok(offset >= 0 && offset + 72 <= 80, `offset ${offset} does not fit the track`);
});

test('a track shorter than the clip starts at zero and loops', () => {
  assert.equal(soundtrackStartOffset(60, 72, 'seed'), 0);
});
