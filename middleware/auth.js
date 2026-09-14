// middleware/auth.js
import jwt from 'jsonwebtoken';
import { CONFIG } from '../config.js';

export function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ message: 'Token no proporcionado' });
  }

  try {
    req.user = jwt.verify(token, CONFIG.jwt.secret);
    next();
  } catch {
    res.status(401).json({ message: 'Token inválido o expirado' });
  }
}

export function authOptional(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (token) {
    try {
      req.user = jwt.verify(token, CONFIG.jwt.secret);
    } catch {
      req.user = null;
    }
  } else {
    req.user = null;
  }
  next();
}