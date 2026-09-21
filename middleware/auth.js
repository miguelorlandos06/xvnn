// middleware/auth.js
import jwt from 'jsonwebtoken';
import { CONFIG } from '../config.js';

// ============ AUTENTICACIÓN OBLIGATORIA ============
export function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ message: 'Token no proporcionado' });
  }

  try {
    req.user = jwt.verify(token, CONFIG.jwt.secret);
    next();
  } catch (err) {
    res.status(401).json({ message: 'Token inválido o expirado' });
  }
}

// ============ AUTENTICACIÓN OPCIONAL ============
// Extrae el usuario si hay token válido, pero no bloquea si no hay
export function authOptional(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (token) {
    try {
      req.user = jwt.verify(token, CONFIG.jwt.secret);
    } catch (err) {
      req.user = null;
    }
  } else {
    req.user = null;
  }
  next();
}