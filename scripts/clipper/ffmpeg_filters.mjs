function escapeSubtitlePath(filePath) {
  return String(filePath).replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

function subtitleFilter(filePath, forceStyle) {
  const normalizedPath = String(filePath || '').trim();
  const style = String(forceStyle || '').trim();
  if (!normalizedPath) throw new Error('Subtitle path is required');
  if (!style) throw new Error('Subtitle force style is required');
  return `subtitles=filename='${escapeSubtitlePath(normalizedPath)}':force_style='${style}'`;
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

function captionShadowSource(placement, strength) {
  if (strength === 'readable') {
    if (placement === 'middle') {
      return {
        source: "gradients=s=1080x1040:r=30:speed=0:n=9:c0=black@0.00:c1=black@0.025:c2=black@0.10:c3=black@0.23:c4=black@0.34:c5=black@0.23:c6=black@0.10:c7=black@0.025:c8=black@0.00:x0=0:y0=0:x1=0:y1=1039,format=rgba",
        overlayY: '(H-h)/2',
      };
    }
    if (placement === 'top') {
      return {
        source: "gradients=s=1080x1120:r=30:speed=0:n=7:c0=black@0.58:c1=black@0.50:c2=black@0.40:c3=black@0.27:c4=black@0.13:c5=black@0.04:c6=black@0.00:x0=0:y0=0:x1=0:y1=1119,format=rgba",
        overlayY: '0',
      };
    }
    return {
      source: "gradients=s=1080x1120:r=30:speed=0:n=7:c0=black@0.00:c1=black@0.04:c2=black@0.13:c3=black@0.27:c4=black@0.40:c5=black@0.50:c6=black@0.58:x0=0:y0=0:x1=0:y1=1119,format=rgba",
      overlayY: 'H-h',
    };
  }
  if (placement === 'middle') {
    return {
      source: "gradients=s=1080x880:r=30:speed=0:n=7:c0=black@0.00:c1=black@0.012:c2=black@0.055:c3=black@0.14:c4=black@0.055:c5=black@0.012:c6=black@0.00:x0=0:y0=0:x1=0:y1=879,format=rgba",
      overlayY: '(H-h)/2',
    };
  }
  if (placement === 'top') {
    return {
      source: "gradients=s=1080x720:r=30:speed=0:n=5:c0=black@0.22:c1=black@0.10:c2=black@0.035:c3=black@0.008:c4=black@0.00:x0=0:y0=0:x1=0:y1=719,format=rgba",
      overlayY: '0',
    };
  }
  return {
    source: "gradients=s=1080x720:r=30:speed=0:n=5:c0=black@0.00:c1=black@0.008:c2=black@0.035:c3=black@0.10:c4=black@0.22:x0=0:y0=0:x1=0:y1=719,format=rgba",
    overlayY: 'H-h',
  };
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
  return [
    `${shadow.source}[caption_shadow]`,
    `[${inputLabel}][caption_shadow]overlay=0:${shadow.overlayY}:shortest=1:format=auto[caption_shaded]`,
    `[caption_shaded]${subtitleFilter(filePath, forceStyle)}[${outputLabel}]`,
  ].join(';');
}
