import assert from 'node:assert/strict';
import test from 'node:test';
import {
  captionCompositeFilter,
  captionPlacementFromStyle,
  subtitleFilterSuffix,
} from './ffmpeg_filters.mjs';

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

test('caption placement follows ASS alignment without changing typography', () => {
  assert.equal(captionPlacementFromStyle('Alignment=2,MarginV=48'), 'bottom');
  assert.equal(captionPlacementFromStyle('Alignment=6,MarginV=48'), 'top');
  assert.equal(captionPlacementFromStyle('Alignment=10,MarginV=48'), 'middle');
});

test('bottom captions receive a subtle shadow that fades upward', () => {
  const filter = captionCompositeFilter({
    filePath: '/tmp/captions.srt',
    forceStyle: 'Alignment=2,MarginV=48',
  });
  assert.match(filter, /n=5:c0=black@0\.00:c1=black@0\.008:c2=black@0\.035:c3=black@0\.10:c4=black@0\.22/);
  assert.match(filter, /overlay=0:H-h:shortest=1/);
  assert.match(filter, /\[caption_shaded\]subtitles=filename=/);
});

test('middle captions receive a smooth centered reverse vignette', () => {
  const filter = captionCompositeFilter({
    filePath: '/tmp/captions.srt',
    forceStyle: 'Alignment=10,MarginV=48',
  });
  assert.match(filter, /n=7:c0=black@0\.00:c1=black@0\.012:c2=black@0\.055:c3=black@0\.14:c4=black@0\.055:c5=black@0\.012:c6=black@0\.00/);
  assert.match(filter, /overlay=0:\(H-h\)\/2:shortest=1/);
});
