// config.js
// ============================================================
//  ⚙️  CONFIGURACIÓN CENTRAL DE XVNN
//  Edita SOLO este archivo para cambiar cualquier parámetro.
// ============================================================

export const CONFIG = {
  // ============ SERVIDOR ============
  server: {
    port: parseInt(process.env.PORT) || 3000,
    baseUrl: process.env.BASE_URL || 'http://localhost:3000',
    env: process.env.NODE_ENV || 'development'
  },

  // ============ JWT ============
  jwt: {
    secret: process.env.JWT_SECRET || 'xvnn_super_secret_key_cambiar_en_produccion_2024_x9k2m',
    expiresIn: '7d'
  },

  // ============ POSTGRESQL ============
  // Si existe DATABASE_URL (Render, Railway, Neon, Supabase) la usa.
  // Si no, usa los valores locales de abajo.
  postgres: {
    connectionString: process.env.DATABASE_URL || null,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
    host: 'localhost',
    port: 5432,
    database: 'xvnn',
    user: 'postgres',
    password: 'postgres'
  },

  // ============ S3 ToDus Stream ============
  s3: {
    baseUrl: 'https://s3.todus.cu/stream',
    prefix: 'videos'
  },

  // ============ SUBIDAS ============
  upload: {
    maxVideoSizeMB: 500,
    allowedVideoMimes: [
      'video/mp4',
      'video/webm',
      'video/quicktime',
      'video/x-matroska'
    ],
    allowedImageMimes: [
      'image/jpeg',
      'image/png',
      'image/webp',
      'image/svg+xml'
    ]
  },

  // ============ HLS (transcodificación) ============
  hls: {
    segmentDuration: 1,        // 1 segundo por segmento
    gopFrames: 25,             // keyframe cada 25 frames (~1s a 25fps)
    maxConcurrentJobs: 2,
    concurrencyUploads: 8,

    qualities: [
      { name: '240p', resolution: '426x240',  videoBitrate: '300k',  maxrate: '350k',  bufsize: '600k',  audioBitrate: '64k',  bandwidth: 380000 },
      { name: '360p', resolution: '640x360',  videoBitrate: '600k',  maxrate: '700k',  bufsize: '1200k', audioBitrate: '96k',  bandwidth: 720000 },
      { name: '480p', resolution: '854x480',  videoBitrate: '1000k', maxrate: '1200k', bufsize: '2000k', audioBitrate: '128k', bandwidth: 1180000 },
      { name: '720p', resolution: '1280x720', videoBitrate: '2500k', maxrate: '2800k', bufsize: '5000k', audioBitrate: '128k', bandwidth: 2800000 }
    ]
  },

  // ============ TELEGRAM BOT ============
  telegram: {
    // 🔑 Pega aquí el token que te dio @BotFather
    botToken: 'TU_TOKEN_AQUI',

    // 🆔 Tus IDs de Telegram (opcional, para comandos de admin)
    adminIds: [],

    // Cuenta del bot en XVNN (se crea automáticamente en la BD)
    botUsername: 'xvnn_bot',
    botName: 'XVNN Bot',

    // Long polling
    pollTimeout: 30,
    pollIntervalMs: 500,

    // ⚡ Límite de descarga por enlace directo
    // Ajusta según el disco disponible del servidor
    maxLinkDownloadMB: 500
  },

  // ============ RATE LIMITING ============
  rateLimit: {
    global: { windowMs: 15 * 60 * 1000, max: 300 },
    auth:   { windowMs: 15 * 60 * 1000, max: 20  }
  }
};

export default CONFIG;