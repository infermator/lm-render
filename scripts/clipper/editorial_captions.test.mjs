import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildEditorialCaptionsAss, editorialCaptionGroups, normalizeEditorialCards,
  EDITORIAL_CAPTION_CONTRACT } from './editorial_captions.mjs';

const words = [
  { start: 0.0, end: 0.14, text: 'You', speaker: 'one' },
  { start: 0.14, end: 0.29, text: "don't", speaker: 'one' },
  { start: 0.29, end: 0.45, text: 'use', speaker: 'one' },
  { start: 0.45, end: 0.6, text: 'the', speaker: 'one' },
  { start: 0.6, end: 0.85, text: '50', speaker: 'one' },
  { start: 0.85, end: 1.06, text: '%', speaker: 'one' },
  { start: 1.06, end: 1.3, text: 'rule.', speaker: 'one' },
  { start: 3, end: 3.3, text: 'Only', speaker: 'one' },
  { start: 3.3, end: 3.5, text: 'use', speaker: 'one' },
  { start: 3.5, end: 3.72, text: 'the', speaker: 'one' },
  { start: 3.72, end: 4.3, text: '50', speaker: 'one' },
  { start: 4.3, end: 4.5, text: '%', speaker: 'one' },
  { start: 4.5, end: 4.9, text: 'rule.', speaker: 'one' },
];

function parseTime(raw) {
  const [h, m, rest] = raw.split(':');
  return 3600 * Number(h) + 60 * Number(m) + Number(rest);
}

test('editorial caption groups are bounded and correctly attach punctuation', () => {
  const groups = editorialCaptionGroups(words);
  assert.ok(groups.length >= 3);
  assert.ok(groups.every(g => g.length <= 4));
  assert.equal(EDITORIAL_CAPTION_CONTRACT.font_px, 76);
  const ass = buildEditorialCaptionsAss(words, { duration: 9,
    cards: [{ at_s: 0, text: "You don't use the" }, { at_s: 4, text: 'invented topic' }],
    emphasisWords: ['rule.'] });
  assert.match(ass, /Style: Editorial,Inter,76/);
  assert.match(ass, /50\{\\c&H[0-9A-F]+&\}%/);
  assert.doesNotMatch(ass, /invented topic/i);
  assert.match(ass, /YOU DON'T USE THE/);
  assert.doesNotMatch(ass, /Style: TransparentWord/);
});

test('all active word captions stay mutually exclusive at exact centisecond resolution', () => {
  const ass = buildEditorialCaptionsAss(words, { duration: 9 });
  const intervals = ass.split('\n').filter(l => l.startsWith('Dialogue: 0,'))
    .map(l => l.split(',')).map(parts => [parseTime(parts[1]), parseTime(parts[2])]);
  for (let i = 1; i < intervals.length; i++) {
    assert.ok(intervals[i][0] >= intervals[i - 1][1] - 0.011,
      'Caption stack: ' + JSON.stringify(intervals.slice(i - 1, i + 1)));
  }
});

test('validate title cards against actual nearby speech and render ASS through FFmpeg', () => {
  assert.equal(normalizeEditorialCards([{ at_s: 0.1, text: 'invented tax guarantee' }], words, 9).length, 0);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'editorial-ass-'));
  try {
    const file = path.join(dir, 'captions.ass');
    fs.writeFileSync(file, buildEditorialCaptionsAss(words, { duration: 9 }), 'utf8');
    const result = spawnSync('ffmpeg', ['-hide_banner', '-nostdin', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'color=c=blue:size=1080x1920:rate=2:duration=1',
      '-vf', "subtitles='" + file + "'", '-frames:v', '1', '-f', 'null', '-'],
      { encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
