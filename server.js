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

// ============ ESTÁTICOS ============
app.use('/', express.static(path.join(__dirname, 'public')));

// ============ REDIRECCIÓN DE RAÍZ ============
app.get('/', (req, res) => {
  res.redirect('/auth.html');
});

// ============ RUTAS ============
app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/videos', videoRoutes);

// ============ HEALTH ============
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: Date.now() });
});

// ============ DEBUG FFMPEG (temporal) ============
app.get('/api/debug/ffmpeg', async (req, res) => {
  const info = {
    timestamp: new Date().toISOString(),
    env: {
      PATH: process.env.PATH,
      PWD: process.cwd(),
      NODE_ENV: process.env.NODE_ENV
    }
  };

  try {
    const { execSync } = await import('child_process');
    info.which_ffmpeg = execSync('which ffmpeg 2>&1 || echo "NOT_FOUND"', { encoding: 'utf-8' }).trim();
  } catch (e) {
    info.which_ffmpeg = 'ERROR: ' + e.message;
  }

  try {
    const { execSync } = await import('child_process');
    info.ffmpeg_version = execSync('ffmpeg -version 2>&1 | head -1 || echo "FAILED"', { encoding: 'utf-8' }).trim();
  } catch (e) {
    info.ffmpeg_version = 'ERROR: ' + e.message;
  }

  try {
    const { execSync } = await import('child_process');
    info.which_ffprobe = execSync('which ffprobe 2>&1 || echo "NOT_FOUND"', { encoding: 'utf-8' }).trim();
  } catch (e) {
    info.which_ffprobe = 'ERROR: ' + e.message;
  }

  try {
    const fs = await import('fs');
    info.paths_exist = {
      '/usr/bin/ffmpeg': fs.default.existsSync('/usr/bin/ffmpeg'),
      '/usr/local/bin/ffmpeg': fs.default.existsSync('/usr/local/bin/ffmpeg'),
      '/bin/ffmpeg': fs.default.existsSync('/bin/ffmpeg'),
      '/usr/bin/ffprobe': fs.default.existsSync('/usr/bin/ffprobe'),
      '/usr/local/bin/ffprobe': fs.default.existsSync('/usr/local/bin/ffprobe')
    };
  } catch (e) {
    info.paths_exist = 'ERROR: ' + e.message;
  }

  try {
    const fs = await import('fs');
    info.docker_env = {
      '/.dockerenv': fs.default.existsSync('/.dockerenv'),
      '/etc/alpine-release': fs.default.existsSync('/etc/alpine-release')
    };
  } catch (e) {}

  res.json(info);
});

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
      memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + ' MB'
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ============ 404 ============
app.use((req, res) => res.status(404).json({ message: 'Ruta no encontrada' }));

// ============ ERROR HANDLER ============
app.use((err, req, res, next) => {
  console.error('❌ Error:', err.message);
  if (err.code === 'LIMIT_FILE_SIZE')
    return res.status(413).json({ message: 'Archivo demasiado grande' });
  res.status(err.status || 500).json({ message: err.message || 'Error del servidor' });
});

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

    startTelegramBot();

  } catch (err) {
    console.error('❌ Error iniciando servidor:', err);
    process.exit(1);
  }
})();

// ============ GRACEFUL SHUTDOWN ============
process.on('SIGINT', () => {
  console.log('\n🛑 Cerrando...');
  stopTelegramBot();
  pool.end().then(() => process.exit(0));
});

process.on('SIGTERM', () => {
  stopTelegramBot();
  pool.end().then(() => process.exit(0));
});