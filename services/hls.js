// services/hls.js
import { spawn, execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import pLimit from 'p-limit';
import { uploadFile, publicUrl } from './s3.js';
import { CONFIG } from '../config.js';

// ============================================================
//  BINARIOS DE FFMPEG (RUTAS ABSOLUTAS)
// ============================================================
const FFMPEG_PATH = '/usr/bin/ffmpeg';
const FFPROBE_PATH = '/usr/bin/ffprobe';

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
//  EJECUTAR FFMPEG CON SPAWN DIRECTO
// ============================================================
function runFFmpeg(inputPath, hlsDir, totalDuration, onProgress) {
  return new Promise((resolve, reject) => {
    // ============ DETECTAR FPS CON FFPROBE ============
    let fps = 30;
    try {
      const probeOut = execSync(
        `${FFPROBE_PATH} -v error -select_streams v:0 -show_entries stream=r_frame_rate -of csv=p=0 "${inputPath}"`,
        { encoding: 'utf-8', timeout: 10000 }
      ).trim();

      if (probeOut.includes('/')) {
        const [num, den] = probeOut.split('/').map(Number);
        fps = Math.round(num / den) || 30;
      } else {
        fps = parseFloat(probeOut) || 30;
      }
    } catch (e) {
      console.warn('⚠️  No se pudo detectar FPS, usando 30 por defecto');
    }

    const gop = fps * HLS_CONFIG.segmentDuration;

    console.log(`📹 FPS detectado: ${fps}`);
    console.log(`🎯 GOP calculado: ${gop}`);

    // ============ CONSTRUIR FILTER_COMPLEX ============
    const n = QUALITY_PROFILES.length;

    // Ejemplo: [0:v]split=4[v1][v2][v3][v4]; [v1]scale=-2:240[v1out]; [v2]scale=-2:360[v2out]; ...
    const splitLabels = QUALITY_PROFILES.map((_, i) => `[v${i + 1}]`).join('');
    const scaleChains = QUALITY_PROFILES.map((q, i) => {
      const height = q.resolution.split('x')[1];
      return `[v${i + 1}]scale=-2:${height}[v${i + 1}out]`;
    }).join('; ');

    const filterComplex = `[0:v]split=${n}${splitLabels}; ${scaleChains}`;

    // ============ ARGUMENTOS DE FFMPEG ============
    const args = [
      '-y',
      '-i', inputPath,
      '-filter_complex', filterComplex,
    ];

    // Mapear cada calidad de video + audio
    for (let i = 0; i < n; i++) {
      args.push('-map', `[v${i + 1}out]`);
      args.push('-map', '0:a:0?');
    }

    // Configuración de video y audio por calidad
    QUALITY_PROFILES.forEach((q, i) => {
      // Video
      args.push(`-c:v:${i}`, 'libx264');
      args.push(`-b:v:${i}`, q.videoBitrate);
      args.push(`-maxrate:v:${i}`, q.maxrate);
      args.push(`-bufsize:v:${i}`, q.bufsize);
      args.push(`-profile:v:${i}`, 'main');
      args.push(`-level:v:${i}`, '3.1');
      args.push(`-pix_fmt:v:${i}`, 'yuv420p');

      // Audio
      args.push(`-c:a:${i}`, 'aac');
      args.push(`-b:a:${i}`, q.audioBitrate);
      args.push(`-ac:a:${i}`, '2');
      args.push(`-ar:a:${i}`, '44100');
    });

    // Configuración global
    args.push('-preset', 'veryfast');
    args.push('-pix_fmt', 'yuv420p');
    args.push('-g', String(gop));
    args.push('-keyint_min', String(gop));
    args.push('-sc_threshold', '0');

    // var_stream_map
    const streamMap = QUALITY_PROFILES.map((q, i) => `v:${i},a:${i}`).join(' ');
    args.push('-var_stream_map', streamMap);

    // HLS
    args.push('-hls_time', String(HLS_CONFIG.segmentDuration));
    args.push('-hls_playlist_type', 'vod');
    args.push('-hls_segment_filename', path.join(hlsDir, '%v', 'seg_%05d.ts'));
    args.push('-hls_flags', 'independent_segments');
    args.push('-master_pl_name', 'master.m3u8');
    args.push('-f', 'hls');
    args.push(path.join(hlsDir, '%v', 'index.m3u8'));

    // ============ LOG DEL COMANDO ============
    console.log('');
    console.log('🎬 ─── COMANDO FFMPEG ───');
    console.log(`${FFMPEG_PATH} ${args.map(a => String(a).includes(' ') ? `"${a}"` : a).join(' ')}`);
    console.log('   ────────────────────');
    console.log('');

    // ============ SPAWN ============
    const proc = spawn(FFMPEG_PATH, args);
    let stderr = '';
    let lastProgress = -1;

    proc.stderr.on('data', (data) => {
      const chunk = data.toString();
      stderr += chunk;

      // Parsear tiempo de progreso
      const match = chunk.match(/time=(\d+):(\d+):(\d+)\.\d+/);
      if (match && totalDuration > 0) {
        const secs = parseInt(match[1]) * 3600 +
                     parseInt(match[2]) * 60 +
                     parseInt(match[3]);

        const pct = Math.min(99, Math.round((secs / totalDuration) * 100));
        if (pct !== lastProgress) {
          lastProgress = pct;
          onProgress(pct);
        }
      }
    });

    proc.on('close', (code) => {
      if (code === 0) {
        console.log('✅ FFmpeg completó la transcodificación');
        resolve(totalDuration);
      } else {
        console.error('');
        console.error('❌ ❌ ❌  FFMPEG ERROR  ❌ ❌ ❌');
        console.error('   Código de salida:', code);
        console.error('');
        console.error('   ─── STDERR COMPLETO ───');
        const lines = stderr.split('\n');
        lines.slice(-60).forEach(l => console.error('   >', l));
        console.error('   ─── FIN STDERR ───');
        console.error('');

        // Detectar causa
        const lower = stderr.toLowerCase();
        if (/no such filter|invalid argument/i.test(lower)) {
          console.error('🎯 CAUSA: ERROR EN FILTER_COMPLEX');
        } else if (/unable to map stream at a:0/i.test(lower)) {
          console.error('🎯 CAUSA: AUDIO OPCIONAL no soportado en var_stream_map');
        } else if (/no space left/i.test(lower)) {
          console.error('🎯 CAUSA: DISCO LLENO');
        } else if (/cannot allocate memory|out of memory/i.test(lower)) {
          console.error('🎯 CAUSA: SIN MEMORIA RAM');
        } else if (/unknown decoder|decoder.*not found/i.test(lower)) {
          console.error('🎯 CAUSA: CÓDEC NO SOPORTADO');
        } else if (/invalid data found|moov atom not found/i.test(lower)) {
          console.error('🎯 CAUSA: ARCHIVO CORRUPTO o INCOMPLETO');
        } else if (/conversion failed/i.test(lower)) {
          console.error('🎯 CAUSA: CONVERSIÓN FALLIDA genérica');
        } else {
          console.error('🎯 CAUSA: no identificada');
        }
        console.error('');

        reject(new Error(`FFmpeg exit ${code}`));
      }
    });

    proc.on('error', (err) => {
      console.error('❌ Error al lanzar FFmpeg:', err.message);
      reject(err);
    });
  });
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
    // Preparar archivo de entrada
    if (Buffer.isBuffer(input)) {
      fs.writeFileSync(inputPath, input);
    } else {
      fs.copyFileSync(input, inputPath);
    }

    // Obtener duración con ffprobe
    let totalDuration = 0;
    try {
      const durationOut = execSync(
        `${FFPROBE_PATH} -v error -show_entries format=duration -of csv=p=0 "${inputPath}"`,
        { encoding: 'utf-8', timeout: 10000 }
      ).trim();
      totalDuration = parseFloat(durationOut) || 0;
    } catch (e) {
      console.warn('⚠️  No se pudo detectar duración');
    }

    console.log(`📹 Duración: ${totalDuration.toFixed(2)}s`);
    console.log('');

    // Transcodificar
    onProgress(0, 'transcoding');
    await runFFmpeg(inputPath, hlsDir, totalDuration, (pct) =>
      onProgress(pct, 'transcoding')
    );

    // ============ SUBIR A S3 ============
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

    console.log(`✅ HLS listo: ${uploadedKeys.length} archivos subidos`);

    return {
      masterKey,
      masterUrl: publicUrl(masterKey),
      variants,
      totalFiles: uploadedKeys.length,
      duration: Math.round(totalDuration)
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