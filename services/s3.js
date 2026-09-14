// services/s3.js
import { Readable } from 'stream';
import { CONFIG } from '../config.js';

const BASE_URL = CONFIG.s3.baseUrl;
const PREFIX = CONFIG.s3.prefix;

export function publicUrl(key) {
  return `${BASE_URL}/${key}`;
}

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

export async function deleteFile(key) {
  const url = publicUrl(key);
  const res = await fetch(url, { method: 'DELETE' });

  if (!res.ok && res.status !== 404) {
    throw new Error(`Error eliminando de S3: ${res.status}`);
  }

  return true;
}

export function videoKey(videoId, ext) {
  return `${PREFIX}/${videoId}/original${ext}`;
}

export function thumbKey(videoId, ext) {
  return `${PREFIX}/${videoId}/thumb${ext}`;
}