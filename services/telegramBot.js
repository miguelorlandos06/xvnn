// services/telegramBot.js
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import os from 'os';
import bcrypt from 'bcryptjs';
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

// ============ ESTADOS DE CONVERSACIÓN ============
// Map<telegramUserId, { state, username, videoData, timestamp, failedAttempts }>
const conversations = new Map();

// Map<telegramUserId, { xvnnUserId, username }>  ← sesiones autenticadas
const sessions = new Map();

let offset = 0;
let running = false;

// Limpieza periódica de conversaciones huérfanas
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of conversations.entries()) {
    if (now - v.timestamp > 30 * 60 * 1000) conversations.delete(k);
  }
}, 5 * 60 * 1000);

// Limpieza periódica de temporales
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

  deleteMessage: (chatId, messageId) =>
    apiCall('deleteMessage', { chat_id: chatId, message_id: messageId }).catch(() => null),

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

  if (!head.ok) throw new Error(`El servidor respondió ${head.status}`);

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
//  AUTENTICACIÓN DE USUARIO
// ============================================================
async function authenticateUser(username, password) {
  const user = await get(
    'SELECT id, name, username, password FROM users WHERE LOWER(username) = LOWER($1)',
    [username]
  );

  if (!user) return null;

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return null;

  return {
    id: user.id,
    name: user.name,
    username: user.username
  };
}

// ============================================================
//  MANEJO DE MENSAJES
// ============================================================
async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = (msg.text || '').trim();
  const conv = conversations.get(userId);
  const session = sessions.get(userId);

  // ============ /start ============
  if (text.startsWith('/start')) {
    // Si ya está autenticado → bienvenida simple
    if (session) {
      await tg.sendMessage(chatId,
        `👋 *¡Hola de nuevo, ${escapeMd(session.username)}!*\n\n` +
        `Ya estás autenticado. Envíame un *enlace directo* a un video para publicarlo.\n\n` +
        `Usa /logout para cerrar sesión.`
      );
      return;
    }

    // Iniciar flujo de login
    conversations.set(userId, {
      state: 'awaiting_username',
      timestamp: Date.now(),
      chatId
    });

    await tg.sendMessage(chatId,
      `🎬 *Bienvenido a XVNN*\n\n` +
      `Para publicar videos necesitas iniciar sesión con tu cuenta de XVNN.\n\n` +
      `📝 *Ingresa tu usuario:*`
    );
    return;
  }

  // ============ /logout ============
  if (text.startsWith('/logout')) {
    sessions.delete(userId);
    conversations.delete(userId);

    await run(
      'DELETE FROM telegram_sessions WHERE telegram_user_id = $1',
      [userId]
    ).catch(() => {});

    await tg.sendMessage(chatId,
      `👋 *Sesión cerrada*\n\n` +
      `Usa /start para volver a iniciar sesión.`
    );
    return;
  }

  // ============ /help ============
  if (text.startsWith('/help')) {
    if (!session) {
      return tg.sendMessage(chatId,
        `🆘 *Ayuda XVNN*\n\n` +
        `Primero debes autenticarte. Usa /start para comenzar.`
      );
    }

    await tg.sendMessage(chatId,
      `🆘 *Ayuda XVNN*\n\n` +
      `• /start — Menú principal\n` +
      `• /help — Esta ayuda\n` +
      `• /stats — Tus estadísticas\n` +
      `• /cancel — Cancelar enlace pendiente\n` +
      `• /logout — Cerrar sesión\n\n` +
      `📤 *Envíame un enlace directo* al video para publicarlo.\n\n` +
      `*Ejemplo:*\n` +
      `\`https://midominio.com/video.mp4\``
    );
    return;
  }

  // ============ /stats ============
  if (text.startsWith('/stats')) {
    if (!session) {
      return tg.sendMessage(chatId, `🔒 Primero inicia sesión con /start`);
    }

    try {
      const s = await get(`
        SELECT 
          COUNT(*)::int AS total,
          COALESCE(SUM(views), 0)::int AS views,
          COALESCE(SUM(likes), 0)::int AS likes
        FROM videos WHERE user_id = $1
      `, [session.xvnnUserId]);

      await tg.sendMessage(chatId,
        `📊 *Tus estadísticas en XVNN*\n\n` +
        `🎬 Videos subidos: *${s.total}*\n` +
        `👁 Vistas totales: *${s.views}*\n` +
        `❤️ Likes totales: *${s.likes}*\n\n` +
        `🌐 Ver más en: ${CONFIG.server.baseUrl}/profile.html`
      );
    } catch (err) {
      console.error('Error /stats:', err);
      await tg.sendMessage(chatId, '❌ Error obteniendo estadísticas');
    }
    return;
  }

  // ============ /cancel ============
  if (text.startsWith('/cancel')) {
    conversations.delete(userId);
    await tg.sendMessage(chatId, '❌ Operación cancelada.');
    return;
  }

  // ============ FLUJO DE AUTENTICACIÓN ============
  if (conv?.state === 'awaiting_username') {
    const username = text;

    if (!username || username.length < 3 || !/^[a-zA-Z0-9_]+$/.test(username)) {
      await tg.sendMessage(chatId,
        `❌ *Usuario inválido*\n\n` +
        `Debe tener al menos 3 caracteres y solo letras, números y _.\n\n` +
        `Intenta de nuevo:`
      );
      return;
    }

    conversations.set(userId, {
      ...conv,
      state: 'awaiting_password',
      username,
      timestamp: Date.now()
    });

    await tg.sendMessage(chatId,
      `🔑 *Ahora ingresa tu contraseña:*\n\n` +
      `_Por seguridad, borraré este mensaje automáticamente._`
    );
    return;
  }

  if (conv?.state === 'awaiting_password') {
    // Borrar el mensaje con la contraseña inmediatamente
    await tg.deleteMessage(chatId, msg.message_id);

    const password = text;
    const username = conv.username;

    if (!password || password.length < 6) {
      conversations.set(userId, {
        ...conv,
        state: 'awaiting_password',
        timestamp: Date.now()
      });
      await tg.sendMessage(chatId,
        `❌ *Contraseña inválida* (mín. 6 caracteres).\n\n` +
        `Intenta de nuevo:`
      );
      return;
    }

    // Validar credenciales
    const user = await authenticateUser(username, password);

    if (!user) {
      const attempts = (conv.failedAttempts || 0) + 1;

      if (attempts >= 3) {
        conversations.delete(userId);
        await tg.sendMessage(chatId,
          `🚫 *Demasiados intentos fallidos*\n\n` +
          `Espera 15 minutos antes de intentar de nuevo.`
        );
        return;
      }

      conversations.set(userId, {
        ...conv,
        state: 'awaiting_username',
        username: null,
        failedAttempts: attempts,
        timestamp: Date.now()
      });

      await tg.sendMessage(chatId,
        `❌ *Credenciales incorrectas* (intento ${attempts}/3)\n\n` +
        `Ingresa tu usuario de nuevo:`
      );
      return;
    }

    // ✅ Autenticación exitosa
    conversations.delete(userId);
    sessions.set(userId, {
      xvnnUserId: user.id,
      username: user.username,
      name: user.name,
      authenticatedAt: Date.now()
    });

    // Guardar sesión en BD
    await run(`
      INSERT INTO telegram_sessions (telegram_user_id, xvnn_user_id, xvnn_username, state)
      VALUES ($1, $2, $3, 'authenticated')
      ON CONFLICT (telegram_user_id) 
      DO UPDATE SET 
        xvnn_user_id = EXCLUDED.xvnn_user_id,
        xvnn_username = EXCLUDED.xvnn_username,
        last_activity = NOW()
    `, [userId, user.id, user.username]).catch(err => {
      console.error('Error guardando sesión:', err.message);
    });

    await tg.sendMessage(chatId,
      `✅ *¡Autenticado correctamente!*\n\n` +
      `👤 Usuario: *${escapeMd(user.name || user.username)}*\n` +
      `📛 @${escapeMd(user.username)}\n\n` +
      `📤 *Ahora envíame un enlace directo al video* que quieras publicar.\n\n` +
      `⚡ *Formatos:* MP4, WebM, MOV, MKV\n` +
      `📏 *Tamaño máximo:* ${CONFIG.telegram.maxLinkDownloadMB} MB\n\n` +
      `💡 Usa /help para ver todos los comandos.`
    );
    return;
  }

  // ============ DETECTAR ENLACE (solo si está autenticado) ============
  const urlMatch = text.match(/https?:\/\/[^\s]+/i);
  if (urlMatch) {
    if (!session) {
      await tg.sendMessage(chatId,
        `🔒 *Primero debes iniciar sesión*\n\n` +
        `Usa /start para autenticarte.`
      );
      return;
    }
    await handleLinkMessage(msg, urlMatch[0], session);
    return;
  }

  // ============ CUALQUIER OTRO TEXTO ============
  if (text && !text.startsWith('/')) {
    if (!session) {
      await tg.sendMessage(chatId, `🔒 Usa /start para iniciar sesión.`);
      return;
    }

    await tg.sendMessage(chatId,
      `📤 Envíame un *enlace directo* a un video.\n\n` +
      `Ejemplo: \`https://ejemplo.com/video.mp4\``
    );
  }
}

// ============================================================
//  MANEJO DEL ENLACE
// ============================================================
async function handleLinkMessage(msg, url, session) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  await tg.sendChatAction(chatId, 'typing');

  const tempMsg = await tg.sendMessage(chatId,
    `🔍 *Verificando enlace...*\n\n\`${escapeMd(url.slice(0, 80))}${url.length > 80 ? '...' : ''}\``
  );

  try {
    const info = await validateVideoUrl(url);

    conversations.set(userId, {
      state: 'awaiting_category',
      username: session.username,
      xvnnUserId: session.xvnnUserId,
      videoData: info,
      tempMessageId: tempMsg.message_id,
      timestamp: Date.now(),
      chatId
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

  const session = sessions.get(userId);
  const conv = conversations.get(userId);

  if (!session) {
    await tg.answerCallbackQuery(query.id, '🔒 Sesión expirada');
    await tg.editMessageText(chatId, messageId,
      '🔒 *Sesión expirada*\n\nUsa /start para volver a iniciar sesión.'
    );
    return;
  }

  if (data === 'cancel_upload') {
    conversations.delete(userId);
    await tg.answerCallbackQuery(query.id, 'Cancelado');
    await tg.editMessageText(chatId, messageId, '❌ Operación cancelada.');
    return;
  }

  if (data.startsWith('cat:')) {
    const category = data.replace('cat:', '');

    if (!conv || conv.state !== 'awaiting_category') {
      await tg.answerCallbackQuery(query.id, '⚠️ Enlace expirado');
      await tg.editMessageText(chatId, messageId,
        '⚠️ El enlace expiró. Envíame uno nuevo.'
      );
      return;
    }

    conversations.delete(userId);
    await tg.answerCallbackQuery(query.id, `✅ ${category}`);

    processVideo(session, conv.videoData, category, chatId, messageId)
      .catch(err => console.error('❌ Error en processVideo:', err));
  }
}

// ============================================================
//  PROCESAMIENTO COMPLETO
// ============================================================
async function processVideo(session, videoData, category, chatId, messageId) {
  const tmpDir = path.join(os.tmpdir(), `xvnn-${crypto.randomBytes(8).toString('hex')}`);
  const tmpVideoPath = path.join(tmpDir, 'video' + path.extname(videoData.filename || '.mp4'));
  const tmpThumbPath = path.join(tmpDir, 'thumb.jpg');

  let videoId = null;

  try {
    fs.mkdirSync(tmpDir, { recursive: true });

    // ============ 1. DESCARGA ============
    await updateProgress(chatId, messageId, 0, '📥 Descargando video...');

    let lastReported = -1;
    const { size: downloadedSize } = await downloadToFile(
      videoData.url,
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
    const ext = path.extname(videoData.filename || '.mp4').toLowerCase() || '.mp4';
    const vKey = `videos/${videoId}/original${ext}`;

    const videoBuffer = fs.readFileSync(tmpVideoPath);
    await uploadFile(vKey, videoBuffer, videoData.contentType || 'video/mp4');

    await updateProgress(chatId, messageId, 38, '📸 Extrayendo miniatura...');

    // ============ 3. THUMBNAIL ============
    const tKey = `videos/${videoId}/thumb.jpg`;

    try {
      await extractThumbnail(tmpVideoPath, tmpThumbPath);
      const thumbBuffer = fs.readFileSync(tmpThumbPath);
      await uploadFile(tKey, thumbBuffer, 'image/jpeg');
      console.log(`✅ Thumbnail subido: ${tKey}`);
    } catch (thumbErr) {
      console.warn('⚠️  Error extrayendo thumbnail:', thumbErr.message);
      // Placeholder JPEG mínimo válido
      const minimalJPG = Buffer.from([
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
      await uploadFile(tKey, minimalJPG, 'image/jpeg');
    }

    await updateProgress(chatId, messageId, 42, '💾 Guardando metadatos...');

    // ============ 4. INSERT EN BD ============
    // IMPORTANTE: user_id es el UUID del usuario REAL de XVNN
    await run(`
      INSERT INTO videos
        (id, user_id, title, description, category, filename, thumbnail,
         duration, size, video_type, processing_status,
         telegram_user_id, telegram_username, telegram_chat_id, telegram_progress_message_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
    `, [
      videoId,
      session.xvnnUserId,   // ← Usuario REAL de XVNN
      cleanFilename(videoData.filename),
      `Subido vía Telegram`,
      category,
      vKey,
      tKey,
      0,
      downloadedSize,
      'mp4',
      'processing',
      chatId,               // telegram_user_id (chatId es igual en privado)
      session.username,
      chatId,
      messageId
    ]);

    await updateProgress(chatId, messageId, 45, '🎞 Transcodificando a HLS...');

    // ============ 5. TRANSCODIFICAR ============
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

    // ============ 6. ACTUALIZAR BD ============
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

    // ============ 7. MENSAJE FINAL ============
    const webUrl = `${CONFIG.server.baseUrl}/watch.html?id=${videoId}`;
    const profileUrl = `${CONFIG.server.baseUrl}/profile.html`;
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
          inline_keyboard: [
            [{ text: '▶️ Ver video', url: webUrl }],
            [{ text: '👤 Mi perfil', url: profileUrl }]
          ]
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
    try {
      if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    } catch (cleanupErr) {
      console.error('⚠️  Error limpiando temporales:', cleanupErr.message);
    }
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
    { command: 'start',  description: 'Iniciar sesión / Publicar' },
    { command: 'help',   description: 'Ayuda' },
    { command: 'stats',  description: 'Mis estadísticas' },
    { command: 'cancel', description: 'Cancelar operación' },
    { command: 'logout', description: 'Cerrar sesión' }
  ]);

  // Cargar sesiones existentes desde BD (por si el bot se reinicia)
  try {
    const rows = await get('SELECT 1');  // test de conexión
    const existing = await get(
      `SELECT telegram_user_id, xvnn_user_id, xvnn_username 
       FROM telegram_sessions 
       WHERE last_activity > NOW() - INTERVAL '30 days'`
    ).catch(() => null);

    if (existing && Array.isArray(existing)) {
      for (const row of existing) {
        sessions.set(Number(row.telegram_user_id), {
          xvnnUserId: row.xvnn_user_id,
          username: row.xvnn_username,
          authenticatedAt: Date.now()
        });
      }
      console.log(`🔄 ${sessions.size} sesiones restauradas desde BD`);
    }
  } catch (err) {
    // Ignorar errores de carga inicial
  }

  console.log('✅ Bot de Telegram iniciado (con autenticación)');
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