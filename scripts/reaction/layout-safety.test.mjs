import assert from 'node:assert/strict';
import test from 'node:test';
import {
  fitAvatarToContentBand,
  LAYOUT_SAFETY_POLICY_VERSION,
  protectSourceLayout,
} from './layout-safety.mjs';

function layout(extra = {}) {
  return {
    avatar: 'top_right',
    captions: 'none',
    source_shift: 'none',
    needs_background: true,
    reason: 'Director choice.',
    ...extra,
  };
}

test('top-center source text blocks the real footprint of both top corners', () => {
  const result = protectSourceLayout(layout({
    text_regions: ['top_center'],
    important_regions: [
      'middle_left', 'middle_center', 'middle_right',
      'bottom_left', 'bottom_center', 'bottom_right',
    ],
    safe_corners: ['top_right', 'top_left'],
  }), { backgroundAvailable: true });

  assert.equal(result.changed, true);
  assert.equal(result.from, 'top_right');
  assert.equal(result.to, 'top_band');
  assert.deepEqual(result.blocked_regions, ['top_center']);
  assert.equal(result.layout.source_shift, 'down');
  assert.match(result.layout.reason, new RegExp(LAYOUT_SAFETY_POLICY_VERSION));
});

test('a ranked truly safe corner is preferred over a band', () => {
  const result = protectSourceLayout(layout({
    text_regions: ['top_center'],
    important_regions: ['bottom_right'],
    safe_corners: ['bottom_left', 'top_right'],
  }), { backgroundAvailable: true });

  assert.equal(result.to, 'bottom_left');
  assert.equal(result.layout.source_shift, 'none');
  assert.equal(result.layout.needs_background, false);
});

test('text on the opposite side does not move a safe corner', () => {
  const original = layout({
    text_regions: ['top_left'],
    safe_corners: ['top_right'],
  });
  const result = protectSourceLayout(original, { backgroundAvailable: true });

  assert.equal(result.changed, false);
  assert.equal(result.layout, original);
});

test('an explicit empty safe-corner list forces a non-overlapping band', () => {
  const result = protectSourceLayout(layout({
    text_regions: [],
    important_regions: [],
    safe_corners: [],
  }), { backgroundAvailable: true });

  assert.equal(result.changed, true);
  assert.equal(result.to, 'top_band');
});

test('without a background, an unsafe top corner falls back to the bottom band', () => {
  const result = protectSourceLayout(layout({
    text_regions: ['top_center'],
    safe_corners: ['top_right', 'top_left'],
  }), { backgroundAvailable: false });

  assert.equal(result.to, 'bottom_band');
  assert.equal(result.layout.source_shift, 'up');
  assert.equal(result.layout.needs_background, false);
});

test('a band is already non-overlapping and remains unchanged', () => {
  const original = layout({ avatar: 'bottom_band', text_regions: ['bottom_center'], safe_corners: [] });
  const result = protectSourceLayout(original, { backgroundAvailable: true });

  assert.equal(result.changed, false);
  assert.equal(result.layout, original);
});

test('a corner cut-out is scaled to fit the source\'s own letterbox band', () => {
  // The measured regression: a 434px avatar frame over a 420px band put the
  // persona 14px inside the picture.
  const fit = fitAvatarToContentBand({
    placement: 'top_right',
    cutWidth: 434,
    avatarHeight: 434,
    canvasHeight: 1920,
    contentBand: { top: 420, bottom: 1499 },
  });
  assert.equal(fit.clamped, true);
  assert.equal(fit.band, 420);
  assert.equal(fit.height, 420);
  assert.ok(fit.height <= 420, 'must not reach into the painted rows');
  assert.equal(fit.width % 2, 0);
  assert.equal(fit.height % 2, 0);
});

test('a bottom corner is measured against the bottom band, not the top one', () => {
  const fit = fitAvatarToContentBand({
    placement: 'bottom_right',
    cutWidth: 434,
    avatarHeight: 434,
    canvasHeight: 1920,
    contentBand: { top: 0, bottom: 1499 },
  });
  assert.equal(fit.band, 420);
  assert.equal(fit.clamped, true);
});

test('a source that paints the whole canvas leaves the avatar frame alone', () => {
  const fit = fitAvatarToContentBand({
    placement: 'top_right',
    cutWidth: 434,
    avatarHeight: 434,
    canvasHeight: 1920,
    contentBand: { top: 0, bottom: 1919 },
  });
  assert.equal(fit.clamped, false);
  assert.equal(fit.height, 434);
});

test('a band taller than the avatar frame changes nothing', () => {
  const fit = fitAvatarToContentBand({
    placement: 'top_right',
    cutWidth: 434,
    avatarHeight: 434,
    canvasHeight: 1920,
    contentBand: { top: 600, bottom: 1400 },
  });
  assert.equal(fit.clamped, false);
  assert.equal(fit.height, 434);
});

test('a band far shorter than the frame is reported rather than shrinking him into nothing', () => {
  const fit = fitAvatarToContentBand({
    placement: 'top_right',
    cutWidth: 434,
    avatarHeight: 434,
    canvasHeight: 1920,
    contentBand: { top: 80, bottom: 1900 },
  });
  assert.equal(fit.clamped, false);
  assert.equal(fit.skipped, 'band_shorter_than_usable_avatar');
});

test('a missing measurement is not treated as a zero-height band', () => {
  const fit = fitAvatarToContentBand({
    placement: 'top_right', cutWidth: 434, avatarHeight: 434, canvasHeight: 1920, contentBand: null,
  });
  assert.equal(fit.clamped, false);
  assert.equal(fit.height, 434);
});
