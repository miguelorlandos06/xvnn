// config.js
// ============================================================
//  CONFIGURACIÓN CENTRAL DE XVNN
// ============================================================

export const CONFIG = {
  // ============ SERVIDOR ============
  server: {
    port: 10000,
    baseUrl: 'https://xvnn-6jl5.onrender.com',
    env: 'production',
    brand: 'XVNN'
  },

  // ============ JWT ============
  jwt: {
    secret: 'xvnn_super_secret_key_cambiar_en_produccion_2024_x9k2m_random',
    expiresIn: '7d'
  },

  // ============ POSTGRESQL ============
  postgres: {
    connectionString: 'postgresql://xvnn_giog_user:iP0K9b3xpTeYlesbLQnc7uFNUPwv3ek6@dpg-dasm348473hc738ua8ag-a.oregon-postgres.render.com/xvnn_giog',
    ssl: { rejectUnauthorized: false }
  },

  // ============ S3 ToDus Stream ============
  s3: {
    baseUrl: 'https://s3.todus.cu/stream',
    prefix: 'videos'
  },

  // ============ TRANSLOADIT ============
  transloadit: {
    authKey: 'R7k1Wo4IyeeoqgT0qGvEERKzV1Pqb8bW',
    authSecret: 'bIyYPZVpwGCotvACwqzSW0TtAe1Odqe1LSyjJkOn',
    signatureAlgorithm: 'sha256',
    preset: 'hls/720p',
    ffmpegStack: 'v7'
  },

  // ============ BOT TELEGRAM ============
  telegram: {
    botToken: '8942495722:AAEnFHhqRFVr5IRXFkfS4MRV43_V6EuUiEc',
    pollTimeout: 30,
    pollIntervalMs: 500,
    maxLinkDownloadMB: 2000,
    maxUrlsPerFile: 50,
    maxUrlsPerDay: 500
  },

  // ============ CATEGORÍAS ============
  categories: {
    list: ['Hetero', 'Gay', 'Bi', 'Trans'],
    labels: {
      Hetero: 'Hetero',
      Gay: 'Gay',
      Bi: 'Bi',
      Trans: 'Trans'
    }
  },

  // ============ RATE LIMITING ============
  rateLimit: {
    global: { windowMs: 15 * 60 * 1000, max: 300 },
    auth:   { windowMs: 15 * 60 * 1000, max: 20  }
  }
};

export default CONFIG;
