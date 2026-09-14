// routes/auth.js
import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { get } from '../database.js';
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
      `INSERT INTO users (name, username, password) VALUES ($1, $2, $3)
       RETURNING id, name, username`,
      [name.trim(), username.trim(), hash]
    );

    const token = jwt.sign(
      { id: user.id, username: user.username, name: user.name },
      CONFIG.jwt.secret,
      { expiresIn: CONFIG.jwt.expiresIn }
    );

    res.status(201).json({ token, user });
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
      user: { id: user.id, name: user.name, username: user.username }
    });
  } catch (err) {
    console.error('Error en login:', err);
    res.status(500).json({ message: 'Error del servidor' });
  }
});

// ============ PERFIL ACTUAL ============
router.get('/me', async (req, res) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ message: 'No autenticado' });

  try {
    const payload = jwt.verify(token, CONFIG.jwt.secret);
    const user = await get(
      'SELECT id, name, username, created_at FROM users WHERE id = $1',
      [payload.id]
    );
    if (!user) return res.status(404).json({ message: 'Usuario no encontrado' });
    res.json({ user });
  } catch {
    res.status(401).json({ message: 'Token inválido' });
  }
});

export default router;