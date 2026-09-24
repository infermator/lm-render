import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { splitTwoSpeakerFilter } from './podcast_media.mjs';

test('two-speaker split requires two spatially separated heads', () => {
  assert.equal(splitTwoSpeakerFilter({ width: 1920, height: 1080, leftCenter: .5, rightCenter: .56 }), null);
  assert.equal(splitTwoSpeakerFilter({ width: 640, height: 360, leftCenter: .05, rightCenter: .8 }), null);
  const filter = splitTwoSpeakerFilter({ width: 1920, height: 1080,
    leftCenter: .24, rightCenter: .76, outputLabel: 'portrait' });
  assert.match(filter, /vstack=inputs=2\[portrait\]/);
  const result = spawnSync('ffmpeg', ['-hide_banner', '-nostdin', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=2:duration=1',
    '-filter_complex', filter, '-map', '[portrait]', '-frames:v', '1', '-f', 'null', '-'],
    { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});