// server.js
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

// ============ TRUST PROXY ============
app.set('trust proxy', 1);

// ============ MIDDLEWARES ============
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

app.use('/api/', rateLimit({
  windowMs: CONFIG.rateLimit.global.windowMs,
  max: CONFIG.rateLimit.global.max,
  standardHeaders: true,
  message: { message: 'Demasiadas peticiones' }
}));

const authLimiter = rateLimit({
  windowMs: CONFIG.rateLimit.auth.windowMs,
  max: CONFIG.rateLimit.auth.max,
  message: { message: 'Demasiados intentos' }
});

// Silenciar logs de health checks (evita spam)
app.use((req, res, next) => {
  if (req.path.startsWith('/api/health')) req.silent = true;
  next();
});

// ============ ARCHIVOS ESTÁTICOS ============
app.use('/', express.static(path.join(__dirname, 'public')));

// Redirección de raíz al login
app.get('/', (req, res) => {
  res.redirect('/auth.html');
});

// ============ RUTAS API ============
app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/videos', videoRoutes);

// ============ HEALTH CHECKS ============
// Endpoint ligero (para keep-alive interno)
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: Date.now() });
});

// Endpoint completo (para monitoreo)
app.get('/api/health/full', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({
      status: 'ok',
      service: 'XVNN API',
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
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ============ DEBUG FFMPEG ============
app.get('/api/debug/ffmpeg', async (req, res) => {
  const info = {
    timestamp: new Date().toISOString(),
    env: { PATH: process.env.PATH, PWD: process.cwd() }
  };

  try {
    const { execSync } = await import('child_process');
    info.which_ffmpeg = execSync('which ffmpeg 2>&1 || echo "NOT_FOUND"', { encoding: 'utf-8' }).trim();
  } catch (e) { info.which_ffmpeg = 'ERROR: ' + e.message; }

  try {
    const { execSync } = await import('child_process');
    info.ffmpeg_version = execSync('ffmpeg -version 2>&1 | head -1 || echo "FAILED"', { encoding: 'utf-8' }).trim();
  } catch (e) { info.ffmpeg_version = 'ERROR: ' + e.message; }

  try {
    const fs = await import('fs');
    info.paths_exist = {
      '/usr/bin/ffmpeg': fs.default.existsSync('/usr/bin/ffmpeg'),
      '/usr/bin/ffprobe': fs.default.existsSync('/usr/bin/ffprobe')
    };
  } catch (e) {}

  res.json(info);
});

// ============ 404 ============
app.use((req, res) => {
  res.status(404).json({ message: 'Ruta no encontrada' });
});

// ============ ERROR HANDLER ============
app.use((err, req, res, next) => {
  console.error('❌ Error:', err.message);
  if (err.code === 'LIMIT_FILE_SIZE')
    return res.status(413).json({ message: 'Archivo demasiado grande' });
  res.status(err.status || 500).json({ message: err.message || 'Error del servidor' });
});

// ============================================================
//  KEEP-ALIVE INTERNO
//  Ping al propio servidor cada 5 minutos para evitar
//  que Render duerma el Web Service por inactividad.
// ============================================================
const KEEP_ALIVE = {
  active: false,
  count: 0,
  lastPing: null,
  intervalMs: 5 * 60 * 1000,   // 5 minutos
  timer: null
};

function startKeepAlive() {
  // Solo en producción y solo en Render
  const isProduction = CONFIG.server.env === 'production';
  const isRender = !!(process.env.RENDER || process.env.RENDER_EXTERNAL_URL);

  if (!isProduction && !isRender) {
    console.log('⏰ Keep-alive desactivado (entorno de desarrollo)');
    return;
  }

  const baseUrl = process.env.RENDER_EXTERNAL_URL || CONFIG.server.baseUrl;
  const url = `${baseUrl.replace(/\/$/, '')}/api/health`;

  console.log(`⏰ Keep-alive activado: ${url} cada ${KEEP_ALIVE.intervalMs / 60000} min`);

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
        console.log(`⏰ Keep-alive OK #${KEEP_ALIVE.count} (${duration}ms)`);
      } else {
        console.warn(`⏰ Keep-alive respondió ${res.status} (${duration}ms)`);
      }
    } catch (err) {
      console.warn(`⏰ Keep-alive error: ${err.message}`);
    }
  };

  // Primer ping a los 60 segundos de arrancar
  setTimeout(ping, 60 * 1000);

  // Después cada 5 minutos
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

// ============ ARRANQUE ============
(async () => {
  try {
    await initDatabase();

    app.listen(PORT, '0.0.0.0', () => {
      console.log('');
      console.log('╔═══════════════════════════════════════╗');
      console.log('║        🎬  XVNN API SERVER            ║');
      console.log('╚═══════════════════════════════════════╝');
      console.log(`🚀 Servidor:   http://0.0.0.0:${PORT}`);
      console.log(`🗄️  PostgreSQL: ${CONFIG.postgres.database}`);
      console.log(`☁️  S3 Stream:  ${CONFIG.s3.baseUrl}`);
      console.log('');
    });

    // Arrancar el bot de Telegram
    startTelegramBot();

    // Arrancar el keep-alive
    startKeepAlive();

  } catch (err) {
    console.error('❌ Error iniciando servidor:', err);
    process.exit(1);
  }
})();

// ============ GRACEFUL SHUTDOWN ============
process.on('SIGINT', () => {
  console.log('\n🛑 Cerrando...');
  stopKeepAlive();
  stopTelegramBot();
  pool.end().then(() => process.exit(0));
});

process.on('SIGTERM', () => {
  stopKeepAlive();
  stopTelegramBot();
  pool.end().then(() => process.exit(0));
});