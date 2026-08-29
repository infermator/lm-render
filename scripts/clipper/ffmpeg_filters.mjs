function escapeSubtitlePath(filePath) {
  return String(filePath).replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

function subtitleFilter(filePath, forceStyle) {
  const normalizedPath = String(filePath || '').trim();
  const style = String(forceStyle || '').trim();
  if (!normalizedPath) throw new Error('Subtitle path is required');
  const base = `subtitles=filename='${escapeSubtitlePath(normalizedPath)}'`;
  return style ? `${base}:force_style='${style}'` : base;
}

export function subtitleFilterSuffix(filePath, forceStyle) {
  return `,${subtitleFilter(filePath, forceStyle)}`;
}

export function captionPlacementFromStyle(forceStyle) {
  const match = String(forceStyle || '').match(/(?:^|,)Alignment=(\d{1,2})(?:,|$)/i);
  const alignment = Number(match?.[1] || 2);
  // FFmpeg converts SRT to the legacy SSA alignment grid: 1–3 bottom,
  // 5–7 top, and 9–11 middle. Values 4 and 8 coerce to the next row's
  // left edge in libass, so treat them as that visible row as well.
  if (alignment >= 8 && alignment <= 11) return 'middle';
  if (alignment >= 4 && alignment <= 7) return 'top';
  return 'bottom';
}

// `gradients` accepts at most eight stops: c0..c7, with n/nb_colors capped at
// 8. A ninth stop is not a softer ramp, it is a filter-graph that FFmpeg
// refuses to build ("Value 9.000000 for parameter 'n' out of range [2 - 8]"),
// which fails the whole render. Symmetric profiles therefore carry the peak on
// a two-stop plateau rather than a single centre stop.
const MAX_GRADIENT_STOPS = 8;
// `speed` is a rotation rate and FFmpeg's floor for it is 1e-05, not 0.
// speed=0 builds on FFmpeg 8 and is REJECTED by the FFmpeg 6 on the Ubuntu
// runners that render production ("Value 0.000000 for parameter 'speed' out of
// range [1e-05 - 1]"), which failed both CLIPPER workers. The floor is not
// perfectly static -- it drifts at most 1 luma step out of 255 across 60s,
// measured -- so it is the cheapest value that parses everywhere.
const MIN_GRADIENT_SPEED = 0.00001;

function captionShadowSource(placement, strength) {
  if (strength === 'readable') {
    if (placement === 'middle') {
      return {
        source: "gradients=s=1080x1040:r=30:speed=0.00001:n=8:c0=black@0.00:c1=black@0.035:c2=black@0.14:c3=black@0.32:c4=black@0.32:c5=black@0.14:c6=black@0.035:c7=black@0.00:x0=0:y0=0:x1=0:y1=1039,format=rgba",
        overlayY: '(H-h)/2',
      };
    }
    if (placement === 'top') {
      return {
        source: "gradients=s=1080x1120:r=30:speed=0.00001:n=7:c0=black@0.58:c1=black@0.50:c2=black@0.40:c3=black@0.27:c4=black@0.13:c5=black@0.04:c6=black@0.00:x0=0:y0=0:x1=0:y1=1119,format=rgba",
        overlayY: '0',
      };
    }
    return {
      source: "gradients=s=1080x1120:r=30:speed=0.00001:n=7:c0=black@0.00:c1=black@0.04:c2=black@0.13:c3=black@0.27:c4=black@0.40:c5=black@0.50:c6=black@0.58:x0=0:y0=0:x1=0:y1=1119,format=rgba",
      overlayY: 'H-h',
    };
  }
  if (placement === 'middle') {
    return {
      source: "gradients=s=1080x880:r=30:speed=0.00001:n=7:c0=black@0.00:c1=black@0.012:c2=black@0.055:c3=black@0.14:c4=black@0.055:c5=black@0.012:c6=black@0.00:x0=0:y0=0:x1=0:y1=879,format=rgba",
      overlayY: '(H-h)/2',
    };
  }
  if (placement === 'top') {
    return {
      source: "gradients=s=1080x720:r=30:speed=0.00001:n=5:c0=black@0.22:c1=black@0.10:c2=black@0.035:c3=black@0.008:c4=black@0.00:x0=0:y0=0:x1=0:y1=719,format=rgba",
      overlayY: '0',
    };
  }
  return {
    source: "gradients=s=1080x720:r=30:speed=0.00001:n=5:c0=black@0.00:c1=black@0.008:c2=black@0.035:c3=black@0.10:c4=black@0.22:x0=0:y0=0:x1=0:y1=719,format=rgba",
    overlayY: 'H-h',
  };
}

function assertGradientStops(source) {
  const declared = Number(String(source).match(/(?:^|:)(?:n|nb_colors)=(\d+)/)?.[1] || 0);
  const highestIndex = Math.max(
    -1,
    ...Array.from(String(source).matchAll(/(?:^|:)c(\d+)=/g), match => Number(match[1])),
  );
  if (declared > MAX_GRADIENT_STOPS || highestIndex >= MAX_GRADIENT_STOPS) {
    throw new Error(
      `Caption shadow declares ${Math.max(declared, highestIndex + 1)} gradient stops; FFmpeg accepts at most ${MAX_GRADIENT_STOPS} (c0..c${MAX_GRADIENT_STOPS - 1})`,
    );
  }
  const speed = Number(String(source).match(/(?:^|:)speed=([\d.eE+-]+)/)?.[1] ?? MIN_GRADIENT_SPEED);
  if (!(speed >= MIN_GRADIENT_SPEED)) {
    throw new Error(`Caption shadow sets speed=${speed}; FFmpeg's minimum is ${MIN_GRADIENT_SPEED}`);
  }
}

export function captionCompositeFilter({
  filePath,
  forceStyle,
  inputLabel = 'caption_base',
  outputLabel = 'v',
  placement = 'auto',
  strength = 'subtle',
} = {}) {
  const resolvedPlacement = placement === 'auto' ? captionPlacementFromStyle(forceStyle) : placement;
  if (!['bottom', 'middle', 'top'].includes(resolvedPlacement)) {
    throw new Error(`Unsupported caption placement: ${resolvedPlacement}`);
  }
  if (!['subtle', 'readable'].includes(strength)) {
    throw new Error(`Unsupported caption shadow strength: ${strength}`);
  }
  const shadow = captionShadowSource(resolvedPlacement, strength);
  assertGradientStops(shadow.source);
  return [
    `${shadow.source}[caption_shadow]`,
    `[${inputLabel}][caption_shadow]overlay=0:${shadow.overlayY}:shortest=1:format=auto[caption_shaded]`,
    `[caption_shaded]${subtitleFilter(filePath, forceStyle)}[${outputLabel}]`,
  ].join(';');
}
