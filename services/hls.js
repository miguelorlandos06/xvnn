// services/hls.js
import ffmpeg from 'fluent-ffmpeg';
import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import pLimit from 'p-limit';
import { uploadFile, publicUrl } from './s3.js';
import { CONFIG } from '../config.js';

// ============================================================
//  FFMPEG: usar el binario del sistema (Render con Docker)
// ============================================================
ffmpeg.setFfmpegPath('/usr/bin/ffmpeg');

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
//  FUNCIÓN PRINCIPAL
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

    console.log(`✅ HLS listo: ${uploadedKeys.length} archivos subidos a S3`);

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
      console.error('⚠️  Error limpiando tmp HLS:', err.message);
    }
    releaseSlot();
  }
}

// ============================================================
//  FFMPEG: EJECUCIÓN CON LOGS COMPLETOS
// ============================================================
function runFFmpeg(inputPath, hlsDir, onProgress) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(inputPath, (err, metadata) => {
      if (err) {
        console.error('❌ ffprobe falló:', err.message);
        console.error('   inputPath:', inputPath);
        return reject(new Error(`ffprobe: ${err.message}`));
      }

      // ============ LOG DE METADATA ============
      console.log('');
      console.log('📹 ─── METADATA DEL VIDEO ───');
      console.log('   Formato:', metadata.format.format_name);
      console.log('   Duración:', metadata.format.duration, 's');
      console.log('   Tamaño:', (Number(metadata.format.size) / 1024 / 1024).toFixed(2), 'MB');
      console.log('   Bitrate:', metadata.format.bit_rate);
      console.log('   Streams:');
      metadata.streams.forEach((s, i) => {
        if (s.codec_type === 'video') {
          console.log(`     [${i}] video: ${s.codec_name} ${s.width}x${s.height} pix_fmt=${s.pix_fmt} fps=${s.r_frame_rate}`);
        } else if (s.codec_type === 'audio') {
          console.log(`     [${i}] audio: ${s.codec_name} ${s.channels}ch ${s.sample_rate}Hz`);
        } else {
          console.log(`     [${i}] ${s.codec_type}: ${s.codec_name}`);
        }
      });
      console.log('   ───────────────────────');
      console.log('');

      const totalDuration = parseFloat(metadata.format.duration) || 0;
      const outputOptions = buildFFmpegOptions(hlsDir);

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
          console.error('   Signal:', err.signal || 'n/a');
          console.error('');
          console.error('   ─── STDERR COMPLETO ───');
          const lines = stderrOutput.split('\n');
          const tail = lines.slice(-60);
          tail.forEach(l => console.error('   >', l));
          console.error('   ─── FIN STDERR ───');
          console.error('');

          detectErrorCause(stderrOutput);

          reject(new Error(`FFmpeg: ${err.message}`));
        })
        .run();
    });
  });
}

// ============================================================
//  DETECCIÓN AUTOMÁTICA DE CAUSA
// ============================================================
function detectErrorCause(stderr) {
  const lower = stderr.toLowerCase();

  const causes = [
    { match: /no space left on device/, msg: '💾 DISCO LLENO: reduce maxLinkDownloadMB o sube el plan de Render.' },
    { match: /cannot allocate memory|out of memory/, msg: '🧠 SIN MEMORIA RAM: reduce calidades o maxConcurrentJobs.' },
    { match: /invalid color space|unsupported color space/, msg: '🎨 INVALID COLOR SPACE: bug de FFmpeg 7.1+.' },
    { match: /unknown decoder|decoder.*not found|no decoder/, msg: '🎞 CÓDEC NO SOPORTADO: instala ffmpeg con todos los códecs.' },
    { match: /invalid data found|moov atom not found/, msg: '📁 ARCHIVO CORRUPTO o INCOMPLETO.' },
    { match: /permission denied/, msg: '🔒 PERMISO DENEGADO en /tmp.' },
    { match: /conversion failed/, msg: '⚠️  CONVERSION FAILED genérico: revisa el stderr arriba.' },
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

  console.error('');
  console.error('🎯 CAUSA: no identificada automáticamente. Revisa el stderr.');
  console.error('');
}

// ============================================================
//  CONSTRUIR OPCIONES DE FFMPEG
// ============================================================
function buildFFmpegOptions(hlsDir) {
  const opts = [];

  opts.push('-preset', 'veryfast');
  opts.push('-movflags', '+faststart');

  // Fix para "Invalid color space"
  opts.push('-pix_fmt', 'yuv420p');

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
      const totalGB = (stats.blocks * stats.bsize) / (1024 ** 3);
      console.log(`💾 Disco: ${freeGB.toFixed(2)} GB libres de ${totalGB.toFixed(2)} GB`);
    }
  } catch {}
}