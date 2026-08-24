function escapeSubtitlePath(filePath) {
  return String(filePath).replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

export function subtitleFilterSuffix(filePath, forceStyle) {
  const normalizedPath = String(filePath || '').trim();
  const style = String(forceStyle || '').trim();
  if (!normalizedPath) throw new Error('Subtitle path is required');
  if (!style) throw new Error('Subtitle force style is required');
  return `,subtitles=filename='${escapeSubtitlePath(normalizedPath)}':force_style='${style}'`;
}
