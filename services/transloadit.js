// services/transloadit.js
// ============================================================
//  TRANSCODIFICACIÓN HLS CON TRANSLOADIT + SUBIDA A TODUS
// ============================================================

import { Transloadit } from '@transloadit/node';
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
//  - Envía el video a Transloadit
//  - Espera a que termine
//  - Descarga los archivos generados
//  - Los sube a ToDus
// ============================================================
export async function transcodeToHLS(videoUrl, videoId, onProgress = () => {}) {
  console.log(`[Transloadit] Enviando: ${videoUrl}`);

  // ============================================================
  //  1. CREAR ASSEMBLY
  // ============================================================
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
          encoded: {
            use: 'imported',
            robot: '/video/encode',
            preset: CONFIG.transloadit.preset,
            ffmpeg_stack: CONFIG.transloadit.ffmpegStack
          }
        }
      },
      waitForCompletion: true
    });
  } catch (err) {
    throw new Error(`Transloadit error: ${err.message}`);
  }

  console.log(`[Transloadit] Assembly: ${assembly.assembly_id}`);

  if (assembly.ok !== 'ASSEMBLY_COMPLETED') {
    throw new Error(`Assembly falló: ${assembly.error || assembly.message}`);
  }

  // ============================================================
  //  2. RECOLECTAR ARCHIVOS GENERADOS
  // ============================================================
  const encoded = assembly.results?.encoded || [];
  if (encoded.length === 0) {
    throw new Error('Transloadit no devolvió archivos');
  }

  console.log(`[Transloadit] Archivos recibidos: ${encoded.length}`);

  // Verificar que existe el master.m3u8
  const masterFile = encoded.find(f =>
    f.name && f.name.toLowerCase().includes('master.m3u8')
  );
  if (!masterFile) {
    throw new Error('No se encontró master.m3u8 en los resultados');
  }

  // ============================================================
  //  3. SUBIR CADA ARCHIVO A TODUS
  // ============================================================
  onProgress(55, 'uploading');

  const baseKey = `videos/${videoId}/hls`;
  const uploadedFiles = [];
  let uploaded = 0;
  let failed = 0;

  for (const file of encoded) {
    const fileName = file.name || `file_${uploaded}`;
    const fileUrl = file.ssl_url || file.url;

    if (!fileUrl) {
      failed++;
      continue;
    }

    try {
      // Descargar desde Transloadit
      const res = await fetch(fileUrl);
      if (!res.ok) {
        console.warn(`[ToDus] No se pudo descargar ${fileName}: ${res.status}`);
        failed++;
        continue;
      }

      const buffer = Buffer.from(await res.arrayBuffer());

      // Determinar Content-Type
      const contentType = getContentType(fileName);

      // Subir a ToDus
      const key = `${baseKey}/${fileName}`;
      await uploadFile(key, buffer, contentType);
      uploadedFiles.push(key);

      uploaded++;
      const pct = 55 + Math.round((uploaded / encoded.length) * 40);
      onProgress(pct, 'uploading');

    } catch (err) {
      console.warn(`[ToDus] Error con ${fileName}: ${err.message}`);
      failed++;
    }
  }

  console.log(`[ToDus] ${uploadedFiles.length} archivos subidos, ${failed} fallidos`);

  // ============================================================
  //  4. RESULTADO
  // ============================================================
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

    // Descargar el thumbnail
    const thumbUrl = thumbs[0].ssl_url || thumbs[0].url;
    const res = await fetch(thumbUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const buffer = Buffer.from(await res.arrayBuffer());

    // Subir a ToDus
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
