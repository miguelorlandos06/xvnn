// services/telegramBot.js
// ============================================================
//  BOT DE TELEGRAM PARA XVNN
// ============================================================

import crypto from 'crypto';
import path from 'path';
import bcrypt from 'bcryptjs';
import { CONFIG } from '../config.js';
import { run, get, all } from '../database.js';
import { transcodeToHLS, extractThumbnail } from './transloadit.js';

// ============================================================
//  CONFIG
// ============================================================
const TOKEN = CONFIG.telegram.botToken;
const API_ROOT = 'https://api.telegram.org';
const API_URL = `${API_ROOT}/bot${TOKEN}`;
const FILE_API = `${API_ROOT}/file/bot${TOKEN}`;

// ============================================================
//  ESTADO EN MEMORIA
// ============================================================
const conversations = new Map();
const sessions = new Map();

let offset = 0;
let running = false;

const MAX_FAILED_ATTEMPTS = 3;
const CONVERSATION_TTL = 30 * 60 * 1000;
const MAX_URLS_PER_FILE = CONFIG.telegram.maxUrlsPerFile || 50;

// ============================================================
//  LIMPIEZA PERIÓDICA
// ============================================================
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of conversations.entries()) {
    if (now - v.timestamp > CONVERSATION_TTL) conversations.delete(k);
  }
}, 5 * 60 * 1000);

// ============================================================
//  UTILS
// ============================================================
function escapeMd(text) {
  return String(text).replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

function formatDuration(seconds) {
  if (!seconds) return '—';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}m ${s}s`;
}

function formatMB(bytes) {
  return (bytes / 1024 / 1024).toFixed(1);
}

function cleanFilename(filename) {
  return String(filename || 'Video')
    .replace(/\.[^.]+$/, '')
    .replace(/[_-]/g, ' ')
    .trim()
    .slice(0, 200) || 'Video';
}

// ============================================================
//  BOT API
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
    apiCall('sendMessage', {
      chat_id: chatId, text, parse_mode: 'Markdown',
      disable_web_page_preview: true, ...opts
    }),

  editMessageText: (chatId, messageId, text, opts = {}) =>
    apiCall('editMessageText', {
      chat_id: chatId, message_id: messageId, text, parse_mode: 'Markdown',
      disable_web_page_preview: true, ...opts
    }).catch(() => null),

  answerCallbackQuery: (id, text = '') =>
    apiCall('answerCallbackQuery', { callback_query_id: id, text }).catch(() => null),

  setMyCommands: (commands) => apiCall('setMyCommands', { commands }).catch(() => null),

  sendChatAction: (chatId, action = 'typing') =>
    apiCall('sendChatAction', { chat_id: chatId, action }).catch(() => {}),

  getFile: (fileId) => apiCall('getFile', { file_id: fileId })
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
//  DESCARGAR .TXT DE TELEGRAM
// ============================================================
async function getTelegramFileContent(fileId) {
  const fileInfo = await tg.getFile(fileId);
  if (!fileInfo.file_path) throw new Error('No se pudo obtener el archivo');

  const url = `${FILE_API}/${fileInfo.file_path}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  return await res.text();
}

// ============================================================
//  VALIDAR URL
// ============================================================
const ALLOWED_EXTENSIONS = ['.mp4', '.webm', '.mov', '.mkv', '.avi', '.m4v'];
const ALLOWED_MIMES = [
  'video/mp4', 'video/webm', 'video/quicktime', 'video/x-matroska',
  'video/x-msvideo', 'video/x-m4v', 'application/octet-stream'
];

async function validateVideoUrl(url) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('Enlace inválido'); }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Solo http:// o https://');
  }

  const hostname = parsed.hostname.toLowerCase();
  if (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname.startsWith('192.168.') ||
    hostname.startsWith('10.') ||
    hostname.match(/^172\.(1[6-9]|2[0-9]|3[0-1])\./)
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
    throw new Error(`No se pudo acceder: ${err.message}`);
  }

  if (!head.ok) throw new Error(`Servidor respondió ${head.status}`);

  const contentType = (head.headers.get('content-type') || '').toLowerCase();
  const contentLength = parseInt(head.headers.get('content-length') || '0', 10);

  const isVideoMime = ALLOWED_MIMES.some(m => contentType.startsWith(m));
  const isVideoExt = ALLOWED_EXTENSIONS.some(ext => parsed.pathname.toLowerCase().endsWith(ext));

  if (!isVideoMime && !isVideoExt) {
    throw new Error(`No parece un video (tipo: ${contentType || 'desconocido'})`);
  }

  const maxBytes = CONFIG.telegram.maxLinkDownloadMB * 1024 * 1024;
  if (contentLength > maxBytes) {
    throw new Error(`Pesa ${formatMB(contentLength)} MB, límite ${CONFIG.telegram.maxLinkDownloadMB} MB`);
  }

  return {
    url,
    contentType,
    contentLength,
    filename: path.basename(parsed.pathname) || 'video.mp4'
  };
}

// ============================================================
//  AUTENTICACIÓN
// ============================================================
async function authenticateUser(username, password) {
  const user = await get(
    'SELECT id, name, username, password FROM users WHERE LOWER(username) = LOWER($1)',
    [username]
  );

  if (!user) return null;

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return null;

  return { id: user.id, name: user.name, username: user.username };
}

// ============================================================
//  MANEJO PRINCIPAL
// ============================================================
async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = (msg.text || '').trim();
  const conv = conversations.get(userId);
  const session = sessions.get(userId);

  // ============ COMANDOS ============
  if (text.startsWith('/start')) return handleStart(msg, session);
  if (text.startsWith('/help')) return handleHelp(msg, session);
  if (text.startsWith('/logout')) return handleLogout(msg, session);
  if (text.startsWith('/cancel')) return handleCancelCommand(msg);
  if (text.startsWith('/new')) return handleNewVideo(msg, session);
  if (text.startsWith('/stats')) return handleStats(msg, session);

  // ============ ARCHIVO .TXT ============
  if (msg.document) return handleDocument(msg, session);

  // ============ ESTADOS ============
  if (conv) {
    switch (conv.state) {
      case 'awaiting_username': return handleUsernameInput(msg, conv);
      case 'awaiting_password': return handlePasswordInput(msg, conv);
      case 'awaiting_link': return handleLinkInput(msg, conv);
    }
  }

  // ============ TEXTO GENÉRICO ============
  if (text && !text.startsWith('/')) {
    if (!session) {
      return tg.sendMessage(chatId, `Usa /start para iniciar sesión.`);
    }
    return tg.sendMessage(chatId,
      `Usa /new para publicar un video, o /help para ver los comandos.`
    );
  }
}

// ============================================================
//  /start
// ============================================================
async function handleStart(msg, session) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (session) {
    return tg.sendMessage(chatId,
      `Hola de nuevo, *${escapeMd(session.name || session.username)}*\n\n` +
      `*Comandos:*\n` +
      `/new — Publicar video\n` +
      `/stats — Tus estadísticas\n` +
      `/help — Ayuda\n` +
      `/logout — Cerrar sesión`
    );
  }

  conversations.set(userId, {
    state: 'awaiting_username',
    timestamp: Date.now(),
    chatId,
    failedAttempts: 0
  });

  await tg.sendMessage(chatId,
    `*Bienvenido a XVNN*\n\n` +
    `Para publicar videos necesitas iniciar sesión.\n\n` +
    `Ingresa tu usuario:`
  );
}

// ============================================================
//  /help
// ============================================================
async function handleHelp(msg, session) {
  const chatId = msg.chat.id;

  if (!session) {
    return tg.sendMessage(chatId, `Primero debes autenticarte. Usa /start`);
  }

  await tg.sendMessage(chatId,
    `*Ayuda XVNN*\n\n` +
    `*Publicar video:*\n` +
    `/new — Envía un enlace directo\n` +
    `O envía un archivo .txt con varios enlaces\n\n` +
    `*Otros:*\n` +
    `/stats — Tus estadísticas\n` +
    `/cancel — Cancelar operación\n` +
    `/logout — Cerrar sesión\n\n` +
    `*Límite:* ${CONFIG.telegram.maxLinkDownloadMB} MB por video`
  );
}

// ============================================================
//  /logout
// ============================================================
async function handleLogout(msg, session) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  sessions.delete(userId);
  conversations.delete(userId);

  await run(
    'DELETE FROM telegram_sessions WHERE telegram_user_id = $1',
    [userId]
  ).catch(() => {});

  await tg.sendMessage(chatId, `Sesión cerrada.\n\nUsa /start para volver.`);
}

// ============================================================
//  /cancel
// ============================================================
async function handleCancelCommand(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (conversations.has(userId)) {
    conversations.delete(userId);
    await tg.sendMessage(chatId, 'Operación cancelada.');
  } else {
    await tg.sendMessage(chatId, 'No hay nada que cancelar.');
  }
}

// ============================================================
//  /stats
// ============================================================
async function handleStats(msg, session) {
  const chatId = msg.chat.id;

  if (!session) return tg.sendMessage(chatId, `Usa /start para iniciar sesión`);

  try {
    const stats = await get(`
      SELECT 
        COUNT(*)::int AS total,
        COALESCE(SUM(views), 0)::int AS views,
        COALESCE(SUM(likes), 0)::int AS likes
      FROM videos
      WHERE user_id = $1
    `, [session.xvnnUserId]);

    await tg.sendMessage(chatId,
      `*Tus estadísticas*\n\n` +
      `Videos subidos: *${stats.total}*\n` +
      `Vistas totales: *${stats.views}*\n` +
      `Likes totales: *${stats.likes}*`
    );

  } catch (err) {
    console.error('Error stats:', err);
    await tg.sendMessage(chatId, 'Error obteniendo estadísticas');
  }
}

// ============================================================
//  /new
// ============================================================
async function handleNewVideo(msg, session) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (!session) return tg.sendMessage(chatId, `Usa /start para iniciar sesión`);

  conversations.set(userId, {
    state: 'awaiting_link',
    timestamp: Date.now(),
    chatId
  });

  await tg.sendMessage(chatId,
    `*Publicar video*\n\n` +
    `Envía el *enlace directo* al video (.mp4, .webm, .mov, .mkv)\n\n` +
    `Ejemplo:\n` +
    `\`https://ejemplo.com/video.mp4\``
  );
}

// ============================================================
//  INPUT: USUARIO
// ============================================================
async function handleUsernameInput(msg, conv) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const username = (msg.text || '').trim();

  if (!username || username.length < 3 || !/^[a-zA-Z0-9_]+$/.test(username)) {
    return tg.sendMessage(chatId,
      `Usuario inválido (mín. 3, solo letras/números/_).\n\nIntenta de nuevo:`
    );
  }

  conversations.set(userId, {
    ...conv,
    state: 'awaiting_password',
    username,
    timestamp: Date.now()
  });

  await tg.sendMessage(chatId, `Ingresa tu contraseña:`);
}

// ============================================================
//  INPUT: CONTRASEÑA
// ============================================================
async function handlePasswordInput(msg, conv) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  const text = (msg.text || '').trim();
  if (text.startsWith('/')) return;

  const password = text;
  const username = conv.username;

  if (!password || password.length < 6) {
    conversations.set(userId, {
      ...conv,
      state: 'awaiting_password',
      timestamp: Date.now()
    });
    return tg.sendMessage(chatId, `Contraseña muy corta (mín. 6).\n\nIntenta de nuevo:`);
  }

  const user = await authenticateUser(username, password);

  if (!user) {
    const attempts = (conv.failedAttempts || 0) + 1;

    if (attempts >= MAX_FAILED_ATTEMPTS) {
      conversations.delete(userId);
      return tg.sendMessage(chatId, `Demasiados intentos. Usa /start de nuevo.`);
    }

    conversations.set(userId, {
      ...conv,
      state: 'awaiting_username',
      username: null,
      failedAttempts: attempts,
      timestamp: Date.now()
    });

    return tg.sendMessage(chatId,
      `Credenciales incorrectas (${attempts}/${MAX_FAILED_ATTEMPTS}).\n\nUsuario:`
    );
  }

  conversations.delete(userId);
  sessions.set(userId, {
    xvnnUserId: user.id,
    username: user.username,
    name: user.name,
    telegramUserId: userId,
    authenticatedAt: Date.now()
  });

  await run(`
    INSERT INTO telegram_sessions (telegram_user_id, xvnn_user_id, xvnn_username, state)
    VALUES ($1, $2, $3, 'authenticated')
    ON CONFLICT (telegram_user_id) 
    DO UPDATE SET 
      xvnn_user_id = EXCLUDED.xvnn_user_id,
      xvnn_username = EXCLUDED.xvnn_username,
      last_activity = NOW()
  `, [userId, user.id, user.username]).catch(() => {});

  await tg.sendMessage(chatId,
    `*Autenticado correctamente*\n\n` +
    `Usuario: *${escapeMd(user.name || user.username)}*\n` +
    `@${escapeMd(user.username)}\n\n` +
    `Usa /new para publicar un video.`
  );
}

// ============================================================
//  INPUT: ENLACE
// ============================================================
async function handleLinkInput(msg, conv) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const url = (msg.text || '').trim();

  if (!url.startsWith('http')) {
    return tg.sendMessage(chatId, `Enlace inválido.\n\nIntenta de nuevo:`);
  }

  const tempMsg = await tg.sendMessage(chatId, `Verificando enlace...`);

  try {
    const info = await validateVideoUrl(url);

    conversations.set(userId, {
      ...conv,
      state: 'awaiting_category',
      videoInfo: info,
      timestamp: Date.now()
    });

    const keyboard = {
      inline_keyboard: [
        [
          { text: 'Hetero', callback_data: 'cat:Hetero' },
          { text: 'Gay', callback_data: 'cat:Gay' }
        ],
        [
          { text: 'Bi', callback_data: 'cat:Bi' },
          { text: 'Trans', callback_data: 'cat:Trans' }
        ],
        [
          { text: 'Cancelar', callback_data: 'cancel_upload' }
        ]
      ]
    };

    await tg.editMessageText(chatId, tempMsg.message_id,
      `*Video detectado*\n\n` +
      `Archivo: \`${escapeMd(info.filename)}\`\n` +
      `Tamaño: ${formatMB(info.contentLength)} MB\n\n` +
      `Selecciona la categoría:`,
      { reply_markup: keyboard }
    );

  } catch (err) {
    await tg.editMessageText(chatId, tempMsg.message_id,
      `Error: ${escapeMd(err.message)}\n\nIntenta con otro enlace:`
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
    await tg.answerCallbackQuery(query.id, 'Sesión expirada');
    return tg.editMessageText(chatId, messageId,
      'Sesión expirada.\n\nUsa /start para volver a iniciar sesión.'
    );
  }

  // ============ CANCELAR ============
  if (data === 'cancel_upload') {
    conversations.delete(userId);
    await tg.answerCallbackQuery(query.id, 'Cancelado');
    return tg.editMessageText(chatId, messageId, 'Operación cancelada.');
  }

  // ============ CATEGORÍA INDIVIDUAL ============
  if (data.startsWith('cat:')) {
    const category = data.replace('cat:', '');

    if (!conv || conv.state !== 'awaiting_category') {
      await tg.answerCallbackQuery(query.id, 'Enlace expirado');
      return tg.editMessageText(chatId, messageId,
        'El enlace expiró. Envíame uno nuevo con /new.'
      );
    }

    conversations.delete(userId);
    await tg.answerCallbackQuery(query.id, `Categoría: ${category}`);

    processVideoFlow(chatId, query.from, conv, category, messageId)
      .catch(err => console.error('Error processVideoFlow:', err));
  }

  // ============ CATEGORÍA BATCH ============
  if (data.startsWith('batch:')) {
    const category = data.replace('batch:', '');

    if (!conv || conv.state !== 'awaiting_batch_category') {
      await tg.answerCallbackQuery(query.id, 'Operación expirada');
      return tg.editMessageText(chatId, messageId,
        'La operación expiró. Envía el archivo de nuevo.'
      );
    }

    conversations.delete(userId);
    await tg.answerCallbackQuery(query.id, `Categoría: ${category}`);

    processBatch(chatId, query.from, conv.urls, category, messageId)
      .catch(err => console.error('Error batch:', err));
  }
}

// ============================================================
//  PROCESAR VIDEO INDIVIDUAL
// ============================================================
async function processVideoFlow(chatId, from, conv, category, messageId) {
  const session = sessions.get(from.id);
  const videoInfo = conv.videoInfo;

  const videoId = crypto.randomUUID();
  const startTime = Date.now();

  try {
    // 1. Transcodificar con Transloadit
    const hlsResult = await transcodeToHLS(videoInfo.url, videoId, (pct, stage) => {
      const filled = Math.round(pct / 10);
      const bar = '▰'.repeat(filled) + '▱'.repeat(10 - filled);
      const stageText = stage === 'transcoding'
        ? 'Transcodificando en la nube'
        : 'Subiendo a ToDus';
      tg.editMessageText(chatId, messageId,
        `*Procesando video*\n\n` +
        `${bar} ${pct}%\n` +
        `${stageText}...`
      ).catch(() => {});
    });

    // 2. Thumbnail
    await tg.editMessageText(chatId, messageId,
      `*Procesando video*\n\nGenerando miniatura...`
    ).catch(() => {});

    let thumbnailUrl = null;
    try {
      thumbnailUrl = await extractThumbnail(videoInfo.url, videoId);
    } catch (thumbErr) {
      console.warn('Thumbnail falló:', thumbErr.message);
    }

    // 3. Guardar en BD
    await tg.editMessageText(chatId, messageId,
      `*Procesando video*\n\nGuardando en base de datos...`
    ).catch(() => {});

    const title = cleanFilename(videoInfo.filename);

    await run(`
      INSERT INTO videos
        (id, user_id, title, description, category, filename, thumbnail,
         duration, size, video_type, processing_status,
         telegram_user_id, telegram_username, telegram_chat_id, telegram_message_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
    `, [
      videoId,
      session.xvnnUserId,
      title,
      `Subido vía Telegram`,
      category,
      hlsResult.masterKey,
      thumbnailUrl ? extractKey(thumbnailUrl) : '',
      hlsResult.duration || 0,
      videoInfo.contentLength || 0,
      'hls',
      'ready',
      session.telegramUserId,
      session.username,
      chatId,
      messageId
    ]);

    // 4. Mensaje final
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    const webUrl = `${CONFIG.server.baseUrl}/watch.html?id=${videoId}`;

    await tg.editMessageText(chatId, messageId,
      `*Video publicado*\n\n` +
      `Categoría: *${category}*\n` +
      `Título: *${escapeMd(title)}*\n` +
      `Duración: ${formatDuration(hlsResult.duration)}\n` +
      `Archivos HLS: ${hlsResult.totalFiles}\n` +
      `Tiempo: ${formatDuration(elapsed)}\n\n` +
      `Ya está disponible en la web`,
      {
        reply_markup: {
          inline_keyboard: [[
            { text: 'Ver video', url: webUrl }
          ]]
        }
      }
    );

  } catch (err) {
    console.error('Error procesando:', err);

    await run(
      'UPDATE videos SET processing_status = $1 WHERE id = $2',
      ['failed', videoId]
    ).catch(() => {});

    await tg.editMessageText(chatId, messageId,
      `*Error procesando el video*\n\n` +
      `${escapeMd(err.message)}\n\n` +
      `Verifica que el enlace siga activo.`
    );
  }
}

// ============================================================
//  ARCHIVO .TXT CON MÚLTIPLES ENLACES
// ============================================================
async function handleDocument(msg, session) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const doc = msg.document;

  if (!session) return tg.sendMessage(chatId, `Primero inicia sesión con /start`);

  const isTxt = doc.mime_type === 'text/plain' ||
                doc.file_name?.toLowerCase().endsWith('.txt');

  if (!isTxt) {
    return tg.sendMessage(chatId, `Solo acepto archivos .txt con enlaces.`);
  }

  await tg.sendChatAction(chatId, 'typing');

  const tempMsg = await tg.sendMessage(chatId, `Descargando archivo...`);

  try {
    const content = await getTelegramFileContent(doc.file_id);

    const urlRegex = /https?:\/\/[^\s<>"'\)\]]+/gi;
    const rawUrls = content.match(urlRegex) || [];
    const uniqueUrls = [...new Set(rawUrls)];

    if (uniqueUrls.length === 0) {
      await tg.editMessageText(chatId, tempMsg.message_id,
        `No encontré enlaces en el archivo.`
      );
      return;
    }

    if (uniqueUrls.length > MAX_URLS_PER_FILE) {
      await tg.editMessageText(chatId, tempMsg.message_id,
        `Demasiados enlaces (${uniqueUrls.length}). Máximo: ${MAX_URLS_PER_FILE}`
      );
      return;
    }

    conversations.set(userId, {
      state: 'awaiting_batch_category',
      username: session.username,
      xvnnUserId: session.xvnnUserId,
      urls: uniqueUrls,
      tempMessageId: tempMsg.message_id,
      timestamp: Date.now(),
      chatId
    });

    const keyboard = {
      inline_keyboard: [
        [
          { text: 'Hetero', callback_data: 'batch:Hetero' },
          { text: 'Gay', callback_data: 'batch:Gay' }
        ],
        [
          { text: 'Bi', callback_data: 'batch:Bi' },
          { text: 'Trans', callback_data: 'batch:Trans' }
        ],
        [
          { text: 'Cancelar', callback_data: 'cancel_upload' }
        ]
      ]
    };

    await tg.editMessageText(chatId, tempMsg.message_id,
      `*${uniqueUrls.length} enlaces detectados*\n\nElige la categoría:`,
      { reply_markup: keyboard }
    );

  } catch (err) {
    console.error('Error procesando .txt:', err);
    await tg.editMessageText(chatId, tempMsg.message_id,
      `Error: ${escapeMd(err.message)}`
    );
  }
}

// ============================================================
//  PROCESAR BATCH
// ============================================================
async function processBatch(chatId, from, urls, category, messageId) {
  const session = sessions.get(from.id);
  const total = urls.length;
  const results = { success: [], failed: [] };
  const startTime = Date.now();

  await tg.editMessageText(chatId, messageId,
    `*Procesando ${total} videos*\n\n` +
    `Publicados: 0\nEn cola: ${total}`
  );

  for (let i = 0; i < total; i++) {
    const url = urls[i];
    const index = i + 1;
    const remaining = total - i - 1;

    try {
      const info = await validateVideoUrl(url);

      await tg.editMessageText(chatId, messageId,
        `*Procesando ${index}/${total}*\n\n` +
        `\`${escapeMd(info.filename.slice(0, 40))}\`\n` +
        `${formatMB(info.contentLength)} MB\n\n` +
        `Publicados: ${results.success.length}\n` +
        `Fallidos: ${results.failed.length}\n` +
        `En cola: ${remaining}`
      );

      const videoId = crypto.randomUUID();
      const hlsResult = await transcodeToHLS(url, videoId, () => {});

      let thumbnailUrl = null;
      try {
        thumbnailUrl = await extractThumbnail(url, videoId);
      } catch {}

      const title = cleanFilename(info.filename);

      await run(`
        INSERT INTO videos
          (id, user_id, title, description, category, filename, thumbnail,
           duration, size, video_type, processing_status,
           telegram_user_id, telegram_username)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      `, [
        videoId,
        session.xvnnUserId,
        title,
        `Subido vía Telegram (batch)`,
        category,
        hlsResult.masterKey,
        thumbnailUrl ? extractKey(thumbnailUrl) : '',
        hlsResult.duration || 0,
        info.contentLength || 0,
        'hls',
        'ready',
        session.telegramUserId,
        session.username
      ]);

      results.success.push({ url, title });

    } catch (err) {
      console.error(`Error con ${url}:`, err.message);
      results.failed.push({ url, error: err.message });
    }
  }

  const elapsed = Math.round((Date.now() - startTime) / 1000);

  let finalMessage =
    `*Cola completada*\n\n` +
    `Publicados: *${results.success.length}*\n` +
    `Fallidos: *${results.failed.length}*\n` +
    `Categoría: *${category}*\n` +
    `Tiempo: ${formatDuration(elapsed)}\n\n`;

  if (results.failed.length > 0) {
    finalMessage += `*Fallidos:*\n`;
    results.failed.slice(0, 5).forEach(f => {
      const short = f.url.length > 40 ? '...' + f.url.slice(-40) : f.url;
      finalMessage += `\`${escapeMd(short)}\`\n`;
    });
  }

  await tg.editMessageText(chatId, messageId, finalMessage);
}

// ============================================================
//  HANDLE UPDATE
// ============================================================
async function handleUpdate(update) {
  try {
    if (update.message) await handleMessage(update.message);
    else if (update.callback_query) await handleCallbackQuery(update.callback_query);
  } catch (err) {
    console.error('Error en update:', err.message);
  }
}

// ============================================================
//  UTILS
// ============================================================
function extractKey(url) {
  if (!url) return '';
  const baseUrl = CONFIG.s3.baseUrl;
  if (url.startsWith(baseUrl)) {
    return url.slice(baseUrl.length + 1);
  }
  return url;
}

// ============================================================
//  START BOT
// ============================================================
export async function startTelegramBot() {
  if (!TOKEN || TOKEN.includes('TU_TOKEN') || TOKEN.includes('xxxx')) {
    console.warn('Bot desactivado (token no configurado)');
    return;
  }

  await apiCall('deleteWebhook', { drop_pending_updates: true }).catch(() => {});

  await tg.setMyCommands([
    { command: 'start', description: 'Iniciar sesión' },
    { command: 'new', description: 'Publicar video' },
    { command: 'stats', description: 'Mis estadísticas' },
    { command: 'help', description: 'Ayuda' },
    { command: 'cancel', description: 'Cancelar operación' },
    { command: 'logout', description: 'Cerrar sesión' }
  ]);

  // Restaurar sesiones
  try {
    const rows = await all(
      `SELECT telegram_user_id, xvnn_user_id, xvnn_username,
              (SELECT name FROM users WHERE id = ts.xvnn_user_id) AS name
       FROM telegram_sessions ts
       WHERE last_activity > NOW() - INTERVAL '30 days'`
    );

    for (const row of rows) {
      sessions.set(Number(row.telegram_user_id), {
        xvnnUserId: row.xvnn_user_id,
        username: row.xvnn_username,
        name: row.name || row.xvnn_username,
        telegramUserId: Number(row.telegram_user_id),
        authenticatedAt: Date.now()
      });
    }

    if (sessions.size > 0) {
      console.log(`${sessions.size} sesiones restauradas`);
    }
  } catch (err) {
    console.warn('No se restauraron sesiones:', err.message);
  }

  console.log('Bot de Telegram iniciado');
  running = true;

  while (running) {
    try {
      const updates = await getUpdates();
      for (const u of updates) {
        offset = u.update_id + 1;
        handleUpdate(u).catch(err =>
          console.error('Error en update:', err.message)
        );
      }
    } catch (err) {
      console.error('Error polling:', err.message);
      await new Promise(r => setTimeout(r, 500));
    }
  }
}

export function stopTelegramBot() {
  running = false;
}
