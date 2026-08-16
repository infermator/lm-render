#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const DEFAULT_INSTANCES = [
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.tokhmi.xyz',
  'https://pipedapi.moomoo.me',
  'https://pipedapi.syncpundit.io',
  'https://api-piped.mha.fi',
  'https://piped-api.garudalinux.org',
];

function log(message) {
  console.log(`[clipper-piped] ${message}`);
}

function parseArgs(argv) {
  let outputPattern = '';
  let section = '';
  let sourceUrl = '';

  for (let i = 0; i < argv.length; i += 1) {
    const value = String(argv[i] || '');
    if ((value === '-o' || value === '--output') && i + 1 < argv.length) {
      outputPattern = String(argv[++i] || '');
      continue;
    }
    if (value === '--download-sections' && i + 1 < argv.length) {
      section = String(argv[++i] || '');
      continue;
    }
    if (/^https?:\/\//i.test(value)) sourceUrl = value;
  }

  const sectionMatch = section.match(/^\*?([0-9]+(?:\.[0-9]+)?)-([0-9]+(?:\.[0-9]+)?)$/);
  if (!sectionMatch) throw new Error(`Unsupported or missing --download-sections value: ${section || '(empty)'}`);
  if (!outputPattern) throw new Error('Missing yt-dlp output pattern (-o)');
  if (!sourceUrl) throw new Error('Missing YouTube source URL');

  const parsed = new URL(sourceUrl);
  const host = parsed.hostname.toLowerCase();
  let videoId = parsed.searchParams.get('v') || '';
  if (host === 'youtu.be') videoId = parsed.pathname.split('/').filter(Boolean)[0] || '';
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) throw new Error(`Could not extract YouTube video id from ${sourceUrl}`);

  const start = Number(sectionMatch[1]);
  const end = Number(sectionMatch[2]);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new Error(`Invalid section ${section}`);

  const output = outputPattern.includes('%(ext)s')
    ? outputPattern.replace('%(ext)s', 'mp4')
    : outputPattern.endsWith('.mp4') ? outputPattern : `${outputPattern}.mp4`;

  return { videoId, start, end, duration: end - start, output };
}

function instanceList() {
  const configured = String(process.env.PIPED_INSTANCES || '').trim();
  const values = configured
    ? configured.split(',').map(value => value.trim()).filter(Boolean)
    : DEFAULT_INSTANCES;
  return [...new Set(values.map(value => value.replace(/\/$/, '')))];
}

async function getJson(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': '21Media-CLIPPER/1.0 (+https://reaction-lab-coral.vercel.app)',
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function scoreVideo(stream) {
  const mime = String(stream?.mimeType || '').toLowerCase();
  const codec = String(stream?.codec || '').toLowerCase();
  const height = Number(stream?.height || 0);
  const bitrate = Number(stream?.bitrate || 0);
  let score = 0;
  if (mime.includes('video/mp4') || String(stream?.format || '').toUpperCase().includes('MPEG_4')) score += 1_000_000;
  if (codec.includes('avc1') || codec.includes('h264')) score += 500_000;
  if (height <= 1080) score += Math.max(0, height) * 1000;
  else score -= (height - 1080) * 1000;
  score += Math.min(100_000, Math.floor(bitrate / 100));
  return score;
}

function scoreAudio(stream) {
  const mime = String(stream?.mimeType || '').toLowerCase();
  const codec = String(stream?.codec || '').toLowerCase();
  const bitrate = Number(stream?.bitrate || 0);
  let score = bitrate;
  if (mime.includes('audio/mp4') || String(stream?.format || '').toUpperCase() === 'M4A') score += 1_000_000;
  if (codec.includes('mp4a') || codec.includes('aac')) score += 500_000;
  return score;
}

function validHttpUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

function chooseStreams(payload) {
  const videos = (Array.isArray(payload?.videoStreams) ? payload.videoStreams : [])
    .filter(stream => validHttpUrl(stream?.url));
  const audios = (Array.isArray(payload?.audioStreams) ? payload.audioStreams : [])
    .filter(stream => validHttpUrl(stream?.url));

  const separateVideo = videos
    .filter(stream => stream?.videoOnly === true)
    .sort((a, b) => scoreVideo(b) - scoreVideo(a))[0] || null;
  const audio = audios.sort((a, b) => scoreAudio(b) - scoreAudio(a))[0] || null;
  if (separateVideo && audio) return { video: separateVideo, audio, muxed: false };

  const muxed = videos
    .filter(stream => stream?.videoOnly !== true)
    .sort((a, b) => scoreVideo(b) - scoreVideo(a))[0] || null;
  if (muxed) return { video: muxed, audio: null, muxed: true };

  throw new Error('Piped response contained no usable media streams');
}

function ffmpegWindow({ selection, start, duration, output }) {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const network = [
    '-rw_timeout', '30000000',
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '5',
  ];
  const encode = [
    '-t', duration.toFixed(3),
    '-map', '0:v:0',
    ...(selection.muxed ? ['-map', '0:a?'] : ['-map', '1:a:0']),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
    '-movflags', '+faststart',
    output,
  ];

  const args = ['-hide_banner', '-loglevel', 'warning', '-y'];
  if (selection.muxed) {
    args.push(...network, '-ss', start.toFixed(3), '-i', selection.video.url, ...encode);
  } else {
    args.push(
      ...network, '-ss', start.toFixed(3), '-i', selection.video.url,
      ...network, '-ss', start.toFixed(3), '-i', selection.audio.url,
      ...encode,
    );
  }

  const result = spawnSync('ffmpeg', args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`ffmpeg exited ${result.status}`);
  if (!fs.existsSync(output) || fs.statSync(output).size < 100_000) throw new Error('Piped ffmpeg produced no usable MP4');
}

function probeDuration(file) {
  const result = spawnSync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file,
  ], { encoding: 'utf8' });
  if (result.error || result.status !== 0) return null;
  const duration = Number(String(result.stdout || '').trim());
  return Number.isFinite(duration) ? duration : null;
}

async function main() {
  const request = parseArgs(process.argv.slice(2));
  const errors = [];

  for (const instance of instanceList()) {
    try {
      log(`trying ${instance} for ${request.videoId}`);
      const payload = await getJson(`${instance}/streams/${encodeURIComponent(request.videoId)}`);
      if (payload?.livestream) throw new Error('livestream sources are not supported by CLIPPER fallback');
      const selection = chooseStreams(payload);
      log(`resolved ${selection.muxed ? 'muxed' : 'separate A/V'} proxied stream via ${instance}`);
      ffmpegWindow({ selection, ...request });
      const actual = probeDuration(request.output);
      if (actual != null && actual < Math.max(5, request.duration - 2.5)) {
        throw new Error(`output too short (${actual.toFixed(2)}s vs requested ${request.duration.toFixed(2)}s)`);
      }
      log(`success -> ${request.output}${actual == null ? '' : ` (${actual.toFixed(2)}s)`}`);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${instance}: ${message}`);
      log(`instance failed: ${instance} · ${message}`);
      try { if (fs.existsSync(request.output)) fs.rmSync(request.output, { force: true }); } catch {}
    }
  }

  throw new Error(`all free Piped instances failed: ${errors.join(' | ').slice(-4000)}`);
}

main().catch(error => {
  console.error(`[clipper-piped] failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
