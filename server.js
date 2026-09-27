// server.js
// ============================================================
//  XVNN · Servidor Express principal
// ============================================================

import express from 'express';
import cors from 'cors';
import path from 'path';
import rateLimit from 'express-rate-limit';
import { fileURLToPath } from 'url';

import { CONFIG } from './config.js';
import { initDatabase, pool } from './database.js';
import { startTelegramBot, stopTelegramBot } from './services/telegramBot.js';
import authRoutes from './routes/auth.js';
import videoRoutes from './routes/videos.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = CONFIG.server.port;

// ============================================================
//  TRUST PROXY (Render usa proxy)
// ============================================================
app.set('trust proxy', 1);

// ============================================================
//  MIDDLEWARES GLOBALES
// ============================================================
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// ============================================================
//  RATE LIMITING
// ============================================================
const globalLimiter = rateLimit({
  windowMs: CONFIG.rateLimit.global.windowMs,
  max: CONFIG.rateLimit.global.max,
  standardHeaders: true,
  message: { message: 'Demasiadas peticiones, intenta más tarde' }
});

const authLimiter = rateLimit({
  windowMs: CONFIG.rateLimit.auth.windowMs,
  max: CONFIG.rateLimit.auth.max,
  message: { message: 'Demasiados intentos, espera 15 minutos' }
});

app.use('/api/', globalLimiter);

// ============================================================
//  ARCHIVOS ESTÁTICOS
// ============================================================
app.use('/', express.static(path.join(__dirname, 'public')));

// ============================================================
//  REDIRECCIÓN DE RAÍZ
// ============================================================
app.get('/', (req, res) => {
  res.redirect('/auth.html');
});

// ============================================================
//  RUTAS API
// ============================================================
app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/videos', videoRoutes);

// ============================================================
//  HEALTH CHECKS
// ============================================================

// Endpoint ligero (para UptimeRobot / keep-alive)
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    time: Date.now()
  });
});

// Endpoint completo
app.get('/api/health/full', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({
      status: 'ok',
      service: 'XVNN API',
      version: '2.0.0',
      brand: CONFIG.server.brand,
      database: 'connected',
      storage: CONFIG.s3.baseUrl,
      telegram: CONFIG.telegram.botToken.includes('TU_TOKEN') ? 'disabled' : 'enabled',
      uptime: Math.floor(process.uptime()) + 's',
      memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + ' MB',
      keepAlive: KEEP_ALIVE.active ? 'running' : 'disabled',
      pingsSent: KEEP_ALIVE.count,
      lastPing: KEEP_ALIVE.lastPing
    });
  } catch (err) {
    res.status(500).json({
      status: 'error',
      message: err.message
    });
  }
});

// ============================================================
//  404
// ============================================================
app.use((req, res) => {
  res.status(404).json({ message: 'Ruta no encontrada' });
});

// ============================================================
//  ERROR HANDLER
// ============================================================
app.use((err, req, res, next) => {
  console.error('Error:', err.message);
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ message: 'Archivo demasiado grande' });
  }
  res.status(err.status || 500).json({
    message: err.message || 'Error del servidor'
  });
});

// ============================================================
//  KEEP-ALIVE
//  Hace ping a su propio health check cada 5 min para evitar
//  que Render duerma el servicio (plan free).
// ============================================================
const KEEP_ALIVE = {
  active: false,
  count: 0,
  lastPing: null,
  intervalMs: 5 * 60 * 1000,
  timer: null
};

function startKeepAlive() {
  const isProduction = CONFIG.server.env === 'production';
  const isRender = !!(process.env.RENDER || process.env.RENDER_EXTERNAL_URL);

  if (!isProduction && !isRender) {
    console.log('Keep-alive desactivado (entorno de desarrollo)');
    return;
  }

  const baseUrl = process.env.RENDER_EXTERNAL_URL || CONFIG.server.baseUrl;
  const url = `${baseUrl.replace(/\/$/, '')}/api/health`;

  console.log(`Keep-alive activado: ${url} cada ${KEEP_ALIVE.intervalMs / 60000} min`);

  const ping = async () => {
    try {
      const start = Date.now();
      const res = await fetch(url, {
        method: 'GET',
        headers: { 'User-Agent': 'XVNN-KeepAlive/1.0' },
        signal: AbortSignal.timeout(30000)
      });
      const duration = Date.now() - start;

      KEEP_ALIVE.count++;
      KEEP_ALIVE.lastPing = new Date().toISOString();

      if (res.ok) {
        console.log(`Keep-alive OK #${KEEP_ALIVE.count} (${duration}ms)`);
      } else {
        console.warn(`Keep-alive respondió ${res.status} (${duration}ms)`);
      }
    } catch (err) {
      console.warn(`Keep-alive error: ${err.message}`);
    }
  };

  // Primer ping a los 60 segundos
  setTimeout(ping, 60 * 1000);

  // Luego cada 5 minutos
  KEEP_ALIVE.timer = setInterval(ping, KEEP_ALIVE.intervalMs);
  KEEP_ALIVE.active = true;
}

function stopKeepAlive() {
  if (KEEP_ALIVE.timer) {
    clearInterval(KEEP_ALIVE.timer);
    KEEP_ALIVE.timer = null;
    KEEP_ALIVE.active = false;
  }
}

// ============================================================
//  ARRANQUE
// ============================================================
(async () => {
  try {
    // 1. Inicializar base de datos
    await initDatabase();

    // 2. Arrancar servidor HTTP
    app.listen(PORT, '0.0.0.0', () => {
      console.log('');
      console.log('=======================================');
      console.log('        XVNN API SERVER v2.0');
      console.log('=======================================');
      console.log(`Servidor:   http://0.0.0.0:${PORT}`);
      console.log(`Marca:      ${CONFIG.server.brand}`);
      console.log(`Storage:    ${CONFIG.s3.baseUrl}`);
      console.log('');
    });

    // 3. Arrancar bot de Telegram
    startTelegramBot();

    // 4. Arrancar keep-alive
    startKeepAlive();

  } catch (err) {
    console.error('Error iniciando servidor:', err);
    process.exit(1);
  }
})();

// ============================================================
//  GRACEFUL SHUTDOWN
// ============================================================
process.on('SIGINT', () => {
  console.log('\nCerrando...');
  stopKeepAlive();
  stopTelegramBot();
  pool.end().then(() => process.exit(0));
});

process.on('SIGTERM', () => {
  stopKeepAlive();
  stopTelegramBot();
  pool.end().then(() => process.exit(0));
});
