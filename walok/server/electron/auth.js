const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')

const JWT_SECRET = process.env.EXAMPLE_CAFE_JWT_SECRET || 'example-cafe-server-secret-key-change-me'
const TOKEN_EXPIRY = '7d'

function hashPassword(password) {
  return bcrypt.hashSync(password, 10)
}

function verifyPassword(password, hash) {
  return bcrypt.compareSync(password, hash)
}

function generateToken(userId, username) {
  return jwt.sign({ userId, username }, JWT_SECRET, { expiresIn: TOKEN_EXPIRY })
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET)
  } catch (e) {
    return null
  }
}

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' })
  }

  const token = authHeader.slice(7)
  const decoded = verifyToken(token)
  if (!decoded) {
    return res.status(401).json({ error: 'Invalid or expired token' })
  }

  req.user = decoded
  next()
}

module.exports = { hashPassword, verifyPassword, generateToken, verifyToken, authMiddleware }
