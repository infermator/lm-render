// String assertions cannot tell a valid filter-graph from one FFmpeg refuses to
// build: `ffmpeg_filters.test.mjs` passed for a `readable`+`middle` profile that
// declared nine gradient stops, which FFmpeg rejects outright. This suite hands
// every strength x placement combination to the real binary, so an unbuildable
// caption profile fails here instead of inside a claimed render.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { captionCompositeFilter } from './ffmpeg_filters.mjs';

const ALIGNMENTS = { bottom: 2, top: 6, middle: 10 };
const STRENGTHS = ['subtle', 'readable'];

const ffmpegAvailable = spawnSync('ffmpeg', ['-hide_banner', '-version'], { encoding: 'utf8' }).status === 0;
// Some local builds (Homebrew's default) ship without libass, so `subtitles` is
// missing there. The gradient composition is what these profiles change, so keep
// checking it and drop only the burn-in leg when the filter is unavailable.
const subtitlesAvailable = ffmpegAvailable
  && /(^|\s)subtitles(\s|$)/m.test(spawnSync('ffmpeg', ['-hide_banner', '-filters'], { encoding: 'utf8' }).stdout || '');

const captionPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'clipper-smoke-')), 'captions.srt');
fs.writeFileSync(captionPath, '1\n00:00:00,000 --> 00:00:01,000\nsmoke test caption\n\n');

function buildGraph(strength, placement) {
  const style = `FontName=Inter,FontSize=15,Bold=1,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,Outline=1,Shadow=0,Alignment=${ALIGNMENTS[placement]},MarginV=48`;
  const composite = captionCompositeFilter({ filePath: captionPath, forceStyle: style, strength });
  return `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920[caption_base];${
    subtitlesAvailable ? composite : composite.replace(/\[caption_shaded\]subtitles=.*\[v\]$/, '[caption_shaded]null[v]')
  }`;
}

for (const strength of STRENGTHS) {
  for (const placement of Object.keys(ALIGNMENTS)) {
    test(`FFmpeg builds the ${strength} ${placement} caption graph`, { skip: ffmpegAvailable ? false : 'ffmpeg is not installed' }, () => {
      const result = spawnSync('ffmpeg', [
        '-hide_banner', '-nostdin', '-y',
        '-f', 'lavfi', '-i', 'testsrc2=size=1080x1920:rate=30:duration=1',
        '-filter_complex', buildGraph(strength, placement),
        '-map', '[v]', '-frames:v', '1', '-f', 'null', '-',
      ], { encoding: 'utf8' });
      const stderr = String(result.stderr || '');
      assert.equal(
        result.status,
        0,
        `ffmpeg rejected the ${strength}/${placement} graph:\n${stderr.split('\n').slice(-6).join('\n')}`,
      );
      assert.doesNotMatch(stderr, /out of range|Error applying option/i);
    });
  }
}

test('the caption graph actually encodes a frame at the production podcast profile', { skip: ffmpegAvailable ? false : 'ffmpeg is not installed' }, () => {
  const output = path.join(path.dirname(captionPath), 'frame.mp4');
  const result = spawnSync('ffmpeg', [
    '-hide_banner', '-nostdin', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=1080x1920:rate=30:duration=1',
    '-filter_complex', buildGraph('readable', 'bottom'),
    '-map', '[v]', '-frames:v', '3', '-c:v', 'libx264', '-preset', 'ultrafast', output,
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, String(result.stderr || '').split('\n').slice(-6).join('\n'));
  assert.ok(fs.statSync(output).size > 0, 'expected a non-empty encode');
});
