// services/hls.js
import ffmpeg from 'fluent-ffmpeg';
import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import pLimit from 'p-limit';
import { uploadFile, publicUrl } from './s3.js';
import { CONFIG } from '../config.js';

// ============================================================
//  DETECCIÓN DE FFMPEG Y FFPROBE EN EL SISTEMA
// ============================================================
function findBinary(name) {
  try {
    const found = execSync(`which ${name}`, { encoding: 'utf-8' }).trim();
    if (found && fs.existsSync(found)) {
      console.log(`✅ ${name} encontrado en: ${found}`);
      return found;
    }
  } catch (e) {}

  const candidates = [
    `/usr/bin/${name}`,
    `/usr/local/bin/${name}`,
    `/bin/${name}`,
    `/opt/homebrew/bin/${name}`,
    `/data/data/com.termux/files/usr/bin/${name}`
  ];

  for (const c of candidates) {
    if (fs.existsSync(c)) {
      console.log(`✅ ${name} encontrado en: ${c}`);
      return c;
    }
  }

  console.error(`❌ ${name} NO ENCONTRADO en el sistema`);
  return name;
}

const FFMPEG_PATH = findBinary('ffmpeg');
const FFPROBE_PATH = findBinary('ffprobe');

ffmpeg.setFfmpegPath(FFMPEG_PATH);
ffmpeg.setFfprobePath(FFPROBE_PATH);

console.log(`🎬 FFmpeg:  ${FFMPEG_PATH}`);
console.log(`🎬 FFprobe: ${FFPROBE_PATH}`);

const QUALITY_PROFILES = CONFIG.hls.qualities;
const HLS_CONFIG = CONFIG.hls;

// ============================================================
//  COLA DE TRABAJOS
// ============================================================
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

// ============================================================
//  TRANSCODIFICACIÓN PRINCIPAL
// ============================================================
export async function transcodeToHLS(input, videoId, onProgress = () => {}) {
  await acquireSlot();

  const tmpId = crypto.randomBytes(8).toString('hex');
  const tmpDir = path.join(os.tmpdir(), `xvnn-hls-${videoId}-${tmpId}`);
  const inputPath = path.join(tmpDir, 'input.mp4');
  const hlsDir = path.join(tmpDir, 'hls');

  fs.mkdirSync(hlsDir, { recursive: true });

  try {
    if (Buffer.isBuffer(input)) {
      fs.writeFileSync(inputPath, input);
    } else {
      fs.copyFileSync(input, inputPath);
    }

    logDiskSpace(tmpDir);

    onProgress(0, 'transcoding');
    const duration = await runFFmpeg(inputPath, hlsDir, (pct) =>
      onProgress(pct, 'transcoding')
    );

    onProgress(0, 'uploading');
    const baseKey = `videos/${videoId}/hls`;
    const filesToUpload = collectFiles(hlsDir);
    const limit = pLimit(HLS_CONFIG.concurrencyUploads);

    console.log(`📦 Subiendo ${filesToUpload.length} archivos HLS a S3...`);

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
    try {
      if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    } catch (err) {
      console.error('⚠️  Error limpiando tmp:', err.message);
    }
    releaseSlot();
  }
}

// ============================================================
//  FFMPEG: EJECUCIÓN CON FILTER_COMPLEX
// ============================================================
function runFFmpeg(inputPath, hlsDir, onProgress) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(inputPath, (err, metadata) => {
      if (err) {
        console.error('❌ ffprobe falló:', err.message);
        return reject(new Error(`ffprobe: ${err.message}`));
      }

      // ============ LOG METADATA ============
      console.log('');
      console.log('📹 ─── METADATA DEL VIDEO ───');
      console.log('   Formato:', metadata.format.format_name);
      console.log('   Duración:', metadata.format.duration, 's');
      console.log('   Tamaño:', (Number(metadata.format.size) / 1024 / 1024).toFixed(2), 'MB');
      console.log('   Bitrate:', metadata.format.bit_rate);

      // Detectar FPS y calcular GOP
      const videoStream = metadata.streams.find(s => s.codec_type === 'video');
      let fps = 30;
      if (videoStream && videoStream.r_frame_rate) {
        const [num, den] = videoStream.r_frame_rate.split('/').map(Number);
        fps = Math.round(num / den);
      }

      // GOP = FPS × duración del segmento
      const gop = fps * HLS_CONFIG.segmentDuration;

      console.log('   FPS detectado:', fps);
      console.log('   GOP calculado:', gop);
      console.log('   Streams:');
      metadata.streams.forEach((s, i) => {
        if (s.codec_type === 'video') {
          console.log(`     [${i}] video: ${s.codec_name} ${s.width}x${s.height} pix_fmt=${s.pix_fmt}`);
        } else if (s.codec_type === 'audio') {
          console.log(`     [${i}] audio: ${s.codec_name} ${s.channels}ch`);
        }
      });
      console.log('   ───────────────────────');
      console.log('');

      const totalDuration = parseFloat(metadata.format.duration) || 0;
      const outputOptions = buildFFmpegOptions(hlsDir, gop);

      let stderrOutput = '';

      ffmpeg(inputPath)
        .outputOptions(outputOptions)
        .output(path.join(hlsDir, 'master.m3u8'))
        .on('start', (cmdLine) => {
          console.log('🎬 ─── COMANDO FFMPEG ───');
          console.log(cmdLine);
          console.log('   ────────────────────');
          console.log('');
        })
        .on('stderr', (line) => {
          stderrOutput += line + '\n';
        })
        .on('progress', (p) => {
          const secs = parseTime(p.timemark);
          const pct = totalDuration > 0
            ? Math.min(99, Math.round((secs / totalDuration) * 100))
            : 0;
          onProgress(pct);
        })
        .on('end', () => {
          console.log('✅ FFmpeg completó la transcodificación');
          resolve(totalDuration);
        })
        .on('error', (err) => {
          console.error('');
          console.error('❌ ❌ ❌  FFMPEG ERROR  ❌ ❌ ❌');
          console.error('   Mensaje:', err.message);

          console.error('   ─── STDERR COMPLETO ───');
          const lines = stderrOutput.split('\n');
          lines.slice(-60).forEach(l => console.error('   >', l));
          console.error('   ─── FIN STDERR ───');

          detectErrorCause(stderrOutput);
          reject(new Error(`FFmpeg: ${err.message}`));
        })
        .run();
    });
  });
}

// ============================================================
//  CONSTRUIR OPCIONES CON -filter_complex
// ============================================================
function buildFFmpegOptions(hlsDir, gop) {
  const opts = [];
  const n = QUALITY_PROFILES.length;

  // ============ FILTER COMPLEX: split + scale ============
  // [0:v]split=N[v1][v2][v3][v4];
  // [v1]scale=-2:240[v1out];
  // [v2]scale=-2:360[v2out]; ...
  const splitLabels = QUALITY_PROFILES.map((_, i) => `[v${i + 1}]`).join('');
  const scaleChains = QUALITY_PROFILES.map((q, i) => {
    const height = q.resolution.split('x')[1];
    return `[v${i + 1}]scale=-2:${height}[v${i + 1}out]`;
  }).join('; ');

  const filterComplex = `[0:v]split=${n}${splitLabels}; ${scaleChains}`;

  opts.push('-filter_complex', filterComplex);

  // ============ MAPEAR CADA CALIDAD ============
  for (let i = 0; i < n; i++) {
    opts.push('-map', `[v${i + 1}out]`);
  }
  // Mapear audio a cada calidad
  for (let i = 0; i < n; i++) {
    opts.push('-map', '0:a:0?');
  }

  // ============ CONFIG POR CALIDAD ============
  QUALITY_PROFILES.forEach((q, i) => {
    opts.push(`-c:v:${i}`, 'libx264');
    opts.push(`-b:v:${i}`, q.videoBitrate);
    opts.push(`-maxrate:v:${i}`, q.maxrate);
    opts.push(`-bufsize:v:${i}`, q.bufsize);
    opts.push(`-profile:v:${i}`, 'main');
    opts.push(`-level:v:${i}`, '3.1');
    opts.push(`-pix_fmt:v:${i}`, 'yuv420p');

    opts.push(`-c:a:${i}`, 'aac');
    opts.push(`-b:a:${i}`, q.audioBitrate);
    opts.push(`-ac:a:${i}`, '2');
    opts.push(`-ar:a:${i}`, '44100');
  });

  // ============ GOP ALINEADO CON SEGMENTOS ============
  opts.push('-preset', 'veryfast');
  opts.push('-pix_fmt', 'yuv420p');
  opts.push('-g', String(gop));
  opts.push('-keyint_min', String(gop));
  opts.push('-sc_threshold', '0');

  // ============ VAR STREAM MAP ============
  const streamMap = QUALITY_PROFILES.map((q, i) => `v:${i},a:${i}`).join(' ');
  opts.push('-var_stream_map', streamMap);

  // ============ HLS ============
  opts.push('-hls_time', String(HLS_CONFIG.segmentDuration));
  opts.push('-hls_playlist_type', 'vod');
  opts.push('-hls_segment_filename', path.join(hlsDir, '%v', 'seg_%05d.ts'));
  opts.push('-hls_flags', 'independent_segments');
  opts.push('-master_pl_name', 'master.m3u8');
  opts.push('-f', 'hls');

  return opts;
}

// ============================================================
//  DETECCIÓN AUTOMÁTICA DE CAUSA
// ============================================================
function detectErrorCause(stderr) {
  const lower = stderr.toLowerCase();
  const causes = [
    { match: /no space left on device/, msg: '💾 DISCO LLENO: reduce maxLinkDownloadMB.' },
    { match: /cannot allocate memory|out of memory/, msg: '🧠 SIN MEMORIA RAM: reduce calidades.' },
    { match: /invalid color space/, msg: '🎨 INVALID COLOR SPACE: el -pix_fmt yuv420p debería arreglarlo.' },
    { match: /unknown decoder|decoder.*not found|no decoder/, msg: '🎞 CÓDEC NO SOPORTADO: instala ffmpeg completo.' },
    { match: /invalid data found|moov atom not found/, msg: '📁 ARCHIVO CORRUPTO o INCOMPLETO.' },
    { match: /permission denied/, msg: '🔒 PERMISO DENEGADO en /tmp.' },
    { match: /filter_complex/, msg: '🎬 ERROR EN FILTER_COMPLEX: revisa los mapas de streams.' },
    { match: /conversion failed/, msg: '⚠️  CONVERSION FAILED: revisa el stderr.' },
    { match: /eacces|enoent/, msg: '🚫 NO SE ENCUENTRA FFMPEG: revisa el Dockerfile.' }
  ];

  for (const c of causes) {
    if (c.match.test(lower)) {
      console.error('');
      console.error('🎯 CAUSA PROBABLE:', c.msg);
      console.error('');
      return;
    }
  }

  console.error('🎯 CAUSA: no identificada. Revisa el stderr.');
}

// ============================================================
//  UTILIDADES
// ============================================================
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

function logDiskSpace(dir) {
  try {
    if (fs.statfs) {
      const stats = fs.statfsSync(dir);
      const freeGB = (stats.bfree * stats.bsize) / (1024 ** 3);
      console.log(`💾 Disco libre: ${freeGB.toFixed(2)} GB`);
    }
  } catch {}
}