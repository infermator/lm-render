/**
 * Deterministic final guard for automatic Reaction Director layouts.
 *
 * A corner cut-out is wider than one cell of the Director's 3x3 map: the
 * current scaled persona is wider than one 360px grid cell on a 1080px canvas. Consequently a
 * left/right corner also covers a meaningful part of the neighbouring centre
 * cell. Treating `top_center` as unrelated to `top_right` is what let an avatar
 * cover a source title even though the plan called that corner safe.
 */

export const LAYOUT_SAFETY_POLICY_VERSION = 'reaction-layout-safety-v1';

const CORNERS = ['bottom_right', 'bottom_left', 'top_right', 'top_left'];
const BANDS = new Set(['top_band', 'bottom_band']);

export const CORNER_FOOTPRINTS = Object.freeze({
  top_left: Object.freeze(['top_left', 'top_center']),
  top_right: Object.freeze(['top_center', 'top_right']),
  bottom_left: Object.freeze(['bottom_left', 'bottom_center']),
  bottom_right: Object.freeze(['bottom_center', 'bottom_right']),
});

function uniqueStrings(value) {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map(item => String(item)).filter(Boolean)));
}

function blockedRegions(corner, protectedRegions) {
  const footprint = CORNER_FOOTPRINTS[corner] || [];
  return footprint.filter(region => protectedRegions.has(region));
}

function correctedReason(from, to, blocked, excludedBySafeCorners) {
  const why = blocked.length
    ? `its cut-out spans ${CORNER_FOOTPRINTS[from].join(' + ')} and would cover protected ${blocked.join(', ')}`
    : 'the spatial pass did not include it in safe_corners';
  const suffix = excludedBySafeCorners && blocked.length
    ? ' and the spatial pass also excluded it from safe_corners'
    : '';
  return `Safety correction (${LAYOUT_SAFETY_POLICY_VERSION}): ${from} is unsafe because ${why}${suffix}; using ${to} so the avatar does not cover source text or important content.`;
}

/**
 * Correct an automatic corner placement when the saved plan contradicts the
 * actual cut-out footprint. The caller deliberately skips this for explicit
 * operator overrides.
 */
export function protectSourceLayout(layout, { backgroundAvailable = false } = {}) {
  const base = layout && typeof layout === 'object' ? layout : {};
  const from = String(base.avatar || 'bottom_right');
  const protectedRegions = new Set([
    ...uniqueStrings(base.text_regions),
    ...uniqueStrings(base.important_regions),
  ]);
  const safeCornersProvided = Array.isArray(base.safe_corners);
  const safeCorners = uniqueStrings(base.safe_corners).filter(corner => CORNERS.includes(corner));

  const unchanged = {
    layout: base,
    changed: false,
    policy_version: LAYOUT_SAFETY_POLICY_VERSION,
    from,
    to: from,
    blocked_regions: [],
    safe_corners_considered: safeCornersProvided ? safeCorners : null,
  };

  if (BANDS.has(from) || !CORNERS.includes(from)) return unchanged;

  const blocked = blockedRegions(from, protectedRegions);
  const excludedBySafeCorners = safeCornersProvided && !safeCorners.includes(from);
  if (!blocked.length && !excludedBySafeCorners) return unchanged;

  // `safe_corners` is ranked best-to-worst. When it is absent (old plans),
  // evaluate every corner against the protected-region map. An explicit empty
  // list means the Director found no stable corner, so go straight to a band.
  const candidates = (safeCornersProvided ? safeCorners : CORNERS)
    .filter(corner => corner !== from)
    .filter(corner => backgroundAvailable || !corner.startsWith('top_'))
    .filter(corner => blockedRegions(corner, protectedRegions).length === 0);

  const to = candidates[0]
    || (from.startsWith('top_') && backgroundAvailable ? 'top_band' : 'bottom_band');
  const isTop = to.startsWith('top_');
  const isBand = BANDS.has(to);
  const reason = correctedReason(from, to, blocked, excludedBySafeCorners);
  const priorReason = typeof base.reason === 'string' && base.reason.trim() ? base.reason.trim() : '';

  return {
    layout: {
      ...base,
      avatar: to,
      source_shift: isBand ? (isTop ? 'down' : 'up') : (isTop ? 'down' : 'none'),
      needs_background: isTop,
      reason: priorReason ? `${priorReason} ${reason}` : reason,
    },
    changed: true,
    policy_version: LAYOUT_SAFETY_POLICY_VERSION,
    from,
    to,
    blocked_regions: blocked,
    safe_corners_considered: safeCornersProvided ? safeCorners : null,
    reason,
  };
}

// The 3x3 contract above protects the source's CONTENT regions, but a source is
// routinely a re-upload that carries its own baked-in letterbox. The Director
// calls such a corner clear because it is clear — what neither it nor the grid
// can see is that the empty band is 420px tall while the avatar frame is 434,
// which is exactly how a persona ends up sitting 14px inside the video.
export const CONTENT_BAND_MIN_RATIO = 0.6;

/**
 * Shrink a corner cut-out so it stays inside the source's empty band.
 *
 * Scaling, not cropping: the persona is bottom-anchored in his own frame, so
 * trimming the overrun would cut his feet off — which is the very artefact this
 * exists to remove. A band far shorter than the frame is left alone instead of
 * shrinking him into illegibility; that case is a layout problem, not a fit one.
 */
export function fitAvatarToContentBand({
  placement,
  cutWidth,
  avatarHeight,
  canvasHeight,
  contentBand,
  minBandRatio = CONTENT_BAND_MIN_RATIO,
} = {}) {
  const unchanged = { width: cutWidth, height: avatarHeight, clamped: false, band: null };
  const top = Number(contentBand?.top);
  const bottom = Number(contentBand?.bottom);
  if (!Number.isFinite(top) || !Number.isFinite(bottom)) return unchanged;

  const band = String(placement).startsWith('top_') ? top : canvasHeight - 1 - bottom;
  // No letterbox at that edge, or the frame already fits inside it.
  if (!Number.isFinite(band) || band <= 0 || band >= avatarHeight) return { ...unchanged, band: Math.max(0, band) };
  if (band < avatarHeight * minBandRatio) {
    return { ...unchanged, band, skipped: 'band_shorter_than_usable_avatar' };
  }

  const height = Math.max(2, Math.floor(band / 2) * 2);
  const width = Math.max(2, Math.round((cutWidth * height) / avatarHeight / 2) * 2);
  return { width, height, clamped: true, band };
}
