// services/telegramBot.js
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { Transform, Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { CONFIG } from '../config.js';
import { run, get } from '../database.js';
import { uploadFile, publicUrl } from './s3.js';
import { transcodeToHLS, extractThumbnail } from './hls.js';

// ============ CONFIG ============
const TOKEN = CONFIG.telegram.botToken;
const API_ROOT = 'https://api.telegram.org';
const API_URL = `${API_ROOT}/bot${TOKEN}`;

// ============ ESTADO EN MEMORIA ============
const pendingVideos = new Map();
const userCooldowns = new Map();
let offset = 0;
let running = false;

// Limpieza de pendientes viejos
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pendingVideos.entries()) {
    if (now - v.timestamp > 30 * 60 * 1000) pendingVideos.delete(k);
  }
}, 5 * 60 * 1000);

// Limpieza periódica de temporales huérfanos
setInterval(() => {
  const tmp = os.tmpdir();
  const now = Date.now();
  try {
    for (const entry of fs.readdirSync(tmp)) {
      if (!entry.startsWith('xvnn-')) continue;
      const full = path.join(tmp, entry);
      try {
        const stat = fs.statSync(full);
        if (now - stat.mtimeMs > 60 * 60 * 1000) {
          fs.rmSync(full, { recursive: true, force: true });
          console.log(`🧹 Limpieza periódica: ${entry}`);
        }
      } catch {}
    }
  } catch {}
}, 30 * 60 * 1000);

// ============================================================
//  CLIENTE HTTP BOT API
// ============================================================
async function apiCall(method, body = {}) {
  const res = await fetch(`${API_URL}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`Telegram [${method}]: ${json.description}`);
  return json.result;
}

const tg = {
  sendMessage: (chatId, text, opts = {}) =>
    apiCall('sendMessage', { chat_id: chatId, text, parse_mode: 'Markdown', ...opts }),

  editMessageText: (chatId, messageId, text, opts = {}) =>
    apiCall('editMessageText', {
      chat_id: chatId, message_id: messageId, text, parse_mode: 'Markdown', ...opts
    }).catch(() => null),

  answerCallbackQuery: (id, text = '') =>
    apiCall('answerCallbackQuery', { callback_query_id: id, text }).catch(() => null),

  setMyCommands: (commands) => apiCall('setMyCommands', { commands }).catch(() => null),

  sendChatAction: (chatId, action = 'typing') =>
    apiCall('sendChatAction', { chat_id: chatId, action }).catch(() => null)
};

// ============================================================
//  LONG POLLING
// ============================================================
async function getUpdates() {
  const res = await fetch(`${API_URL}/getUpdates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      offset,
      timeout: CONFIG.telegram.pollTimeout,
      allowed_updates: ['message', 'callback_query']
    })
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (!json.ok) throw new Error(json.description);
  return json.result || [];
}

// ============================================================
//  VALIDACIÓN DE URL
// ============================================================
const ALLOWED_EXTENSIONS = ['.mp4', '.webm', '.mov', '.mkv', '.avi', '.m4v'];
const ALLOWED_MIMES = [
  'video/mp4', 'video/webm', 'video/quicktime', 'video/x-matroska',
  'video/x-msvideo', 'video/x-m4v', 'application/octet-stream'
];

async function validateVideoUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('El enlace no es válido');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Solo se permiten enlaces http:// o https://');
  }

  const hostname = parsed.hostname.toLowerCase();
  if (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname.startsWith('192.168.') ||
    hostname.startsWith('10.') ||
    hostname.match(/^172\.(1[6-9]|2[0-9]|3[0-1])\./) ||
    hostname === '0.0.0.0' ||
    hostname.endsWith('.local')
  ) {
    throw new Error('Enlace no permitido');
  }

  let head;
  try {
    head = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 XVNN-Bot/1.0' }
    });
  } catch (err) {
    throw new Error(`No se pudo acceder al enlace: ${err.message}`);
  }

  if (!head.ok) {
    throw new Error(`El servidor respondió ${head.status}`);
  }

  const contentType = (head.headers.get('content-type') || '').toLowerCase();
  const contentLength = parseInt(head.headers.get('content-length') || '0', 10);

  const isVideoMime = ALLOWED_MIMES.some(m => contentType.startsWith(m));
  const isVideoExt = ALLOWED_EXTENSIONS.some(ext => parsed.pathname.toLowerCase().endsWith(ext));

  if (!isVideoMime && !isVideoExt) {
    throw new Error(`El enlace no parece ser un video (tipo: ${contentType || 'desconocido'})`);
  }

  const maxBytes = CONFIG.telegram.maxLinkDownloadMB * 1024 * 1024;
  if (contentLength > maxBytes) {
    throw new Error(
      `El video pesa ${(contentLength / 1024 / 1024).toFixed(1)} MB. ` +
      `Límite: ${CONFIG.telegram.maxLinkDownloadMB} MB`
    );
  }

  return {
    url,
    contentType,
    contentLength,
    filename: path.basename(parsed.pathname) || 'video.mp4'
  };
}

// ============================================================
//  DESCARGA A ARCHIVO TEMPORAL
// ============================================================
async function downloadToFile(url, destPath, onProgress = () => {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 XVNN-Bot/1.0' }
  });

  if (!res.ok) throw new Error(`Descarga falló: HTTP ${res.status}`);

  const totalBytes = parseInt(res.headers.get('content-length') || '0', 10);
  const contentType = res.headers.get('content-type') || 'video/mp4';

  let downloaded = 0;
  const fileStream = fs.createWriteStream(destPath);

  const counter = new Transform({
    transform(chunk, encoding, callback) {
      downloaded += chunk.length;
      if (onProgress) onProgress(downloaded, totalBytes);
      callback(null, chunk);
    }
  });

  const nodeStream = Readable.fromWeb(res.body);
  await pipeline(nodeStream, counter, fileStream);

  return { size: downloaded, contentType };
}

// ============================================================
//  MANEJO DE MENSAJES
// ============================================================
async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = (msg.text || '').trim();

  // ============ /start ============
  if (text.startsWith('/start')) {
    await tg.sendMessage(chatId,
      `🎬 *¡Bienvenido a XVNN, ${escapeMd(msg.from.first_name || 'amigo')}!*\n\n` +
      `Soy el bot oficial para publicar videos en la plataforma.\n\n` +
      `📤 *¿Cómo funciona?*\n` +
      `1️⃣ Envíame un *enlace directo* al video\n` +
      `2️⃣ Elige la categoría\n` +
      `3️⃣ Yo lo descargo, proceso y publico\n\n` +
      `⚡ *Formatos:* MP4, WebM, MOV, MKV\n` +
      `📏 *Tamaño máximo:* ${CONFIG.telegram.maxLinkDownloadMB} MB\n` +
      `🔗 *Ejemplo:* \`https://ejemplo.com/video.mp4\`\n\n` +
      `¿Listo? Pégame un enlace 🚀`
    );
    return;
  }

  // ============ /help ============
  if (text.startsWith('/help')) {
    await tg.sendMessage(chatId,
      `🆘 *Ayuda XVNN*\n\n` +
      `• /start — Menú principal\n` +
      `• /help — Esta ayuda\n` +
      `• /stats — Tus estadísticas\n` +
      `• /cancel — Cancelar enlace pendiente\n\n` +
      `*¿Cómo consigo un enlace directo?*\n` +
      `Es una URL que apunta al archivo, no a una página web. Ejemplos:\n` +
      `• \`https://midominio.com/video.mp4\`\n` +
      `• \`https://cdn.ejemplo.com/abc.mkv\``
    );
    return;
  }

  // ============ /cancel ============
  if (text.startsWith('/cancel')) {
    if (pendingVideos.has(userId)) {
      pendingVideos.delete(userId);
      await tg.sendMessage(chatId, '❌ Enlace cancelado.');
    } else {
      await tg.sendMessage(chatId, 'No tienes ningún enlace pendiente.');
    }
    return;
  }

  // ============ /stats ============
  if (text.startsWith('/stats')) {
    try {
      const s = await get(`
        SELECT 
          COUNT(*)::int AS total,
          COALESCE(SUM(views), 0)::int AS views,
          COALESCE(SUM(likes), 0)::int AS likes
        FROM videos WHERE telegram_user_id = $1
      `, [userId]);

      await tg.sendMessage(chatId,
        `📊 *Tus estadísticas en XVNN*\n\n` +
        `🎬 Videos subidos: *${s.total}*\n` +
        `👁 Vistas: *${s.views}*\n` +
        `❤️ Likes: *${s.likes}*`
      );
    } catch (err) {
      console.error('Error /stats:', err);
      await tg.sendMessage(chatId, '❌ Error obteniendo estadísticas');
    }
    return;
  }

  // ============ DETECTAR ENLACE ============
  const urlMatch = text.match(/https?:\/\/[^\s]+/i);
  if (urlMatch) {
    await handleLinkMessage(msg, urlMatch[0]);
    return;
  }

  // ============ CUALQUIER OTRO TEXTO ============
  if (text && !text.startsWith('/')) {
    await tg.sendMessage(chatId,
      `📤 Envíame un *enlace directo* a un video.\n\n` +
      `Ejemplo: \`https://ejemplo.com/video.mp4\`\n\n` +
      `Usa /help para más info.`
    );
  }
}

// ============================================================
//  MANEJO DEL ENLACE
// ============================================================
async function handleLinkMessage(msg, url) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (!checkCooldown(userId)) {
    await tg.sendMessage(chatId,
      '⏱ Has alcanzado el límite de 3 videos por hora. Espera un poco.'
    );
    return;
  }

  await tg.sendChatAction(chatId, 'typing');

  const tempMsg = await tg.sendMessage(chatId,
    `🔍 *Verificando enlace...*\n\n\`${escapeMd(url.slice(0, 80))}${url.length > 80 ? '...' : ''}\``
  );

  try {
    const info = await validateVideoUrl(url);

    pendingVideos.set(userId, {
      url: info.url,
      contentLength: info.contentLength,
      contentType: info.contentType,
      filename: info.filename,
      timestamp: Date.now(),
      chatId,
      tempMessageId: tempMsg.message_id
    });

    const keyboard = {
      inline_keyboard: [
        [
          { text: '👫 Hetero', callback_data: 'cat:Hetero' },
          { text: '🏳️‍🌈 Gay',    callback_data: 'cat:Gay' }
        ],
        [
          { text: '💜 Bi',     callback_data: 'cat:Bi' },
          { text: '🏳️‍⚧️ Trans',  callback_data: 'cat:Trans' }
        ],
        [
          { text: '❌ Cancelar', callback_data: 'cancel_upload' }
        ]
      ]
    };

    const sizeMB = (info.contentLength / 1024 / 1024).toFixed(1);

    await tg.editMessageText(chatId, tempMsg.message_id,
      `✅ *Video detectado*\n\n` +
      `📄 Nombre: \`${escapeMd(info.filename)}\`\n` +
      `📊 Tamaño: ${sizeMB} MB\n` +
      `🎞 Tipo: ${info.contentType}\n\n` +
      `👇 *Selecciona la categoría:*`,
      { reply_markup: keyboard }
    );

  } catch (err) {
    console.error('Error validando URL:', err);
    await tg.editMessageText(chatId, tempMsg.message_id,
      `❌ *No se pudo usar ese enlace*\n\n` +
      `Motivo: ${escapeMd(err.message)}\n\n` +
      `Verifica que:\n` +
      `• El enlace apunte directo al archivo\n` +
      `• Sea accesible sin autenticación\n` +
      `• Pese menos de ${CONFIG.telegram.maxLinkDownloadMB} MB`
    );
  }
}

// ============================================================
//  CALLBACK QUERIES
// ============================================================
async function handleCallbackQuery(query) {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const userId = query.from.id;
  const data = query.data;

  if (data === 'cancel_upload') {
    pendingVideos.delete(userId);
    await tg.answerCallbackQuery(query.id, 'Cancelado');
    await tg.editMessageText(chatId, messageId, '❌ Operación cancelada.');
    return;
  }

  if (data.startsWith('cat:')) {
    const category = data.replace('cat:', '');
    const pending = pendingVideos.get(userId);

    if (!pending) {
      await tg.answerCallbackQuery(query.id, '⚠️ Enlace expirado');
      await tg.editMessageText(chatId, messageId,
        '⚠️ El enlace expiró. Envíame uno nuevo.'
      );
      return;
    }

    pendingVideos.delete(userId);
    await tg.answerCallbackQuery(query.id, `✅ ${category}`);

    processVideo(query.from, pending, category, chatId, messageId)
      .catch(err => console.error('❌ Error en processVideo:', err));
  }
}

// ============================================================
//  PROCESAMIENTO COMPLETO
// ============================================================
async function processVideo(from, pending, category, chatId, messageId) {
  const tmpDir = path.join(os.tmpdir(), `xvnn-${crypto.randomBytes(8).toString('hex')}`);
  const tmpVideoPath = path.join(tmpDir, 'video' + path.extname(pending.filename || '.mp4'));
  const tmpThumbPath = path.join(tmpDir, 'thumb.jpg');

  let videoId = null;

  try {
    fs.mkdirSync(tmpDir, { recursive: true });

    // ============ 1. DESCARGA ============
    await updateProgress(chatId, messageId, 0, '📥 Descargando video...');

    let lastReported = -1;
    const { size: downloadedSize } = await downloadToFile(
      pending.url,
      tmpVideoPath,
      (downloaded, total) => {
        if (!total) return;
        const pct = Math.round((downloaded / total) * 100);
        if (pct - lastReported >= 5) {
          lastReported = pct;
          const mbDown = (downloaded / 1024 / 1024).toFixed(1);
          const mbTotal = (total / 1024 / 1024).toFixed(1);
          const progressPct = Math.round(pct * 0.3);
          updateProgress(chatId, messageId, progressPct,
            `📥 Descargando... ${mbDown}/${mbTotal} MB`
          );
        }
      }
    );

    await updateProgress(chatId, messageId, 30, '☁️ Subiendo original a la nube...');

    // ============ 2. SUBIR ORIGINAL A S3 ============
    videoId = crypto.randomUUID();
    const ext = path.extname(pending.filename || '.mp4').toLowerCase() || '.mp4';
    const vKey = `videos/${videoId}/original${ext}`;

    const videoBuffer = fs.readFileSync(tmpVideoPath);
    await uploadFile(vKey, videoBuffer, pending.contentType || 'video/mp4');

    await updateProgress(chatId, messageId, 38, '📸 Extrayendo miniatura...');

    // ============ 3. THUMBNAIL REAL DEL VIDEO ============
    const tKey = `videos/${videoId}/thumb.jpg`;
    let thumbUploaded = false;

    try {
      await extractThumbnail(tmpVideoPath, tmpThumbPath);
      const thumbBuffer = fs.readFileSync(tmpThumbPath);
      await uploadFile(tKey, thumbBuffer, 'image/jpeg');
      thumbUploaded = true;
      console.log(`✅ Thumbnail subido: ${tKey}`);
    } catch (thumbErr) {
      console.warn('⚠️  Error extrayendo thumbnail:', thumbErr.message);
      // Fallback: generar placeholder JPG negro
      try {
        const placeholderJPG = await generateMinimalJPG();
        await uploadFile(tKey, placeholderJPG, 'image/jpeg');
        thumbUploaded = true;
        console.log('✅ Thumbnail placeholder subido');
      } catch (fallbackErr) {
        console.error('❌ Error generando placeholder:', fallbackErr.message);
        // Último recurso: subir un buffer vacío para no romper el flujo
        await uploadFile(tKey, Buffer.from([0xFF, 0xD8, 0xFF, 0xD9]), 'image/jpeg');
      }
    }

    await updateProgress(chatId, messageId, 42, '💾 Guardando metadatos...');

    // ============ 4. USUARIO BOT ============
    const botUser = await getOrCreateBotUser(from);

    // ============ 5. INSERT EN BD ============
    await run(`
      INSERT INTO videos
        (id, user_id, title, description, category, filename, thumbnail,
         duration, size, video_type, processing_status,
         telegram_user_id, telegram_username, telegram_chat_id, telegram_progress_message_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
    `, [
      videoId,
      botUser.id,
      cleanFilename(pending.filename),
      `Subido vía Telegram por @${from.username || from.first_name}`,
      category,
      vKey,
      tKey,
      0,
      downloadedSize,
      'mp4',
      'processing',
      from.id,
      from.username || null,
      chatId,
      messageId
    ]);

    await updateProgress(chatId, messageId, 45, '🎞 Transcodificando a HLS...');

    // ============ 6. TRANSCODIFICAR A HLS ============
    let lastHls = 45;
    const onHlsProgress = async (pct, stage) => {
      const overall = 45 + Math.round((pct / 100) * 45);
      if (overall - lastHls >= 5 || overall >= 90) {
        lastHls = overall;
        const txt = stage === 'transcoding'
          ? '🎞 Transcodificando a HLS...'
          : '☁️ Subiendo segmentos HLS...';
        await updateProgress(chatId, messageId, overall, txt);
      }
    };

    const hlsResult = await transcodeToHLS(tmpVideoPath, videoId, onHlsProgress);

    await updateProgress(chatId, messageId, 95, '💾 Guardando metadatos...');

    // ============ 7. ACTUALIZAR BD ============
    await run(`
      UPDATE videos 
      SET hls_manifest = $1,
          video_type = 'hls',
          processing_status = 'ready',
          variants = $2,
          duration = $3
      WHERE id = $4
    `, [
      hlsResult.masterKey,
      JSON.stringify(hlsResult.variants),
      hlsResult.duration || 0,
      videoId
    ]);

    await updateProgress(chatId, messageId, 100, '✅ ¡Listo!');

    // ============ 8. MENSAJE FINAL ============
    const webUrl = `${CONFIG.server.baseUrl}/watch.html?id=${videoId}`;
    const sizeMB = (downloadedSize / 1024 / 1024).toFixed(1);

    await tg.editMessageText(chatId, messageId,
      `✅ *¡Video publicado exitosamente!*\n\n` +
      `📁 *Categoría:* ${category}\n` +
      `📊 *Tamaño:* ${sizeMB} MB\n` +
      `🎞 *Calidades:* ${hlsResult.variants.map(v => v.name).join(', ')}\n` +
      `🎬 *Segmentos:* ${hlsResult.totalFiles}\n\n` +
      `🌐 *Ya está disponible en la web*`,
      {
        reply_markup: {
          inline_keyboard: [[
            { text: '🌐 Ver en la web', url: webUrl }
          ]]
        }
      }
    );

  } catch (err) {
    console.error('❌ Error procesando video:', err);

    if (videoId) {
      await run(
        'UPDATE videos SET processing_status = $1 WHERE id = $2',
        ['failed', videoId]
      ).catch(() => {});
    }

    await tg.editMessageText(chatId, messageId,
      `❌ *Error procesando el video*\n\n` +
      `Motivo: ${escapeMd(err.message)}\n\n` +
      `Verifica que el enlace siga activo e intenta de nuevo.`
    );

  } finally {
    // ============ 9. LIMPIAR TEMPORALES ============
    try {
      if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        console.log(`🧹 Temporales limpiados: ${tmpDir}`);
      }
    } catch (cleanupErr) {
      console.error('⚠️  Error limpiando temporales:', cleanupErr.message);
    }
  }
}

// ============================================================
//  GENERAR PLACEHOLDER JPG MINIMALISTA (fallback)
// ============================================================
async function generateMinimalJPG() {
  const { execSync } = await import('child_process');
  const tmpId = crypto.randomBytes(4).toString('hex');
  const tmpPath = path.join(os.tmpdir(), `placeholder-${tmpId}.jpg`);

  try {
    execSync(
      `/usr/bin/ffmpeg -y -f lavfi -i "color=c=0x1a0505:s=640x360:d=1" -frames:v 1 -q:v 3 "${tmpPath}"`,
      { timeout: 10000, stdio: 'ignore' }
    );
    const buffer = fs.readFileSync(tmpPath);
    fs.unlinkSync(tmpPath);
    return buffer;
  } catch (err) {
    console.error('❌ Error generando placeholder JPG:', err.message);
    // Último recurso: JPG vacío mínimo válido
    return Buffer.from([
      0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01,
      0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xFF, 0xDB, 0x00, 0x43,
      0x00, 0x08, 0x06, 0x06, 0x07, 0x06, 0x05, 0x08, 0x07, 0x07, 0x07, 0x09,
      0x09, 0x08, 0x0A, 0x0C, 0x14, 0x0D, 0x0C, 0x0B, 0x0B, 0x0C, 0x19, 0x12,
      0x13, 0x0F, 0x14, 0x1D, 0x1A, 0x1F, 0x1E, 0x1D, 0x1A, 0x1C, 0x1C, 0x20,
      0x24, 0x2E, 0x27, 0x20, 0x22, 0x2C, 0x23, 0x1C, 0x1C, 0x28, 0x37, 0x29,
      0x2C, 0x30, 0x31, 0x34, 0x34, 0x34, 0x1F, 0x27, 0x39, 0x3D, 0x38, 0x32,
      0x3C, 0x2E, 0x33, 0x34, 0x32, 0xFF, 0xC0, 0x00, 0x0B, 0x08, 0x00, 0x01,
      0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xFF, 0xC4, 0x00, 0x14, 0x00, 0x01,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x03, 0xFF, 0xC4, 0x00, 0x14, 0x10, 0x01, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0xFF, 0xDA, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3F, 0x00,
      0x37, 0xFF, 0xD9
    ]);
  }
}

// ============================================================
//  UTILIDADES
// ============================================================
async function updateProgress(chatId, messageId, percent, text) {
  const filled = Math.round(percent / 10);
  const bar = '▰'.repeat(filled) + '▱'.repeat(10 - filled);

  await tg.editMessageText(chatId, messageId,
    `⚙️ *Procesando video...*\n\n` +
    `${bar} ${percent}%\n` +
    `${text}`
  );
}

function checkCooldown(userId) {
  const now = Date.now();
  const cd = userCooldowns.get(userId);
  if (cd && now < cd.resetAt) {
    if (cd.count >= 3) return false;
    cd.count++;
  } else {
    userCooldowns.set(userId, { count: 1, resetAt: now + 3600000 });
  }
  return true;
}

async function getOrCreateBotUser(from) {
  const username = `${CONFIG.telegram.botUsername}_${from.id}`;
  let user = await get('SELECT id FROM users WHERE username = $1', [username]);
  if (user) return user;

  const bcrypt = await import('bcryptjs');
  const hash = await bcrypt.default.hash(crypto.randomBytes(32).toString('hex'), 10);

  return await get(`
    INSERT INTO users (name, username, password)
    VALUES ($1, $2, $3)
    RETURNING id, name, username
  `, [from.first_name || 'Usuario Telegram', username, hash]);
}

function escapeMd(text) {
  return String(text).replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

function cleanFilename(filename) {
  return String(filename || 'Video')
    .replace(/\.[^.]+$/, '')
    .replace(/[_-]/g, ' ')
    .trim()
    .slice(0, 200) || 'Video XVNN';
}

// ============================================================
//  LOOP PRINCIPAL
// ============================================================
export async function startTelegramBot() {
  if (!TOKEN || TOKEN.includes('TU_TOKEN') || TOKEN.includes('xxxx')) {
    console.warn('⚠️  Bot desactivado (token no configurado)');
    return;
  }

  await apiCall('deleteWebhook', { drop_pending_updates: true }).catch(() => {});

  await tg.setMyCommands([
    { command: 'start',  description: 'Iniciar / Publicar video' },
    { command: 'help',   description: 'Ayuda' },
    { command: 'stats',  description: 'Mis estadísticas' },
    { command: 'cancel', description: 'Cancelar operación' }
  ]);

  console.log('✅ Bot de Telegram iniciado (modo enlace directo)');
  running = true;

  while (running) {
    try {
      const updates = await getUpdates();
      for (const u of updates) {
        offset = u.update_id + 1;
        handleUpdate(u).catch(err =>
          console.error('❌ Error en update:', err.message)
        );
      }
    } catch (err) {
      console.error('⚠️  Error polling:', err.message);
      await new Promise(r => setTimeout(r, 500));
    }
  }
}

async function handleUpdate(update) {
  try {
    if (update.message) await handleMessage(update.message);
    else if (update.callback_query) await handleCallbackQuery(update.callback_query);
  } catch (err) {
    console.error('❌ Error en update:', err.message);
  }
}

export function stopTelegramBot() {
  running = false;
}