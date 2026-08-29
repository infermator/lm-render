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

test('embedded ASS styles can render without an SRT force-style override', () => {
  assert.equal(
    subtitleFilterSuffix('/tmp/clipper/captions.ass', ''),
    ",subtitles=filename='/tmp/clipper/captions.ass'",
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

test('readable bottom captions receive a wider, stronger fade behind the text lane', () => {
  const filter = captionCompositeFilter({
    filePath: '/tmp/captions.srt',
    forceStyle: 'Alignment=2,MarginV=48',
    strength: 'readable',
  });
  assert.match(filter, /s=1080x1120/);
  assert.match(filter, /n=7:c0=black@0\.00:c1=black@0\.04:c2=black@0\.13:c3=black@0\.27:c4=black@0\.40:c5=black@0\.50:c6=black@0\.58/);
  assert.match(filter, /overlay=0:H-h:shortest=1/);
});

test('readable middle captions keep the centered vignette inside FFmpeg\'s eight-stop ceiling', () => {
  const filter = captionCompositeFilter({
    filePath: '/tmp/captions.srt',
    forceStyle: 'Alignment=10,MarginV=48',
    strength: 'readable',
  });
  assert.match(filter, /s=1080x1040/);
  assert.match(filter, /n=8:c0=black@0\.00:c1=black@0\.035:c2=black@0\.14:c3=black@0\.32:c4=black@0\.32:c5=black@0\.14:c6=black@0\.035:c7=black@0\.00/);
  assert.match(filter, /overlay=0:\(H-h\)\/2:shortest=1/);
});

test('no caption profile declares more gradient stops than FFmpeg accepts', () => {
  for (const strength of ['subtle', 'readable']) {
    for (const alignment of [2, 6, 10]) {
      const filter = captionCompositeFilter({
        filePath: '/tmp/captions.srt',
        forceStyle: `Alignment=${alignment},MarginV=48`,
        strength,
      });
      const declared = Number(filter.match(/(?::|=)n=(\d+)/)?.[1] || 0);
      const stops = Array.from(filter.matchAll(/:c(\d+)=black@/g), match => Number(match[1]));
      assert.ok(declared >= 2 && declared <= 8, `${strength}/${alignment} declares n=${declared}`);
      assert.equal(Math.max(...stops), declared - 1, `${strength}/${alignment} stop indexes must match n`);
      assert.ok(Math.max(...stops) <= 7, `${strength}/${alignment} uses c${Math.max(...stops)}`);
    }
  }
});

test('caption shadows reject unknown strength profiles', () => {
  assert.throws(
    () => captionCompositeFilter({
      filePath: '/tmp/captions.srt',
      forceStyle: 'Alignment=2',
      strength: 'opaque',
    }),
    /Unsupported caption shadow strength/,
  );
});
