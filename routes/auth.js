// routes/auth.js
import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import { get, run } from '../database.js';
import { authRequired } from '../middleware/auth.js';
import { publicUrl, uploadFile, deleteFile } from '../services/s3.js';
import { CONFIG } from '../config.js';

const router = express.Router();

// ============================================================
//  MULTER PARA AVATAR
// ============================================================
const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const valid = ['image/jpeg', 'image/png', 'image/webp'];
    const ok = valid.includes(file.mimetype);
    cb(ok ? null : new Error('Formato no soportado. Usa JPG, PNG o WebP'), ok);
  }
});

// ============================================================
//  HELPERS
// ============================================================
function generateToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, name: user.name },
    CONFIG.jwt.secret,
    { expiresIn: CONFIG.jwt.expiresIn }
  );
}

function serializeUser(user) {
  return {
    id: user.id,
    name: user.name,
    username: user.username,
    bio: user.bio || '',
    defaultCategory: user.default_category || 'Hetero',
    avatarUrl: user.avatar_url ? publicUrl(user.avatar_url) : null,
    createdAt: user.created_at
  };
}

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
       RETURNING *`,
      [name.trim(), username.trim(), hash]
    );

    const token = generateToken(user);

    res.status(201).json({
      token,
      user: serializeUser(user)
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

    const token = generateToken(user);

    res.json({
      token,
      user: serializeUser(user)
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
      'SELECT * FROM users WHERE id = $1',
      [req.user.id]
    );

    if (!user) {
      return res.status(404).json({ message: 'Usuario no encontrado' });
    }

    res.json({ user: serializeUser(user) });

  } catch (err) {
    console.error('Error /me:', err);
    res.status(500).json({ message: 'Error del servidor' });
  }
});

// ============================================================
//  ACTUALIZAR PERFIL
// ============================================================
router.put('/profile', authRequired, async (req, res) => {
  try {
    const { name, username, bio } = req.body;
    const updates = [];
    const params = [];

    // Nombre
    if (name !== undefined) {
      if (name.trim().length < 2 || name.trim().length > 100) {
        return res.status(400).json({ message: 'Nombre inválido (2-100)' });
      }
      params.push(name.trim());
      updates.push(`name = $${params.length}`);
    }

    // Username
    if (username !== undefined) {
      if (username.length < 3 || !/^[a-zA-Z0-9_]+$/.test(username)) {
        return res.status(400).json({ message: 'Usuario inválido' });
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

    // Bio
    if (bio !== undefined) {
      if (bio.length > 200) {
        return res.status(400).json({ message: 'La bio no puede superar los 200 caracteres' });
      }
      params.push(bio.trim());
      updates.push(`bio = $${params.length}`);
    }

    if (updates.length === 0) {
      return res.status(400).json({ message: 'No hay nada que actualizar' });
    }

    params.push(req.user.id);

    const updated = await get(
      `UPDATE users SET ${updates.join(', ')} WHERE id = $${params.length}
       RETURNING *`,
      params
    );

    // Regenerar token (por si cambió username)
    const token = generateToken(updated);

    res.json({
      message: 'Perfil actualizado',
      token,
      user: serializeUser(updated)
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
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ message: 'La imagen es demasiado grande (máx 5 MB)' });
      }
      return res.status(400).json({ message: err.message });
    }

    if (!req.file) {
      return res.status(400).json({ message: 'No se recibió ninguna imagen' });
    }

    try {
      // Obtener avatar anterior para borrarlo
      const oldUser = await get(
        'SELECT avatar_url FROM users WHERE id = $1',
        [req.user.id]
      );

      if (oldUser?.avatar_url) {
        await deleteFile(oldUser.avatar_url).catch(() => {});
      }

      // Generar key única
      const ext = req.file.mimetype.split('/')[1].replace('jpeg', 'jpg');
      const filename = `avatars/${req.user.id}/${Date.now()}.${ext}`;

      // Subir a ToDus
      await uploadFile(filename, req.file.buffer, req.file.mimetype);

      // Guardar en BD
      const updated = await get(
        `UPDATE users SET avatar_url = $1 WHERE id = $2 RETURNING *`,
        [filename, req.user.id]
      );

      res.json({
        message: 'Avatar actualizado',
        user: serializeUser(updated)
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

    await deleteFile(user.avatar_url).catch(() => {});
    await run('UPDATE users SET avatar_url = NULL WHERE id = $1', [req.user.id]);

    res.json({ message: 'Avatar eliminado' });

  } catch (err) {
    console.error('Error eliminando avatar:', err);
    res.status(500).json({ message: 'Error del servidor' });
  }
});

// ============================================================
//  PREFERENCIAS
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
    console.error('Error preferences:', err);
    res.status(500).json({ message: 'Error del servidor' });
  }
});

// ============================================================
//  ACTUALIZAR CATEGORÍA PREDEFINIDA
// ============================================================
router.put('/preferences/category', authRequired, async (req, res) => {
  try {
    const { category } = req.body;
    const valid = CONFIG.categories.list;

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
