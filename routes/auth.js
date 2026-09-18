// routes/auth.js
import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { get, run } from '../database.js';
import { authRequired } from '../middleware/auth.js';
import { CONFIG } from '../config.js';

const router = express.Router();

// ============ REGISTRO ============
router.post('/register', async (req, res) => {
  try {
    const { name, username, password } = req.body;

    if (!name || !username || !password)
      return res.status(400).json({ message: 'Todos los campos son obligatorios' });
    if (name.trim().length < 2)
      return res.status(400).json({ message: 'El nombre debe tener al menos 2 caracteres' });
    if (username.length < 3 || !/^[a-zA-Z0-9_]+$/.test(username))
      return res.status(400).json({ message: 'Usuario inválido (mín. 3, solo letras/números/_)' });
    if (password.length < 6)
      return res.status(400).json({ message: 'La contraseña debe tener al menos 6 caracteres' });

    const existing = await get(
      'SELECT id FROM users WHERE LOWER(username) = LOWER($1)',
      [username]
    );
    if (existing) return res.status(409).json({ message: 'Este usuario ya está registrado' });

    const hash = await bcrypt.hash(password, 10);
    const user = await get(
      `INSERT INTO users (name, username, password, default_category)
       VALUES ($1, $2, $3, 'Hetero')
       RETURNING id, name, username, default_category`,
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
        defaultCategory: user.default_category
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

// ============ LOGIN ============
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password)
      return res.status(400).json({ message: 'Usuario y contraseña requeridos' });

    const user = await get(
      'SELECT * FROM users WHERE LOWER(username) = LOWER($1)',
      [username]
    );
    if (!user) return res.status(401).json({ message: 'Usuario o contraseña incorrectos' });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ message: 'Usuario o contraseña incorrectos' });

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
        defaultCategory: user.default_category || 'Hetero'
      }
    });
  } catch (err) {
    console.error('Error en login:', err);
    res.status(500).json({ message: 'Error del servidor' });
  }
});

// ============ PERFIL ACTUAL ============
router.get('/me', authRequired, async (req, res) => {
  try {
    const user = await get(
      'SELECT id, name, username, default_category, created_at FROM users WHERE id = $1',
      [req.user.id]
    );
    if (!user) return res.status(404).json({ message: 'Usuario no encontrado' });

    res.json({
      user: {
        id: user.id,
        name: user.name,
        username: user.username,
        defaultCategory: user.default_category || 'Hetero',
        createdAt: user.created_at
      }
    });
  } catch (err) {
    console.error('Error /me:', err);
    res.status(500).json({ message: 'Error del servidor' });
  }
});

// ============ OBTENER PREFERENCIAS ============
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

// ============ ACTUALIZAR CATEGORÍA PREDEFINIDA ============
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