// routes/auth.js
import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import { get, run } from '../database.js';
import { authRequired } from '../middleware/auth.js';
import { publicUrl, uploadFile } from '../services/s3.js';
import { CONFIG } from '../config.js';

const router = express.Router();

// ============================================================
//  CONFIGURACIÓN MULTER (AVATAR EN MEMORIA)
// ============================================================
const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const validTypes = ['image/jpeg', 'image/png', 'image/webp'];
    const ok = validTypes.includes(file.mimetype);
    cb(ok ? null : new Error('Formato no soportado. Usa JPG, PNG o WebP'), ok);
  }
});

// ============================================================
//  REGISTRO
// ============================================================
router.post('/register', async (req, res) => {
  try {
    const { name, username, password } = req.body;

    if (!name || !username || !password) {
      return res.status(400).json({ message: 'Todos los campos son obligatorios' });
    }
    if (name.trim().length < 2) {
      return res.status(400).json({ message: 'El nombre debe tener al menos 2 caracteres' });
    }
    if (username.length < 3 || !/^[a-zA-Z0-9_]+$/.test(username)) {
      return res.status(400).json({ message: 'Usuario inválido (mín. 3, solo letras/números/_)' });
    }
    if (password.length < 6) {
      return res.status(400).json({ message: 'La contraseña debe tener al menos 6 caracteres' });
    }

    const existing = await get(
      'SELECT id FROM users WHERE LOWER(username) = LOWER($1)',
      [username]
    );
    if (existing) {
      return res.status(409).json({ message: 'Este usuario ya está registrado' });
    }

    const hash = await bcrypt.hash(password, 10);

    const user = await get(
      `INSERT INTO users (name, username, password, default_category)
       VALUES ($1, $2, $3, 'Hetero')
       RETURNING id, name, username, default_category, avatar_url`,
      [name.trim(), username.trim(), hash]
    );

    const token = jwt.sign(
      { id: user.id, username: user.username, name: user.name },
      CONFIG.jwt.secret,
      { expiresIn: CONFIG.jwt.expiresIn }
    );

    res.status(201).json({
      token,
      user: {
        id: user.id,
        name: user.name,
        username: user.username,
        defaultCategory: user.default_category,
        avatarUrl: user.avatar_url ? publicUrl(user.avatar_url) : null
      }
    });
  } catch (err) {
    console.error('Error en registro:', err);
    if (err.code === '23505') {
      return res.status(409).json({ message: 'Este usuario ya está registrado' });
    }
    res.status(500).json({ message: 'Error del servidor' });
  }
});

// ============================================================
//  LOGIN
// ============================================================
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ message: 'Usuario y contraseña requeridos' });
    }

    const user = await get(
      'SELECT * FROM users WHERE LOWER(username) = LOWER($1)',
      [username]
    );
    if (!user) {
      return res.status(401).json({ message: 'Usuario o contraseña incorrectos' });
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      return res.status(401).json({ message: 'Usuario o contraseña incorrectos' });
    }

    const token = jwt.sign(
      { id: user.id, username: user.username, name: user.name },
      CONFIG.jwt.secret,
      { expiresIn: CONFIG.jwt.expiresIn }
    );

    res.json({
      token,
      user: {
        id: user.id,
        name: user.name,
        username: user.username,
        defaultCategory: user.default_category || 'Hetero',
        avatarUrl: user.avatar_url ? publicUrl(user.avatar_url) : null
      }
    });
  } catch (err) {
    console.error('Error en login:', err);
    res.status(500).json({ message: 'Error del servidor' });
  }
});

// ============================================================
//  PERFIL ACTUAL
// ============================================================
router.get('/me', authRequired, async (req, res) => {
  try {
    const user = await get(
      `SELECT id, name, username, default_category, avatar_url, created_at 
       FROM users WHERE id = $1`,
      [req.user.id]
    );
    if (!user) return res.status(404).json({ message: 'Usuario no encontrado' });

    res.json({
      user: {
        id: user.id,
        name: user.name,
        username: user.username,
        defaultCategory: user.default_category || 'Hetero',
        avatarUrl: user.avatar_url ? publicUrl(user.avatar_url) : null,
        createdAt: user.created_at
      }
    });
  } catch (err) {
    console.error('Error /me:', err);
    res.status(500).json({ message: 'Error del servidor' });
  }
});

// ============================================================
//  ACTUALIZAR PERFIL (nombre y username)
// ============================================================
router.put('/profile', authRequired, async (req, res) => {
  try {
    const { name, username } = req.body;
    const updates = [];
    const params = [];

    if (name !== undefined) {
      if (name.trim().length < 2 || name.trim().length > 100) {
        return res.status(400).json({ message: 'El nombre debe tener entre 2 y 100 caracteres' });
      }
      params.push(name.trim());
      updates.push(`name = $${params.length}`);
    }

    if (username !== undefined) {
      if (username.length < 3 || !/^[a-zA-Z0-9_]+$/.test(username)) {
        return res.status(400).json({ message: 'Usuario inválido (mín. 3, solo letras/números/_)' });
      }
      if (username.length > 50) {
        return res.status(400).json({ message: 'Usuario demasiado largo (máx 50)' });
      }

      const existing = await get(
        'SELECT id FROM users WHERE LOWER(username) = LOWER($1) AND id != $2',
        [username, req.user.id]
      );
      if (existing) {
        return res.status(409).json({ message: 'Ese usuario ya está en uso' });
      }

      params.push(username.trim());
      updates.push(`username = $${params.length}`);
    }

    if (updates.length === 0) {
      return res.status(400).json({ message: 'No hay nada que actualizar' });
    }

    params.push(req.user.id);

    const updated = await get(
      `UPDATE users SET ${updates.join(', ')} WHERE id = $${params.length}
       RETURNING id, name, username, default_category, avatar_url`,
      params
    );

    const token = jwt.sign(
      { id: updated.id, username: updated.username, name: updated.name },
      CONFIG.jwt.secret,
      { expiresIn: CONFIG.jwt.expiresIn }
    );

    res.json({
      message: 'Perfil actualizado',
      token,
      user: {
        id: updated.id,
        name: updated.name,
        username: updated.username,
        defaultCategory: updated.default_category,
        avatarUrl: updated.avatar_url ? publicUrl(updated.avatar_url) : null
      }
    });
  } catch (err) {
    console.error('Error actualizando perfil:', err);
    if (err.code === '23505') {
      return res.status(409).json({ message: 'Ese usuario ya está en uso' });
    }
    res.status(500).json({ message: 'Error del servidor' });
  }
});

// ============================================================
//  SUBIR AVATAR
// ============================================================
router.post('/avatar', authRequired, (req, res) => {
  avatarUpload.single('avatar')(req, res, async (err) => {
    if (err) {
      console.error('Error de multer:', err.message);
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ message: 'La imagen es demasiado grande (máx 5 MB)' });
      }
      return res.status(400).json({ message: err.message });
    }

    if (!req.file) {
      return res.status(400).json({ message: 'No se recibió ninguna imagen' });
    }

    try {
      const ext = req.file.mimetype.split('/')[1].replace('jpeg', 'jpg');
      const filename = `avatars/${req.user.id}/${Date.now()}.${ext}`;

      await uploadFile(filename, req.file.buffer, req.file.mimetype);

      await run(
        'UPDATE users SET avatar_url = $1 WHERE id = $2',
        [filename, req.user.id]
      );

      res.json({
        message: 'Avatar actualizado',
        avatarUrl: publicUrl(filename)
      });
    } catch (uploadErr) {
      console.error('Error subiendo avatar:', uploadErr);
      res.status(500).json({ message: uploadErr.message || 'Error del servidor' });
    }
  });
});

// ============================================================
//  ELIMINAR AVATAR
// ============================================================
router.delete('/avatar', authRequired, async (req, res) => {
  try {
    const user = await get(
      'SELECT avatar_url FROM users WHERE id = $1',
      [req.user.id]
    );

    if (!user?.avatar_url) {
      return res.status(400).json({ message: 'No tienes avatar' });
    }

    try {
      const { deleteFile } = await import('../services/s3.js');
      await deleteFile(user.avatar_url);
    } catch (err) {
      console.warn('No se pudo eliminar de S3:', err.message);
    }

    await run('UPDATE users SET avatar_url = NULL WHERE id = $1', [req.user.id]);

    res.json({ message: 'Avatar eliminado' });
  } catch (err) {
    console.error('Error eliminando avatar:', err);
    res.status(500).json({ message: 'Error del servidor' });
  }
});

// ============================================================
//  OBTENER PREFERENCIAS
// ============================================================
router.get('/preferences', authRequired, async (req, res) => {
  try {
    const user = await get(
      'SELECT default_category FROM users WHERE id = $1',
      [req.user.id]
    );

    if (!user) return res.status(404).json({ message: 'Usuario no encontrado' });

    res.json({
      defaultCategory: user.default_category || 'Hetero'
    });
  } catch (err) {
    console.error('Error obteniendo preferencias:', err);
    res.status(500).json({ message: 'Error del servidor' });
  }
});

// ============================================================
//  ACTUALIZAR CATEGORÍA PREDEFINIDA
// ============================================================
router.put('/preferences/category', authRequired, async (req, res) => {
  try {
    const { category } = req.body;
    const valid = ['Hetero', 'Gay', 'Bi', 'Trans'];

    if (!category || !valid.includes(category)) {
      return res.status(400).json({ message: 'Categoría inválida' });
    }

    await run(
      'UPDATE users SET default_category = $1 WHERE id = $2',
      [category, req.user.id]
    );

    res.json({
      message: 'Categoría actualizada',
      defaultCategory: category
    });
  } catch (err) {
    console.error('Error actualizando categoría:', err);
    res.status(500).json({ message: 'Error del servidor' });
  }
});

export default router;