// services/s3.js
import { Readable } from 'stream';
import { CONFIG } from '../config.js';

const BASE_URL = CONFIG.s3.baseUrl;

// ============================================================
//  URL PÚBLICA
// ============================================================
export function publicUrl(key) {
  if (!key) return null;
  return `${BASE_URL}/${key}`;
}

// ============================================================
//  SUBIR ARCHIVO
// ============================================================
export async function uploadFile(key, data, contentType = 'application/octet-stream') {
  const url = publicUrl(key);

  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    body: data,
    duplex: 'half'
  });

  if (!res.ok) {
    throw new Error(`Error subiendo a S3: ${res.status} ${res.statusText}`);
  }

  return { url, key };
}

// ============================================================
//  DESCARGAR ARCHIVO
// ============================================================
export async function downloadFile(key) {
  const url = publicUrl(key);
  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`Error descargando de S3: ${res.status}`);
  }

  return {
    stream: Readable.fromWeb(res.body),
    contentType: res.headers.get('content-type'),
    contentLength: res.headers.get('content-length')
  };
}

// ============================================================
//  ELIMINAR ARCHIVO
// ============================================================
export async function deleteFile(key) {
  if (!key) return true;

  const url = publicUrl(key);
  const res = await fetch(url, { method: 'DELETE' });

  if (!res.ok && res.status !== 404) {
    throw new Error(`Error eliminando de S3: ${res.status}`);
  }

  return true;
}

// ============================================================
//  LISTAR POR PREFIJO
// ============================================================
export async function listByPrefix(prefix) {
  const files = [];
  try {
    const res = await fetch(`${BASE_URL}?prefix=${prefix}&list-type=2&max-keys=1000`);
    if (!res.ok) return files;

    const xml = await res.text();
    const keyRegex = /<Key>([^<]+)<\/Key>/g;
    let match;
    while ((match = keyRegex.exec(xml)) !== null) {
      files.push(match[1]);
    }
  } catch (err) {
    console.warn('Error listando prefijo:', err.message);
  }
  return files;
}

// ============================================================
//  ELIMINAR PREFIJO COMPLETO
// ============================================================
export async function deletePrefix(prefix) {
  try {
    const files = await listByPrefix(prefix);
    console.log(`Eliminando ${files.length} archivos con prefijo "${prefix}"`);

    const results = await Promise.allSettled(
      files.map(key => deleteFile(key))
    );

    const failed = results.filter(r => r.status === 'rejected').length;
    console.log(`Eliminados: ${files.length - failed}/${files.length}`);

    return { total: files.length, failed };
  } catch (err) {
    console.warn('Error eliminando prefijo:', err.message);
    return { total: 0, failed: 0 };
  }
}

// ============================================================
//  HELPERS DE KEYS
// ============================================================
export function videoKey(videoId, ext) {
  return `${CONFIG.s3.prefix}/${videoId}/original${ext}`;
}

export function thumbKey(videoId, ext) {
  return `${CONFIG.s3.prefix}/${videoId}/thumb${ext}`;
}

export function hlsKey(videoId) {
  return `${CONFIG.s3.prefix}/${videoId}/hls`;
}

export function avatarKey(userId, ext) {
  return `avatars/${userId}/${Date.now()}.${ext}`;
}
