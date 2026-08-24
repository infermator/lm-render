import assert from 'node:assert/strict';
import test from 'node:test';
import { subtitleFilterSuffix } from './ffmpeg_filters.mjs';

test('subtitle filters name the filename option for current and legacy FFmpeg parsers', () => {
  assert.equal(
    subtitleFilterSuffix('/tmp/clipper/captions.srt', 'FontName=DejaVu Sans,Outline=1'),
    ",subtitles=filename='/tmp/clipper/captions.srt':force_style='FontName=DejaVu Sans,Outline=1'",
  );
});

test('subtitle filters escape Windows drive separators and quotes', () => {
  assert.equal(
    subtitleFilterSuffix("C:\\clips\\host's captions.srt", 'Outline=1'),
    ",subtitles=filename='C\\:/clips/host\\'s captions.srt':force_style='Outline=1'",
  );
});
