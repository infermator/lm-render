import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkRenderedVideo } from './content_qc.mjs';

const ffmpeg = args => {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-nostdin', '-loglevel', 'error', ...args],
    { encoding: 'utf8', timeout: 60000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
};

test('content QC blocks a corrupt all-black render but treats a static scene as advisory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipper-content-qc-'));
  const black = path.join(dir, 'black.mp4');
  const blue = path.join(dir, 'blue.mp4');
  try {
    for (const [color, output] of [['black', black], ['blue', blue]]) {
      ffmpeg(['-f', 'lavfi', '-i', 'color=c=' + color + ':s=320x568:r=15:d=2.5',
        '-f', 'lavfi', '-i', 'sine=frequency=550:sample_rate=48000:duration=2.5',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
        '-shortest', '-y', output]);
    }
    const blackReport = checkRenderedVideo(black, { sourceHasAudio: true, expectedDuration: 2.5 });
    assert.equal(blackReport.passed, false);
    assert.ok(blackReport.errors.includes('full_black_video_over_1_5s'));
    const blueReport = checkRenderedVideo(blue, { sourceHasAudio: true, expectedDuration: 2.5 });
    assert.equal(blueReport.passed, true, JSON.stringify(blueReport));
    assert.ok(blueReport.metrics.mean_db !== null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
