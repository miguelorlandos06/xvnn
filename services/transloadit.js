// services/transloadit.js
// ============================================================
//  TRANSCODIFICACIÓN HLS CON TRANSLOADIT + SUBIDA A TODUS
// ============================================================

import { Transloadit, ApiError } from '@transloadit/node';
import { CONFIG } from '../config.js';
import { uploadFile, publicUrl, deletePrefix } from './s3.js';

// ============================================================
//  CLIENTE TRANSLOADIT
// ============================================================
const client = new Transloadit({
  authKey: CONFIG.transloadit.authKey,
  authSecret: CONFIG.transloadit.authSecret,
  signatureAlgorithm: CONFIG.transloadit.signatureAlgorithm
});

// ============================================================
//  TRANSCODIFICAR A HLS
// ============================================================
export async function transcodeToHLS(videoUrl, videoId, onProgress = () => {}) {
  console.log(`[Transloadit] Enviando: ${videoUrl}`);

  onProgress(5, 'transcoding');

  let assembly;
  try {
    assembly = await client.createAssembly({
      params: {
        steps: {
          imported: {
            robot: '/http/import',
            url: videoUrl
          },
          // Paso 1: Codificar la variante HLS (preparar para adaptive)
          encoded: {
            use: 'imported',
            robot: '/video/encode',
            preset: CONFIG.transloadit.preset,
            ffmpeg_stack: CONFIG.transloadit.ffmpegStack,
            result: true
          },
          // Paso 2: Generar segmentos y master playlist HLS
          hls_bundled: {
            use: 'encoded',
            robot: '/video/adaptive',
            technique: 'hls',
            playlist_name: 'master.m3u8',
            ffmpeg_stack: CONFIG.transloadit.ffmpegStack,
            result: true
          }
        }
      },
      waitForCompletion: true
    });
  } catch (err) {
    if (err instanceof ApiError && err.response?.assembly_id) {
      console.error(
        `[Transloadit] Troubleshoot: https://transloadit.com/c/assemblies/${err.response.assembly_id}`
      );
    }
    throw new Error(`Transloadit error: ${err.message}`);
  }

  console.log(`[Transloadit] Assembly: ${assembly.assembly_id}`);

  if (assembly.ok !== 'ASSEMBLY_COMPLETED') {
    throw new Error(`Assembly falló: ${assembly.error || assembly.message}`);
  }

  // ============================================================
  //  RECOLECTAR ARCHIVOS GENERADOS
  // ============================================================
  const hlsFiles = assembly.results?.hls_bundled || [];
  if (hlsFiles.length === 0) {
    throw new Error('Transloadit no devolvió archivos HLS');
  }

  console.log(`[Transloadit] Archivos HLS recibidos: ${hlsFiles.length}`);

  const masterFile = hlsFiles.find(f =>
    f.name && f.name.toLowerCase().includes('master.m3u8')
  );
  if (!masterFile) {
    throw new Error('No se encontró master.m3u8 en los resultados');
  }

  // ============================================================
  //  SUBIR CADA ARCHIVO A TODUS
  // ============================================================
  onProgress(55, 'uploading');

  const baseKey = `videos/${videoId}/hls`;
  const uploadedFiles = [];
  let uploaded = 0;
  let failed = 0;

  for (const file of hlsFiles) {
    const fileName = file.name || `file_${uploaded}`;
    const fileUrl = file.ssl_url || file.url;

    if (!fileUrl) {
      failed++;
      continue;
    }

    try {
      const res = await fetch(fileUrl);
      if (!res.ok) {
        console.warn(`[ToDus] No se pudo descargar ${fileName}: ${res.status}`);
        failed++;
        continue;
      }

      const buffer = Buffer.from(await res.arrayBuffer());
      const contentType = getContentType(fileName);
      const key = `${baseKey}/${fileName}`;

      await uploadFile(key, buffer, contentType);
      uploadedFiles.push(key);

      uploaded++;
      const pct = 55 + Math.round((uploaded / hlsFiles.length) * 40);
      onProgress(pct, 'uploading');

    } catch (err) {
      console.warn(`[ToDus] Error con ${fileName}: ${err.message}`);
      failed++;
    }
  }

  console.log(`[ToDus] ${uploadedFiles.length} archivos subidos, ${failed} fallidos`);

  const masterKey = `${baseKey}/master.m3u8`;

  onProgress(100, 'done');

  return {
    masterKey,
    masterUrl: publicUrl(masterKey),
    totalFiles: uploadedFiles.length,
    failedFiles: failed,
    duration: Math.round(assembly.uploads?.[0]?.duration || 0)
  };
}

// ============================================================
//  EXTRAER THUMBNAIL
// ============================================================
export async function extractThumbnail(videoUrl, videoId) {
  console.log(`[Transloadit] Generando thumbnail: ${videoUrl}`);

  try {
    const assembly = await client.createAssembly({
      params: {
        steps: {
          imported: {
            robot: '/http/import',
            url: videoUrl
          },
          resized: {
            use: 'imported',
            robot: '/video/thumbs',
            count: 1,
            offsets: ['3s'],
            width: 640,
            height: 360,
            resize_strategy: 'fit'
          }
        }
      },
      waitForCompletion: true
    });

    if (assembly.ok !== 'ASSEMBLY_COMPLETED') {
      throw new Error(`Thumbnail falló: ${assembly.error || assembly.message}`);
    }

    const thumbs = assembly.results?.resized || [];
    if (thumbs.length === 0) {
      throw new Error('No se generó thumbnail');
    }

    const thumbUrl = thumbs[0].ssl_url || thumbs[0].url;
    const res = await fetch(thumbUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const buffer = Buffer.from(await res.arrayBuffer());
    const thumbKey = `videos/${videoId}/thumb.jpg`;
    await uploadFile(thumbKey, buffer, 'image/jpeg');

    console.log(`[ToDus] Thumbnail subido`);
    return publicUrl(thumbKey);

  } catch (err) {
    console.error('[Transloadit] Error thumbnail:', err.message);
    throw new Error(`Thumbnail: ${err.message}`);
  }
}

// ============================================================
//  ELIMINAR TODOS LOS ARCHIVOS DE UN VIDEO
// ============================================================
export async function deleteVideoFiles(videoId) {
  console.log(`[ToDus] Eliminando archivos del video ${videoId}`);
  return await deletePrefix(`videos/${videoId}/`);
}

// ============================================================
//  UTILS
// ============================================================
function getContentType(fileName) {
  const lower = fileName.toLowerCase();

  if (lower.endsWith('.m3u8')) return 'application/vnd.apple.mpegurl';
  if (lower.endsWith('.ts')) return 'video/mp2t';
  if (lower.endsWith('.mp4')) return 'video/mp4';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.png')) return 'image/png';

  return 'application/octet-stream';
}
