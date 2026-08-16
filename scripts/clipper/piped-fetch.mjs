#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const DEFAULT_PIPED_INSTANCES = [
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.tokhmi.xyz',
  'https://pipedapi.moomoo.me',
  'https://pipedapi.syncpundit.io',
  'https://api-piped.mha.fi',
  'https://piped-api.garudalinux.org',
];

const DEFAULT_INVIDIOUS_INSTANCES = [
  'https://inv.nadeko.net',
  'https://invidious.nerdvpn.de',
  'https://yt.chocolatemoo53.com',
];

function log(message) {
  console.log(`[clipper-proxy] ${message}`);
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

function configuredInstances(envName, defaults) {
  const configured = String(process.env[envName] || '').trim();
  const values = configured
    ? configured.split(',').map(value => value.trim()).filter(Boolean)
    : defaults;
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

function validHttpUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

function streamHeight(stream) {
  const direct = Number(stream?.height || 0);
  if (direct > 0) return direct;
  const text = `${stream?.qualityLabel || ''} ${stream?.quality || ''} ${stream?.resolution || ''}`;
  const match = text.match(/(\d{3,4})p|\b(\d{3,4})x(\d{3,4})\b/i);
  if (!match) return 0;
  if (match[1]) return Number(match[1]);
  return Math.min(Number(match[2] || 0), Number(match[3] || 0));
}

function streamMime(stream) {
  return String(stream?.mimeType || stream?.type || '').toLowerCase();
}

function streamCodec(stream) {
  const explicit = String(stream?.codec || stream?.encoding || '').toLowerCase();
  const type = streamMime(stream);
  const codecMatch = type.match(/codecs?="([^"]+)"/i);
  return explicit || String(codecMatch?.[1] || '').toLowerCase();
}

function scoreVideo(stream) {
  const mime = streamMime(stream);
  const codec = streamCodec(stream);
  const height = streamHeight(stream);
  const bitrate = Number(stream?.bitrate || 0);
  let score = 0;
  if (mime.includes('video/mp4') || String(stream?.format || stream?.container || '').toUpperCase().includes('MP4')) score += 1_000_000;
  if (codec.includes('avc1') || codec.includes('h264')) score += 500_000;
  if (height <= 1080) score += Math.max(0, height) * 1000;
  else score -= (height - 1080) * 1000;
  score += Math.min(100_000, Math.floor(bitrate / 100));
  return score;
}

function scoreAudio(stream) {
  const mime = streamMime(stream);
  const codec = streamCodec(stream);
  const bitrate = Number(stream?.bitrate || 0);
  let score = bitrate;
  if (mime.includes('audio/mp4') || String(stream?.format || stream?.container || '').toUpperCase() === 'M4A') score += 1_000_000;
  if (codec.includes('mp4a') || codec.includes('aac')) score += 500_000;
  return score;
}

function choosePipedStreams(payload) {
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

function chooseInvidiousStreams(payload) {
  const adaptive = (Array.isArray(payload?.adaptiveFormats) ? payload.adaptiveFormats : [])
    .filter(stream => validHttpUrl(stream?.url));
  const videos = adaptive.filter(stream => streamMime(stream).startsWith('video/'));
  const audios = adaptive.filter(stream => streamMime(stream).startsWith('audio/'));

  const separateVideo = videos.sort((a, b) => scoreVideo(b) - scoreVideo(a))[0] || null;
  const audio = audios.sort((a, b) => scoreAudio(b) - scoreAudio(a))[0] || null;
  if (separateVideo && audio) return { video: separateVideo, audio, muxed: false };

  const muxed = (Array.isArray(payload?.formatStreams) ? payload.formatStreams : [])
    .filter(stream => validHttpUrl(stream?.url))
    .sort((a, b) => scoreVideo(b) - scoreVideo(a))[0] || null;
  if (muxed) return { video: muxed, audio: null, muxed: true };

  throw new Error('Invidious response contained no usable proxied media streams');
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
  if (!fs.existsSync(output) || fs.statSync(output).size < 100_000) throw new Error('Proxy ffmpeg produced no usable MP4');
}

function probeDuration(file) {
  const result = spawnSync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file,
  ], { encoding: 'utf8' });
  if (result.error || result.status !== 0) return null;
  const duration = Number(String(result.stdout || '').trim());
  return Number.isFinite(duration) ? duration : null;
}

function verifyOutput(request) {
  const actual = probeDuration(request.output);
  if (actual != null && actual < Math.max(5, request.duration - 2.5)) {
    throw new Error(`output too short (${actual.toFixed(2)}s vs requested ${request.duration.toFixed(2)}s)`);
  }
  return actual;
}

async function tryPiped(request, errors) {
  for (const instance of configuredInstances('PIPED_INSTANCES', DEFAULT_PIPED_INSTANCES)) {
    try {
      log(`Piped: trying ${instance} for ${request.videoId}`);
      const payload = await getJson(`${instance}/streams/${encodeURIComponent(request.videoId)}`);
      if (payload?.livestream) throw new Error('livestream source');
      const selection = choosePipedStreams(payload);
      log(`Piped: resolved ${selection.muxed ? 'muxed' : 'separate A/V'} proxied stream via ${instance}`);
      ffmpegWindow({ selection, ...request });
      const actual = verifyOutput(request);
      log(`Piped: success -> ${request.output}${actual == null ? '' : ` (${actual.toFixed(2)}s)`}`);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`Piped ${instance}: ${message}`);
      log(`Piped instance failed: ${instance} · ${message}`);
      try { if (fs.existsSync(request.output)) fs.rmSync(request.output, { force: true }); } catch {}
    }
  }
  return false;
}

async function tryInvidious(request, errors) {
  for (const instance of configuredInstances('INVIDIOUS_INSTANCES', DEFAULT_INVIDIOUS_INSTANCES)) {
    try {
      log(`Invidious: trying ${instance} for ${request.videoId}`);
      const payload = await getJson(`${instance}/api/v1/videos/${encodeURIComponent(request.videoId)}?local=true`);
      if (payload?.liveNow) throw new Error('livestream source');
      const selection = chooseInvidiousStreams(payload);
      log(`Invidious: resolved ${selection.muxed ? 'muxed' : 'separate A/V'} proxied stream via ${instance}`);
      ffmpegWindow({ selection, ...request });
      const actual = verifyOutput(request);
      log(`Invidious: success -> ${request.output}${actual == null ? '' : ` (${actual.toFixed(2)}s)`}`);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`Invidious ${instance}: ${message}`);
      log(`Invidious instance failed: ${instance} · ${message}`);
      try { if (fs.existsSync(request.output)) fs.rmSync(request.output, { force: true }); } catch {}
    }
  }
  return false;
}

async function main() {
  const request = parseArgs(process.argv.slice(2));
  const errors = [];

  if (await tryPiped(request, errors)) return;
  if (await tryInvidious(request, errors)) return;

  throw new Error(`all free proxy instances failed: ${errors.join(' | ').slice(-5000)}`);
}

main().catch(error => {
  console.error(`[clipper-proxy] failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
