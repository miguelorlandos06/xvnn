// services/hls.js
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import pLimit from 'p-limit';
import { uploadFile, publicUrl } from './s3.js';
import { CONFIG } from '../config.js';

ffmpeg.setFfmpegPath(ffmpegStatic);

const QUALITY_PROFILES = CONFIG.hls.qualities;
const HLS_CONFIG = CONFIG.hls;

// ============ COLA DE TRABAJOS ============
let activeJobs = 0;
const jobQueue = [];

async function acquireSlot() {
  if (activeJobs < HLS_CONFIG.maxConcurrentJobs) {
    activeJobs++;
    return;
  }
  await new Promise(resolve => jobQueue.push(resolve));
  activeJobs++;
}

function releaseSlot() {
  activeJobs--;
  const next = jobQueue.shift();
  if (next) next();
}

// ============ FUNCIÓN PRINCIPAL ============
/**
 * @param {string|Buffer} input - Ruta del archivo O buffer del video
 * @param {string} videoId
 * @param {Function} onProgress
 */
export async function transcodeToHLS(input, videoId, onProgress = () => {}) {
  await acquireSlot();

  const tmpId = crypto.randomBytes(8).toString('hex');
  const tmpDir = path.join(os.tmpdir(), `xvnn-hls-${videoId}-${tmpId}`);
  const inputPath = path.join(tmpDir, 'input.mp4');
  const hlsDir = path.join(tmpDir, 'hls');

  fs.mkdirSync(hlsDir, { recursive: true });

  let ownInputFile = false;

  try {
    // Si recibimos Buffer, escribirlo a disco
    if (Buffer.isBuffer(input)) {
      fs.writeFileSync(inputPath, input);
      ownInputFile = true;
    } else {
      // Es una ruta; copiarla al tmp dir para procesar
      fs.copyFileSync(input, inputPath);
      ownInputFile = true;
    }

    // ============ 1. TRANSCODIFICAR ============
    onProgress(0, 'transcoding');
    const duration = await runFFmpeg(inputPath, hlsDir, (pct) =>
      onProgress(pct, 'transcoding')
    );

    // ============ 2. SUBIR A S3 ============
    onProgress(0, 'uploading');
    const baseKey = `videos/${videoId}/hls`;
    const filesToUpload = collectFiles(hlsDir);
    const limit = pLimit(HLS_CONFIG.concurrencyUploads);

    let uploadedCount = 0;
    const uploadedKeys = [];

    const tasks = filesToUpload.map(file => limit(async () => {
      const relative = path.relative(hlsDir, file).replace(/\\/g, '/');
      const key = `${baseKey}/${relative}`;
      const contentType = getContentType(file);

      await uploadFile(key, fs.readFileSync(file), contentType);
      uploadedKeys.push(key);

      uploadedCount++;
      onProgress(Math.round((uploadedCount / filesToUpload.length) * 100), 'uploading');
    }));

    await Promise.all(tasks);

    const masterKey = `${baseKey}/master.m3u8`;
    const variants = QUALITY_PROFILES.map(p => ({
      name: p.name,
      resolution: p.resolution,
      bandwidth: p.bandwidth,
      playlistKey: `${baseKey}/${p.name}/index.m3u8`
    }));

    onProgress(100, 'done');

    return {
      masterKey,
      masterUrl: publicUrl(masterKey),
      variants,
      totalFiles: uploadedKeys.length,
      duration: Math.round(duration)
    };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    releaseSlot();
  }
}

// ============ FFMPEG ============
function runFFmpeg(inputPath, hlsDir, onProgress) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(inputPath, (err, metadata) => {
      if (err) return reject(err);

      const totalDuration = metadata.format.duration || 0;
      const outputOptions = buildFFmpegOptions(hlsDir);

      ffmpeg(inputPath)
        .outputOptions(outputOptions)
        .output(path.join(hlsDir, 'master.m3u8'))
        .on('progress', (p) => {
          const secs = parseTime(p.timemark);
          const pct = totalDuration > 0
            ? Math.min(99, Math.round((secs / totalDuration) * 100))
            : 0;
          onProgress(pct);
        })
        .on('end', () => resolve(totalDuration))
        .on('error', reject)
        .run();
    });
  });
}

function buildFFmpegOptions(hlsDir) {
  const opts = [];

  opts.push('-preset', 'veryfast');
  opts.push('-movflags', '+faststart');

  // GOP alineado con segmentos de 1s
  opts.push('-g', String(HLS_CONFIG.gopFrames));
  opts.push('-keyint_min', String(HLS_CONFIG.gopFrames));
  opts.push('-sc_threshold', '0');

  // HLS
  opts.push('-hls_time', String(HLS_CONFIG.segmentDuration));
  opts.push('-hls_playlist_type', 'vod');
  opts.push('-hls_segment_filename', path.join(hlsDir, '%v', 'seg_%05d.ts'));
  opts.push('-hls_flags', 'independent_segments');
  opts.push('-master_pl_name', 'master.m3u8');

  // Mapeos de streams
  const streamMap = [];
  QUALITY_PROFILES.forEach((_, i) => {
    opts.push('-map', '0:v:0');
    opts.push('-map', '0:a:0?');
    streamMap.push(`v:${i},a:${i}`);
  });
  opts.push('-var_stream_map', streamMap.join(' '));

  // Config por calidad
  QUALITY_PROFILES.forEach((p, i) => {
    opts.push(`-c:v:${i}`, 'libx264');
    opts.push(`-b:v:${i}`, p.videoBitrate);
    opts.push(`-maxrate:v:${i}`, p.maxrate);
    opts.push(`-bufsize:v:${i}`, p.bufsize);
    opts.push(`-s:v:${i}`, p.resolution);
    opts.push(`-profile:v:${i}`, 'main');
    opts.push(`-level:v:${i}`, '3.1');
    opts.push(`-pix_fmt:v:${i}`, 'yuv420p');

    opts.push(`-c:a:${i}`, 'aac');
    opts.push(`-b:a:${i}`, p.audioBitrate);
    opts.push(`-ac:a:${i}`, '2');
    opts.push(`-ar:a:${i}`, '44100');
  });

  return opts;
}

function collectFiles(dir, files = []) {
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (fs.statSync(full).isDirectory()) collectFiles(full, files);
    else files.push(full);
  }
  return files;
}

function getContentType(file) {
  if (file.endsWith('.m3u8')) return 'application/vnd.apple.mpegurl';
  if (file.endsWith('.ts')) return 'video/mp2t';
  if (file.endsWith('.m4s')) return 'video/iso.segment';
  if (file.endsWith('.mp4')) return 'video/mp4';
  return 'application/octet-stream';
}

function parseTime(timemark) {
  if (!timemark) return 0;
  const parts = timemark.split(':');
  if (parts.length < 3) return 0;
  return (parseInt(parts[0], 10) || 0) * 3600 +
         (parseInt(parts[1], 10) || 0) * 60 +
         (parseFloat(parts[2]) || 0);
}