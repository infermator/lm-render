import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCreativeMedia, buildHookAss, zoomFilter, musicCurveFilter } from './creative_media.mjs';
import { buildTranscriptAss } from './podcast_media.mjs';

const words = [
  { start: 0.2, end: 0.5, text: 'My' },
  { start: 0.55, end: 1, text: 'boss' },
  { start: 4.2, end: 4.6, text: 'lost' },
  { start: 4.65, end: 5.1, text: '$50,000.' },
  { start: 6, end: 6.4, text: 'today' },
];
const input = { schema_version: 'clipper-creative-v1', enabled: true,
  editing_style: 'dynamic', hook_text: 'My boss',
  emphasis_words: ['$50,000.', 'FAKE MONEY'],
  zoom_cues: [
    { at_s: 4.2, duration_s: 0.6, scale: 1.12, anchor: 'lost' },
    { at_s: 2, duration_s: 0.6, scale: 1.12, anchor: 'not spoken' },
  ],
  music_curve: [{ at_s: 0, intensity: 0.5 }, { at_s: 7, intensity: 0.9 }] };

test('creative media accepts only literal spoken anchors and bounded effects', () => {
  const plan = normalizeCreativeMedia(input, words, 8);
  assert.equal(plan.enabled, true);
  assert.equal(plan.hookText, 'My boss');
  assert.deepEqual(plan.emphasisWords, ['$50,000.']);
  assert.equal(plan.zoomCues.length, 1);
  assert.equal(plan.musicCurve.length, 2);
  assert.equal(normalizeCreativeMedia({ ...input, schema_version: 'unknown' }, words, 8).enabled, false);
  assert.equal(normalizeCreativeMedia({ ...input, hook_text: 'An invented claim' }, words, 8).hookText, '');
});

test('zoom and audio curve create valid, bounded FFmpeg filter expressions', () => {
  const plan = normalizeCreativeMedia(input, words, 8);
  assert.match(zoomFilter(plan.zoomCues, 'creative_base', 'caption_base'), /zoompan=z=/);
  assert.match(musicCurveFilter(plan.musicCurve), /volume=/);
  assert.equal(zoomFilter([], 'creative_base', 'caption_base'), null);
});

test('hook captions escape ASS override injection and emphasis uses real words', () => {
  const ass = buildHookAss('My {boss}', 8);
  assert.match(ass, /My \\{boss\\}/);
  const captions = buildTranscriptAss(words, undefined, ['$50,000.']);
  assert.match(captions, /Style: EmphasisWord,/);
  assert.match(captions, /\\rEmphasisWord/);
  assert.doesNotMatch(buildHookAss('', 8), /Dialogue/);
});
