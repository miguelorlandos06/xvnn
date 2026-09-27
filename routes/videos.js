// routes/videos.js
import express from 'express';
import { run, get, all, pool } from '../database.js';
import { authRequired, authOptional } from '../middleware/auth.js';
import { publicUrl, downloadFile, deletePrefix } from '../services/s3.js';
import { deleteVideoFiles } from '../services/transloadit.js';
import { CONFIG } from '../config.js';

const router = express.Router();

// ============================================================
//  ORDEN CRÍTICO:
//  Rutas específicas (/search, /favorites, /history, /feed)
//  SIEMPRE antes de /:id
// ============================================================

// ============================================================
//  LISTAR VIDEOS (con filtro de categoría)
// ============================================================
router.get('/', async (req, res) => {
  try {
    const { category, limit = 50, offset = 0 } = req.query;
    const valid = CONFIG.categories.list;

    let sql = `
      SELECT 
        v.*,
        u.name AS author_name,
        u.username AS author_username,
        u.avatar_url AS author_avatar,
        (SELECT COUNT(*)::int FROM comments WHERE video_id = v.id) AS comments_count
      FROM videos v
      JOIN users u ON u.id = v.user_id
      WHERE v.processing_status = 'ready'
    `;
    const params = [];

    if (category && valid.includes(category)) {
      params.push(category);
      sql += ` AND v.category = $${params.length}`;
    }

    const lim = Math.min(Number(limit) || 50, 100);
    const off = Number(offset) || 0;

    params.push(lim, off);
    sql += ` ORDER BY v.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`;

    const videos = await all(sql, params);

    res.json({ videos: videos.map(serializeVideo) });

  } catch (err) {
    console.error('Error listando videos:', err);
    res.status(500).json({ message: 'Error del servidor' });
  }
});

// ============================================================
//  BUSCAR VIDEOS
// ============================================================
router.get('/search', async (req, res) => {
  try {
    const { q, category, limit = 30 } = req.query;

    if (!q || q.trim().length < 2) {
      return res.json({ videos: [], total: 0 });
    }

    const searchTerm = `%${q.trim()}%`;
    const valid = CONFIG.categories.list;
    const lim = Math.min(Number(limit) || 30, 100);

    let sql = `
      SELECT 
        v.*,
        u.name AS author_name,
        u.username AS author_username,
        u.avatar_url AS author_avatar,
        (SELECT COUNT(*)::int FROM comments WHERE video_id = v.id) AS comments_count
      FROM videos v
      JOIN users u ON u.id = v.user_id
      WHERE v.processing_status = 'ready'
        AND (v.title ILIKE $1 OR v.description ILIKE $1)
    `;
    const params = [searchTerm];

    if (category && valid.includes(category)) {
      params.push(category);
      sql += ` AND v.category = $${params.length}`;
    }

    params.push(lim);
    sql += ` ORDER BY v.views DESC LIMIT $${params.length}`;

    const videos = await all(sql, params);

    res.json({
      videos: videos.map(serializeVideo),
      total: videos.length
    });

  } catch (err) {
    console.error('Error en búsqueda:', err);
    res.status(500).json({ message: 'Error del servidor' });
  }
});

// ============================================================
//  MIS VIDEOS
// ============================================================
router.get('/mine', authRequired, async (req, res) => {
  try {
    const { category } = req.query;
    const valid = CONFIG.categories.list;

    let sql = `
      SELECT 
        v.*,
        u.name AS author_name,
        u.username AS author_username,
        u.avatar_url AS author_avatar,
        (SELECT COUNT(*)::int FROM comments WHERE video_id = v.id) AS comments_count
      FROM videos v
      JOIN users u ON u.id = v.user_id
      WHERE v.user_id = $1
    `;
    const params = [req.user.id];

    if (category && valid.includes(category)) {
      params.push(category);
      sql += ` AND v.category = $${params.length}`;
    }

    sql += ` ORDER BY v.created_at DESC`;

    const videos = await all(sql, params);

    res.json({ videos: videos.map(serializeVideo) });

  } catch (err) {
    console.error('Error mis videos:', err);
    res.status(500).json({ message: 'Error del servidor' });
  }
});

// ============================================================
//  FAVORITOS DEL USUARIO
// ============================================================
router.get('/favorites', authRequired, async (req, res) => {
  try {
    const videos = await all(`
      SELECT 
        v.*,
        u.name AS author_name,
        u.username AS author_username,
        u.avatar_url AS author_avatar,
        f.created_at AS favorited_at,
        (SELECT COUNT(*)::int FROM comments WHERE video_id = v.id) AS comments_count
      FROM favorites f
      JOIN videos v ON v.id = f.video_id
      JOIN users u ON u.id = v.user_id
      WHERE f.user_id = $1 AND v.processing_status = 'ready'
      ORDER BY f.created_at DESC
      LIMIT 100
    `, [req.user.id]);

    res.json({ videos: videos.map(serializeVideo) });

  } catch (err) {
    console.error('Error favoritos:', err);
    res.status(500).json({ message: 'Error del servidor' });
  }
});

// ============================================================
//  HISTORIAL DE VISTAS
// ============================================================
router.get('/history', authRequired, async (req, res) => {
  try {
    const videos = await all(`
      WITH user_history AS (
        SELECT DISTINCT ON (video_id) 
          video_id,
          MAX(created_at) AS viewed_at
        FROM views_log
        WHERE user_id = $1
        GROUP BY video_id
        ORDER BY video_id, MAX(created_at) DESC
      )
      SELECT 
        v.*,
        u.name AS author_name,
        u.username AS author_username,
        u.avatar_url AS author_avatar,
        h.viewed_at,
        (SELECT COUNT(*)::int FROM comments WHERE video_id = v.id) AS comments_count
      FROM user_history h
      JOIN videos v ON v.id = h.video_id
      JOIN users u ON u.id = v.user_id
      WHERE v.processing_status = 'ready'
      ORDER BY h.viewed_at DESC
      LIMIT 100
    `, [req.user.id]);

    res.json({ videos: videos.map(serializeVideo) });

  } catch (err) {
    console.error('Error historial:', err);
    res.status(500).json({ message: 'Error del servidor' });
  }
});

// ============================================================
//  RECOMENDADOS
// ============================================================
router.get('/recommended', async (req, res) => {
  try {
    const { exclude, category, limit = 6 } = req.query;
    const lim = Math.min(Number(limit) || 6, 20);

    let sql = `
      SELECT 
        v.*,
        u.name AS author_name,
        u.username AS author_username,
        u.avatar_url AS author_avatar,
        (SELECT COUNT(*)::int FROM comments WHERE video_id = v.id) AS comments_count,
        (
          COALESCE(v.views, 0) * 1.0 +
          COALESCE(v.likes, 0) * 5.0 +
          (SELECT COUNT(*) FROM comments WHERE video_id = v.id) * 3.0
        ) AS score
      FROM videos v
      JOIN users u ON u.id = v.user_id
      WHERE v.processing_status = 'ready'
    `;
    const params = [];

    if (exclude) {
      params.push(exclude);
      sql += ` AND v.id != $${params.length}`;
    }

    if (category && CONFIG.categories.list.includes(category)) {
      params.push(category);
      sql += ` AND v.category = $${params.length}`;
    }

    params.push(lim);
    sql += ` ORDER BY score DESC, v.created_at DESC LIMIT $${params.length}`;

    const videos = await all(sql, params);
    res.json({ videos: videos.map(serializeVideo) });

  } catch (err) {
    console.error('Error recomendados:', err);
    res.status(500).json({ message: 'Error del servidor' });
  }
});

// ============================================================
//  OBTENER UN VIDEO
// ============================================================
router.get('/:id', authOptional, async (req, res) => {
  try {
    const video = await get(`
      SELECT 
        v.*,
        u.name AS author_name,
        u.username AS author_username,
        u.avatar_url AS author_avatar,
        (SELECT COUNT(*)::int FROM comments WHERE video_id = v.id) AS comments_count
      FROM videos v
      JOIN users u ON u.id = v.user_id
      WHERE v.id = $1
    `, [req.params.id]);

    if (!video) return res.status(404).json({ message: 'Video no encontrado' });

    // Reacción del usuario
    let userReaction = null;
    let isFavorite = false;

    if (req.user?.id) {
      const [reaction, favorite] = await Promise.all([
        get('SELECT type FROM reactions WHERE user_id = $1 AND video_id = $2',
          [req.user.id, video.id]),
        get('SELECT 1 FROM favorites WHERE user_id = $1 AND video_id = $2',
          [req.user.id, video.id])
      ]);

      userReaction = reaction?.type || null;
      isFavorite = !!favorite;
    }

    res.json({
      ...serializeVideo(video),
      userReaction,
      isFavorite
    });

  } catch (err) {
    console.error('Error obteniendo video:', err);
    if (err.code === '22P02') {
      return res.status(400).json({ message: 'ID inválido' });
    }
    res.status(500).json({ message: 'Error del servidor' });
  }
});

// ============================================================
//  REGISTRAR VISTA
// ============================================================
router.post('/:id/view', authOptional, async (req, res) => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const check = await client.query(
      'SELECT id FROM videos WHERE id = $1',
      [req.params.id]
    );

    if (check.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Video no encontrado' });
    }

    await client.query(
      'INSERT INTO views_log (user_id, video_id) VALUES ($1, $2)',
      [req.user?.id || null, req.params.id]
    );

    const updated = await client.query(
      'UPDATE videos SET views = views + 1 WHERE id = $1 RETURNING views',
      [req.params.id]
    );

    await client.query('COMMIT');

    res.json({ views: updated.rows[0].views });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error registrando vista:', err);
    if (err.code === '22P02') {
      return res.status(400).json({ message: 'ID inválido' });
    }
    res.status(500).json({ message: 'Error del servidor' });
  } finally {
    client.release();
  }
});

// ============================================================
//  REACCIONAR (LIKE / DISLIKE)
// ============================================================
router.post('/:id/react', authRequired, async (req, res) => {
  try {
    const { reaction } = req.body;
    const videoId = req.params.id;
    const userId = req.user.id;

    if (reaction !== null && reaction !== undefined && !['like', 'dislike'].includes(reaction)) {
      return res.status(400).json({ message: 'Reacción inválida' });
    }

    const video = await get('SELECT id FROM videos WHERE id = $1', [videoId]);
    if (!video) return res.status(404).json({ message: 'Video no encontrado' });

    // Reacción previa
    const prev = await get(
      'SELECT type FROM reactions WHERE user_id = $1 AND video_id = $2',
      [userId, videoId]
    );
    const prevType = prev?.type || null;
    const newType = reaction || null;

    // No hay cambio
    if (prevType === newType) {
      const cur = await get('SELECT likes, dislikes FROM videos WHERE id = $1', [videoId]);
      return res.json({ likes: cur.likes, dislikes: cur.dislikes, userReaction: newType });
    }

    // Quitar anterior
    if (newType === null) {
      await run('DELETE FROM reactions WHERE user_id = $1 AND video_id = $2', [userId, videoId]);
    } else if (prevType === null) {
      await run(
        'INSERT INTO reactions (user_id, video_id, type) VALUES ($1, $2, $3)',
        [userId, videoId, newType]
      );
    } else {
      await run(
        'UPDATE reactions SET type = $1 WHERE user_id = $2 AND video_id = $3',
        [newType, userId, videoId]
      );
    }

    const upd = await get('SELECT likes, dislikes FROM videos WHERE id = $1', [videoId]);
    res.json({ likes: upd.likes, dislikes: upd.dislikes, userReaction: newType });

  } catch (err) {
    console.error('Error reacción:', err);
    if (err.code === '22P02') {
      return res.status(400).json({ message: 'ID inválido' });
    }
    res.status(500).json({ message: 'Error del servidor' });
  }
});

// ============================================================
//  FAVORITOS: AÑADIR / QUITAR
// ============================================================
router.post('/:id/favorite', authRequired, async (req, res) => {
  try {
    const videoId = req.params.id;
    const userId = req.user.id;

    const video = await get('SELECT id FROM videos WHERE id = $1', [videoId]);
    if (!video) return res.status(404).json({ message: 'Video no encontrado' });

    const existing = await get(
      'SELECT 1 FROM favorites WHERE user_id = $1 AND video_id = $2',
      [userId, videoId]
    );

    if (existing) {
      await run('DELETE FROM favorites WHERE user_id = $1 AND video_id = $2',
        [userId, videoId]);
      res.json({ isFavorite: false, message: 'Eliminado de favoritos' });
    } else {
      await run('INSERT INTO favorites (user_id, video_id) VALUES ($1, $2)',
        [userId, videoId]);
      res.json({ isFavorite: true, message: 'Añadido a favoritos' });
    }

  } catch (err) {
    console.error('Error favorito:', err);
    if (err.code === '22P02') {
      return res.status(400).json({ message: 'ID inválido' });
    }
    res.status(500).json({ message: 'Error del servidor' });
  }
});

// ============================================================
//  COMENTARIOS
// ============================================================

// Obtener comentarios
router.get('/:id/comments', async (req, res) => {
  try {
    const { limit = 50, offset = 0 } = req.query;
    const lim = Math.min(Number(limit) || 50, 100);
    const off = Number(offset) || 0;

    const video = await get('SELECT id FROM videos WHERE id = $1', [req.params.id]);
    if (!video) return res.status(404).json({ message: 'Video no encontrado' });

    const comments = await all(`
      SELECT 
        c.id, c.content, c.created_at, c.updated_at,
        u.id AS user_id, u.name AS user_name, u.username AS user_username,
        u.avatar_url AS user_avatar
      FROM comments c
      JOIN users u ON u.id = c.user_id
      WHERE c.video_id = $1
      ORDER BY c.created_at DESC
      LIMIT $2 OFFSET $3
    `, [req.params.id, lim, off]);

    const countResult = await get(
      'SELECT COUNT(*)::int AS total FROM comments WHERE video_id = $1',
      [req.params.id]
    );

    res.json({
      comments: comments.map(c => ({
        id: c.id,
        content: c.content,
        createdAt: c.created_at,
        updatedAt: c.updated_at,
        author: {
          id: c.user_id,
          name: c.user_name,
          username: c.user_username,
          avatarUrl: c.user_avatar ? publicUrl(c.user_avatar) : null
        }
      })),
      total: countResult.total
    });

  } catch (err) {
    console.error('Error comentarios:', err);
    if (err.code === '22P02') {
      return res.status(400).json({ message: 'ID inválido' });
    }
    res.status(500).json({ message: 'Error del servidor' });
  }
});

// Crear comentario
router.post('/:id/comments', authRequired, async (req, res) => {
  try {
    const { content } = req.body;

    if (!content || content.trim().length === 0) {
      return res.status(400).json({ message: 'El comentario no puede estar vacío' });
    }
    if (content.length > 1000) {
      return res.status(400).json({ message: 'Máximo 1000 caracteres' });
    }

    const video = await get('SELECT id FROM videos WHERE id = $1', [req.params.id]);
    if (!video) return res.status(404).json({ message: 'Video no encontrado' });

    const comment = await get(`
      INSERT INTO comments (video_id, user_id, content)
      VALUES ($1, $2, $3)
      RETURNING id, content, created_at
    `, [req.params.id, req.user.id, content.trim()]);

    const user = await get(
      'SELECT id, name, username, avatar_url FROM users WHERE id = $1',
      [req.user.id]
    );

    res.status(201).json({
      comment: {
        id: comment.id,
        content: comment.content,
        createdAt: comment.created_at,
        author: {
          id: user.id,
          name: user.name,
          username: user.username,
          avatarUrl: user.avatar_url ? publicUrl(user.avatar_url) : null
        }
      }
    });

  } catch (err) {
    console.error('Error creando comentario:', err);
    if (err.code === '22P02') {
      return res.status(400).json({ message: 'ID inválido' });
    }
    res.status(500).json({ message: 'Error del servidor' });
  }
});

// Eliminar comentario
router.delete('/:videoId/comments/:commentId', authRequired, async (req, res) => {
  try {
    const comment = await get(
      'SELECT id, user_id FROM comments WHERE id = $1 AND video_id = $2',
      [req.params.commentId, req.params.videoId]
    );

    if (!comment) return res.status(404).json({ message: 'Comentario no encontrado' });
    if (comment.user_id !== req.user.id) {
      return res.status(403).json({ message: 'No autorizado' });
    }

    await run('DELETE FROM comments WHERE id = $1', [comment.id]);
    res.json({ message: 'Comentario eliminado' });

  } catch (err) {
    console.error('Error eliminando comentario:', err);
    if (err.code === '22P02') {
      return res.status(400).json({ message: 'ID inválido' });
    }
    res.status(500).json({ message: 'Error del servidor' });
  }
});

// ============================================================
//  DESCARGAR
// ============================================================
router.get('/:id/download', async (req, res) => {
  try {
    const video = await get('SELECT filename, title FROM videos WHERE id = $1', [req.params.id]);
    if (!video) return res.status(404).json({ message: 'Video no encontrado' });

    // filename ahora es la key del master.m3u8 en ToDus
    const { stream, contentType, contentLength } = await downloadFile(video.filename);
    const safe = `XVNN_${video.title.replace(/[^a-z0-9]/gi, '_')}.mp4`;

    res.setHeader('Content-Type', contentType || 'video/mp4');
    if (contentLength) res.setHeader('Content-Length', contentLength);
    res.setHeader('Content-Disposition', `attachment; filename="${safe}"`);
    stream.pipe(res);

  } catch (err) {
    console.error('Error descarga:', err);
    res.status(500).json({ message: 'Error del servidor' });
  }
});

// ============================================================
//  ELIMINAR VIDEO
// ============================================================
router.delete('/:id', authRequired, async (req, res) => {
  try {
    const video = await get(
      'SELECT * FROM videos WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );

    if (!video) {
      return res.status(404).json({ message: 'Video no encontrado o no autorizado' });
    }

    // Eliminar archivos de ToDus
    try {
      await deleteVideoFiles(video.id);
    } catch (err) {
      console.warn('Error eliminando archivos:', err.message);
    }

    // Eliminar de la BD (cascada borra reacciones, favoritos, comentarios, vistas)
    await run('DELETE FROM videos WHERE id = $1', [video.id]);

    res.json({ message: 'Video eliminado correctamente' });

  } catch (err) {
    console.error('Error eliminando video:', err);
    if (err.code === '22P02') {
      return res.status(400).json({ message: 'ID inválido' });
    }
    res.status(500).json({ message: 'Error del servidor' });
  }
});

// ============================================================
//  SERIALIZADOR
// ============================================================
function serializeVideo(v) {
  const useHls = v.video_type === 'hls' && v.processing_status === 'ready';

  return {
    id: v.id,
    title: v.title,
    description: v.description || '',
    category: v.category,
    duration: formatDuration(v.duration),
    durationSeconds: v.duration,
    views: formatViews(v.views),
    viewsRaw: v.views,
    likes: v.likes || 0,
    dislikes: v.dislikes || 0,
    commentsCount: v.comments_count || 0,
    size: formatSize(Number(v.size)),
    thumb: publicUrl(v.thumbnail),
    videoUrl: publicUrl(v.filename),
    hlsUrl: useHls ? publicUrl(v.filename) : null,
    videoType: v.video_type,
    status: v.processing_status,
    author: {
      name: v.author_name,
      username: v.author_username,
      avatarUrl: v.author_avatar ? publicUrl(v.author_avatar) : null
    },
    createdAt: v.created_at
  };
}

function formatDuration(seconds) {
  if (!seconds) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatViews(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1).replace('.0', '') + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1).replace('.0', '') + 'K';
  return n.toString();
}

function formatSize(bytes) {
  if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(1) + ' GB';
  if (bytes >= 1048576) return Math.round(bytes / 1048576) + ' MB';
  if (bytes >= 1024) return Math.round(bytes / 1024) + ' KB';
  return bytes + ' B';
}

export default router;
