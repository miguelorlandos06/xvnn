// routes/videos.js
import express from 'express';
import { run, get, all, pool } from '../database.js';
import { authRequired, authOptional } from '../middleware/auth.js';
import { publicUrl, downloadFile } from '../services/s3.js';

const router = express.Router();

// ============================================================
//  ORDEN DE RUTAS (CRÍTICO):
//  Las rutas específicas (/mine, /recommended) SIEMPRE antes de /:id
// ============================================================

// ============ LISTAR VIDEOS ============
router.get('/', async (req, res) => {
  try {
    const { category, limit = 50, offset = 0 } = req.query;
    const valid = ['Hetero', 'Gay', 'Bi', 'Trans'];

    let sql = `
      SELECT 
        v.*, 
        u.name AS author_name, 
        u.username AS author_username,
        (SELECT COUNT(*)::int FROM comments WHERE video_id = v.id) AS comments_count
      FROM videos v 
      JOIN users u ON u.id = v.user_id
      WHERE v.processing_status = 'ready'
    `;
    const params = [];

    if (category && valid.includes(category)) {
      sql += ' AND v.category = $1';
      params.push(category);
    }

    const lim = Math.min(Number(limit) || 50, 100);
    const off = Number(offset) || 0;
    sql += ` ORDER BY v.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(lim, off);

    const videos = await all(sql, params);
    res.json({ videos: videos.map(serializeVideo) });
  } catch (err) {
    console.error('Error listando videos:', err);
    res.status(500).json({ message: 'Error del servidor' });
  }
});

// ============ MIS VIDEOS ============
// ⚠️ ANTES de /:id
router.get('/mine', authRequired, async (req, res) => {
  try {
    const videos = await all(`
      SELECT 
        v.*, 
        u.name AS author_name, 
        u.username AS author_username,
        (SELECT COUNT(*)::int FROM comments WHERE video_id = v.id) AS comments_count
      FROM videos v 
      JOIN users u ON u.id = v.user_id
      WHERE v.user_id = $1
      ORDER BY v.created_at DESC
    `, [req.user.id]);

    res.json({ videos: videos.map(serializeVideo) });
  } catch (err) {
    console.error('Error obteniendo mis videos:', err);
    res.status(500).json({ message: 'Error del servidor' });
  }
});

// ============ RECOMENDADOS (POR ESTADÍSTICAS) ============
// ⚠️ ANTES de /:id
router.get('/recommended', async (req, res) => {
  try {
    const { exclude, limit = 6, category } = req.query;
    const lim = Math.min(Number(limit) || 6, 20);

    let sql = `
      SELECT 
        v.*, 
        u.name AS author_name, 
        u.username AS author_username,
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

    if (category && ['Hetero', 'Gay', 'Bi', 'Trans'].includes(category)) {
      params.push(category);
      sql += ` AND v.category = $${params.length}`;
    }

    params.push(lim);
    sql += ` ORDER BY score DESC, v.created_at DESC LIMIT $${params.length}`;

    const videos = await all(sql, params);
    res.json({ videos: videos.map(serializeVideo) });
  } catch (err) {
    console.error('Error obteniendo recomendados:', err);
    res.status(500).json({ message: 'Error del servidor' });
  }
});

// ============ OBTENER UN VIDEO ============
router.get('/:id', authOptional, async (req, res) => {
  try {
    const video = await get(`
      SELECT 
        v.*, 
        u.name AS author_name, 
        u.username AS author_username,
        (SELECT COUNT(*)::int FROM comments WHERE video_id = v.id) AS comments_count
      FROM videos v 
      JOIN users u ON u.id = v.user_id
      WHERE v.id = $1
    `, [req.params.id]);

    if (!video) return res.status(404).json({ message: 'Video no encontrado' });

    let userReaction = null;
    if (req.user?.id) {
      const r = await get(
        'SELECT type FROM reactions WHERE user_id = $1 AND video_id = $2',
        [req.user.id, video.id]
      );
      userReaction = r?.type || null;
    }

    res.json({ ...serializeVideo(video), userReaction });
  } catch (err) {
    console.error('Error obteniendo video:', err);
    if (err.code === '22P02') return res.status(400).json({ message: 'ID inválido' });
    res.status(500).json({ message: 'Error del servidor' });
  }
});

// ============ REGISTRAR VIEW ============
router.post('/:id/view', authOptional, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const check = await client.query('SELECT id FROM videos WHERE id = $1', [req.params.id]);
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
    console.error('Error registrando view:', err);
    if (err.code === '22P02') return res.status(400).json({ message: 'ID inválido' });
    res.status(500).json({ message: 'Error del servidor' });
  } finally {
    client.release();
  }
});

// ============ REACCIONAR ============
router.post('/:id/react', authRequired, async (req, res) => {
  try {
    const { reaction } = req.body;
    const { id: videoId } = req.params;
    const userId = req.user.id;

    if (reaction !== null && reaction !== undefined && !['like', 'dislike'].includes(reaction)) {
      return res.status(400).json({ message: 'Reacción inválida' });
    }

    const video = await get('SELECT id FROM videos WHERE id = $1', [videoId]);
    if (!video) return res.status(404).json({ message: 'Video no encontrado' });

    const prev = await get(
      'SELECT type FROM reactions WHERE user_id = $1 AND video_id = $2',
      [userId, videoId]
    );
    const prevType = prev?.type || null;
    const newType = reaction || null;

    if (prevType === newType) {
      const cur = await get('SELECT likes, dislikes FROM videos WHERE id = $1', [videoId]);
      return res.json({ likes: cur.likes, dislikes: cur.dislikes, userReaction: newType });
    }

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
    console.error('Error en reacción:', err);
    if (err.code === '22P02') return res.status(400).json({ message: 'ID inválido' });
    res.status(500).json({ message: 'Error del servidor' });
  }
});

// ============ DESCARGAR ============
router.get('/:id/download', async (req, res) => {
  try {
    const video = await get('SELECT filename, title FROM videos WHERE id = $1', [req.params.id]);
    if (!video) return res.status(404).json({ message: 'Video no encontrado' });

    const { stream, contentType, contentLength } = await downloadFile(video.filename);
    const safe = `XVNN_${video.title.replace(/[^a-z0-9]/gi, '_')}.mp4`;

    res.setHeader('Content-Type', contentType || 'video/mp4');
    if (contentLength) res.setHeader('Content-Length', contentLength);
    res.setHeader('Content-Disposition', `attachment; filename="${safe}"`);
    stream.pipe(res);
  } catch (err) {
    console.error('Error en descarga:', err);
    res.status(500).json({ message: 'Error del servidor' });
  }
});

// ============================================================
//  COMENTARIOS
// ============================================================

// ============ OBTENER COMENTARIOS ============
router.get('/:id/comments', async (req, res) => {
  try {
    const { limit = 50, offset = 0 } = req.query;
    const lim = Math.min(Number(limit) || 50, 100);
    const off = Number(offset) || 0;

    // Verificar que el video existe
    const video = await get('SELECT id FROM videos WHERE id = $1', [req.params.id]);
    if (!video) return res.status(404).json({ message: 'Video no encontrado' });

    const comments = await all(`
      SELECT 
        c.id, c.content, c.created_at, c.updated_at,
        u.id AS user_id, u.name AS user_name, u.username AS user_username, u.avatar_url AS user_avatar
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
    console.error('Error obteniendo comentarios:', err);
    if (err.code === '22P02') return res.status(400).json({ message: 'ID inválido' });
    res.status(500).json({ message: 'Error del servidor' });
  }
});

// ============ CREAR COMENTARIO ============
router.post('/:id/comments', authRequired, async (req, res) => {
  try {
    const { content } = req.body;

    if (!content || content.trim().length === 0) {
      return res.status(400).json({ message: 'El comentario no puede estar vacío' });
    }
    if (content.length > 1000) {
      return res.status(400).json({ message: 'Máximo 1000 caracteres' });
    }

    // Verificar que el video existe
    const video = await get('SELECT id FROM videos WHERE id = $1', [req.params.id]);
    if (!video) return res.status(404).json({ message: 'Video no encontrado' });

    const comment = await get(`
      INSERT INTO comments (video_id, user_id, content)
      VALUES ($1, $2, $3)
      RETURNING id, content, created_at
    `, [req.params.id, req.user.id, content.trim()]);

    // Obtener info del autor
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

// ============ ELIMINAR COMENTARIO ============
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
    if (err.code === '22P02') return res.status(400).json({ message: 'ID inválido' });
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

    // Eliminar de S3
    try {
      const { deleteFile } = await import('../services/s3.js');

      const keysToDelete = [];

      if (video.filename) keysToDelete.push(video.filename);
      if (video.thumbnail) keysToDelete.push(video.thumbnail);

      if (video.hls_manifest) {
        try {
          const hlsBase = video.hls_manifest.replace('/master.m3u8', '');
          const hlsFiles = await listHLSDirectory(hlsBase);
          keysToDelete.push(...hlsFiles);
        } catch (err) {
          console.warn('No se pudo listar HLS:', err.message);
        }
      }

      console.log(`🗑️  Eliminando ${keysToDelete.length} archivos de S3...`);

      const results = await Promise.allSettled(
        keysToDelete.map(k => deleteFile(k))
      );

      const failed = results.filter(r => r.status === 'rejected').length;
      console.log(`✅ Eliminados: ${keysToDelete.length - failed}/${keysToDelete.length}`);
    } catch (err) {
      console.error('⚠️  Error eliminando de S3:', err.message);
    }

    // Eliminar de la BD (CASCADE borra reacciones, views_log y comentarios)
    await run('DELETE FROM videos WHERE id = $1', [video.id]);

    res.json({
      message: 'Video eliminado correctamente',
      deletedFiles: true
    });
  } catch (err) {
    console.error('Error eliminando video:', err);
    if (err.code === '22P02') {
      return res.status(400).json({ message: 'ID inválido' });
    }
    res.status(500).json({ message: 'Error del servidor' });
  }
});

// ============ HELPER: Listar archivos HLS de S3 ============
async function listHLSDirectory(baseKey) {
  const files = [];
  try {
    const { CONFIG } = await import('../config.js');
    const baseUrl = CONFIG.s3.baseUrl;

    const res = await fetch(`${baseUrl}?prefix=${baseKey}&list-type=2&max-keys=1000`);
    if (!res.ok) {
      console.warn(`S3 list devolvió HTTP ${res.status}`);
      return files;
    }

    const xml = await res.text();
    const keyRegex = /<Key>([^<]+)<\/Key>/g;
    let match;
    while ((match = keyRegex.exec(xml)) !== null) {
      files.push(match[1]);
    }

    console.log(`📂 Encontrados ${files.length} archivos HLS en ${baseKey}`);
  } catch (err) {
    console.warn('Error listando HLS:', err.message);
  }
  return files;
}

// ============ SERIALIZADOR ============
function serializeVideo(v) {
  const useHls = v.video_type === 'hls' && v.hls_manifest && v.processing_status === 'ready';

  return {
    id: v.id,
    title: v.title,
    description: v.description,
    category: v.category,
    duration: formatDuration(v.duration),
    durationSeconds: v.duration,
    views: formatViews(v.views),
    viewsRaw: v.views,
    likes: v.likes,
    dislikes: v.dislikes,
    commentsCount: v.comments_count || 0,
    size: formatSize(Number(v.size)),
    thumb: publicUrl(v.thumbnail),
    videoUrl: publicUrl(v.filename),
    hlsUrl: useHls ? publicUrl(v.hls_manifest) : null,
    videoType: useHls ? 'hls' : 'mp4',
    status: v.processing_status,
    variants: v.variants || null,
    author: { 
      name: v.author_name, 
      username: v.author_username 
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