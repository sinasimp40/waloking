const express = require('express')
const cors = require('cors')
const multer = require('multer')
const path = require('path')
const fs = require('fs')
const { getSavesDir, runQuery, getOne, getAll } = require('./db')
const { hashPassword, verifyPassword, generateToken, authMiddleware } = require('./auth')

function sanitizeName(name) {
  return (name || '').replace(/[^a-zA-Z0-9_\-. ]/g, '').trim().slice(0, 100)
}

function migrateUserFolders(appRoot) {
  try {
    const savesDir = getSavesDir(appRoot)
    const { getAll } = require('./db')
    const users = getAll('SELECT id, username FROM users')
    for (const user of users) {
      const oldDir = path.join(savesDir, String(user.id))
      const newDir = path.join(savesDir, sanitizeName(user.username))
      if (oldDir === newDir) continue
      if (!fs.existsSync(oldDir)) continue
      if (!fs.existsSync(newDir)) {
        fs.renameSync(oldDir, newDir)
        console.log(`Migrated save folder: ${user.id} -> ${user.username}`)
      } else {
        const files = fs.readdirSync(oldDir)
        for (const file of files) {
          const src = path.join(oldDir, file)
          const dest = path.join(newDir, file)
          if (!fs.existsSync(dest)) {
            fs.renameSync(src, dest)
          }
        }
        try { fs.rmSync(oldDir, { recursive: true, force: true }) } catch {}
        console.log(`Merged save folder: ${user.id} -> ${user.username}`)
      }
    }
  } catch (e) {
    console.error('Migration error:', e.message)
  }
}

function getUserDir(appRoot, username) {
  const dir = path.join(getSavesDir(appRoot), sanitizeName(username))
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}

function createApi(appRoot) {
  const app = express()

  app.use(cors())
  app.use(express.json())

  const upload = multer({
    dest: path.join(getSavesDir(appRoot), '_tmp'),
    limits: { fileSize: 500 * 1024 * 1024 }
  })

  migrateUserFolders(appRoot)

  app.get('/api/status', (req, res) => {
    res.json({ status: 'ok', server: 'EXAMPLE CAFE Server' })
  })

  // Graceful shutdown endpoint used by the launcher (or any local automation)
  // to ask the server.exe to quit so a pending OTA update can be applied on
  // the next startup. Loopback-only (Express's trust-proxy is off here, so
  // req.ip reflects the actual socket peer) — never accept this from the
  // public network. Lazy-required so the HTTP-only test of api.js doesn't
  // need to import electron.
  app.post('/api/internal/quit-for-update', (req, res) => {
    // Use req.socket.remoteAddress directly (NOT req.ip) so a future
    // trust-proxy setting on the parent app can never let an X-Forwarded-For
    // header spoof a loopback peer. Compare against the exact set of
    // loopback forms Node may report.
    const rawPeer = (req.socket && req.socket.remoteAddress) || ''
    const peer = String(rawPeer).toLowerCase()
    const LOOPBACKS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
    if (!LOOPBACKS.has(peer)) {
      return res.status(403).json({ error: 'forbidden: loopback only' })
    }
    const reason = (req.body && typeof req.body.reason === 'string') ? req.body.reason.slice(0, 200) : ''
    res.json({ ok: true, message: 'quitting in ~250ms', reason })
    try {
      const updater = require('./updater')
      updater.gracefulQuitForUpdate(reason || 'launcher requested quit-for-update')
    } catch (e) {
      console.error('[quit-for-update] failed to invoke updater.gracefulQuitForUpdate:', e.message)
    }
  })

  app.post('/api/auth/register', (req, res) => {
    try {
      const { username, password } = req.body
      if (!username || !password) {
        return res.status(400).json({ error: 'Username and password are required' })
      }
      if (username.length < 3 || username.length > 30) {
        return res.status(400).json({ error: 'Username must be 3-30 characters' })
      }
      if (password.length < 4) {
        return res.status(400).json({ error: 'Password must be at least 4 characters' })
      }

      const sanitized = sanitizeName(username)
      if (!sanitized) {
        return res.status(400).json({ error: 'Invalid username' })
      }

      const existing = getOne('SELECT id FROM users WHERE username = ?', [sanitized])
      if (existing) {
        return res.status(409).json({ error: 'Username already taken' })
      }

      const hash = hashPassword(password)
      const result = runQuery('INSERT INTO users (username, password_hash) VALUES (?, ?)', [sanitized, hash])

      getUserDir(appRoot, sanitized)

      const token = generateToken(result.lastInsertRowid, sanitized)
      res.json({ success: true, token, user: { id: result.lastInsertRowid, username: sanitized } })
    } catch (err) {
      console.error('Register error:', err.message)
      res.status(500).json({ error: 'Registration failed' })
    }
  })

  app.post('/api/auth/login', (req, res) => {
    try {
      const { username, password } = req.body
      if (!username || !password) {
        return res.status(400).json({ error: 'Username and password are required' })
      }

      const user = getOne('SELECT * FROM users WHERE username = ?', [sanitizeName(username)])
      if (!user) {
        return res.status(401).json({ error: 'Invalid username or password' })
      }

      if (!verifyPassword(password, user.password_hash)) {
        return res.status(401).json({ error: 'Invalid username or password' })
      }

      runQuery("UPDATE users SET last_login_at = datetime('now') WHERE id = ?", [user.id])

      const token = generateToken(user.id, user.username)
      res.json({ success: true, token, user: { id: user.id, username: user.username } })
    } catch (err) {
      console.error('Login error:', err.message)
      res.status(500).json({ error: 'Login failed' })
    }
  })

  app.get('/api/saves', authMiddleware, (req, res) => {
    try {
      const gameName = req.query.gameName
      let saves
      if (gameName) {
        saves = getAll('SELECT id, game_name, save_name, archive_size, created_at, updated_at FROM saves WHERE user_id = ? AND game_name = ? ORDER BY updated_at DESC', [req.user.userId, gameName])
      } else {
        saves = getAll('SELECT id, game_name, save_name, archive_size, created_at, updated_at FROM saves WHERE user_id = ? ORDER BY updated_at DESC', [req.user.userId])
      }
      res.json({ success: true, saves })
    } catch (err) {
      console.error('List saves error:', err.message)
      res.status(500).json({ error: 'Failed to list saves' })
    }
  })

  app.post('/api/saves', authMiddleware, upload.single('archive'), (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' })
      }

      const gameName = sanitizeName(req.body.gameName)
      const saveName = sanitizeName(req.body.saveName) || 'default'

      if (!gameName) {
        fs.unlinkSync(req.file.path)
        return res.status(400).json({ error: 'Game name is required' })
      }

      const userId = req.user.userId
      const username = req.user.username

      const userDir = getUserDir(appRoot, username)

      const existing = getOne('SELECT id, archive_filename FROM saves WHERE user_id = ? AND game_name = ? AND save_name = ?', [userId, gameName, saveName])

      if (existing) {
        const oldFile = path.join(userDir, existing.archive_filename)
        if (fs.existsSync(oldFile)) {
          try { fs.unlinkSync(oldFile) } catch {}
        }

        const archiveFilename = `${sanitizeName(gameName)}-${Date.now()}.zip`
        const destPath = path.join(userDir, archiveFilename)
        fs.renameSync(req.file.path, destPath)

        runQuery("UPDATE saves SET archive_filename = ?, archive_size = ?, updated_at = datetime('now') WHERE id = ?", [archiveFilename, req.file.size, existing.id])

        res.json({ success: true, saveId: existing.id, message: 'Save updated (replaced old save)' })
      } else {
        const archiveFilename = `${sanitizeName(gameName)}-${Date.now()}.zip`
        const destPath = path.join(userDir, archiveFilename)

        fs.renameSync(req.file.path, destPath)

        const result = runQuery('INSERT INTO saves (user_id, game_name, save_name, archive_filename, archive_size) VALUES (?, ?, ?, ?, ?)', [userId, gameName, saveName, archiveFilename, req.file.size])

        res.json({ success: true, saveId: result.lastInsertRowid, message: 'Save created' })
      }
    } catch (err) {
      console.error('Upload save error:', err.message)
      if (req.file && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path)
      }
      res.status(500).json({ error: 'Failed to save' })
    }
  })

  app.get('/api/saves/:id/download', authMiddleware, (req, res) => {
    try {
      const save = getOne('SELECT * FROM saves WHERE id = ? AND user_id = ?', [req.params.id, req.user.userId])
      if (!save) {
        return res.status(404).json({ error: 'Save not found' })
      }

      const userDir = getUserDir(appRoot, req.user.username)
      let filePath = path.join(userDir, save.archive_filename)

      if (!fs.existsSync(filePath)) {
        let found = false
        try {
          const files = fs.readdirSync(userDir).filter(f => !f.startsWith('.') && !f.startsWith('_'))
          const gameKey = sanitizeName(save.game_name).toLowerCase().replace(/[\s\-_.]/g, '')
          if (gameKey.length > 0) {
            for (const f of files) {
              const fileKey = f.toLowerCase().replace(/[\s\-_.]/g, '').replace(/\.zip$/, '')
              if (fileKey.startsWith(gameKey) || fileKey.includes(gameKey)) {
                filePath = path.join(userDir, f)
                runQuery('UPDATE saves SET archive_filename = ? WHERE id = ?', [f, save.id])
                found = true
                break
              }
            }
          }
          if (!found && files.length === 1) {
            const allSaves = getAll('SELECT id FROM saves WHERE user_id = ?', [req.user.userId])
            if (allSaves.length === 1) {
              filePath = path.join(userDir, files[0])
              runQuery('UPDATE saves SET archive_filename = ? WHERE id = ?', [files[0], save.id])
              found = true
            }
          }
        } catch (e) {}

        if (!found || !fs.existsSync(filePath)) {
          return res.status(404).json({ error: 'Save file not found on server. Please re-upload your save.' })
        }
      }

      res.setHeader('Content-Disposition', `attachment; filename="${save.game_name}-${save.save_name}.zip"`)
      res.setHeader('Content-Type', 'application/zip')
      const stream = fs.createReadStream(filePath)
      stream.pipe(res)
    } catch (err) {
      console.error('Download save error:', err.message)
      res.status(500).json({ error: 'Failed to download save' })
    }
  })

  app.delete('/api/saves/:id', authMiddleware, (req, res) => {
    try {
      const save = getOne('SELECT * FROM saves WHERE id = ? AND user_id = ?', [req.params.id, req.user.userId])
      if (!save) {
        return res.status(404).json({ error: 'Save not found' })
      }

      const userDir = getUserDir(appRoot, req.user.username)
      const filePath = path.join(userDir, save.archive_filename)
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath)
      }

      runQuery('DELETE FROM saves WHERE id = ?', [save.id])
      res.json({ success: true, message: 'Save deleted' })
    } catch (err) {
      console.error('Delete save error:', err.message)
      res.status(500).json({ error: 'Failed to delete save' })
    }
  })

  app.get('/api/admin/users', (req, res) => {
    try {
      const users = getAll('SELECT id, username, created_at, last_login_at FROM users ORDER BY created_at DESC')
      const saveCounts = getAll('SELECT user_id, COUNT(*) as count, SUM(archive_size) as total_size FROM saves GROUP BY user_id')
      const countMap = {}
      saveCounts.forEach(s => { countMap[s.user_id] = { count: s.count, totalSize: s.total_size } })

      const result = users.map(u => ({
        ...u,
        saveCount: countMap[u.id]?.count || 0,
        totalSize: countMap[u.id]?.totalSize || 0
      }))

      res.json({ success: true, users: result })
    } catch (err) {
      console.error('Admin users error:', err.message)
      res.status(500).json({ error: 'Failed to get users' })
    }
  })

  app.get('/api/admin/stats', (req, res) => {
    try {
      const userCount = getOne('SELECT COUNT(*) as count FROM users')
      const saveCount = getOne('SELECT COUNT(*) as count FROM saves')
      const totalSize = getOne('SELECT COALESCE(SUM(archive_size), 0) as total FROM saves')

      res.json({
        success: true,
        stats: {
          users: userCount.count,
          saves: saveCount.count,
          totalSize: totalSize.total
        }
      })
    } catch (err) {
      res.status(500).json({ error: 'Failed to get stats' })
    }
  })

  app.get('/api/admin/users/:id/saves', (req, res) => {
    try {
      const userId = req.params.id
      const saves = getAll('SELECT id, game_name, save_name, archive_size, created_at, updated_at FROM saves WHERE user_id = ? ORDER BY updated_at DESC', [userId])
      res.json({ success: true, saves })
    } catch (err) {
      res.status(500).json({ error: 'Failed to get user saves' })
    }
  })

  app.delete('/api/admin/users/:id', (req, res) => {
    try {
      const userId = req.params.id
      const user = getOne('SELECT id, username FROM users WHERE id = ?', [userId])
      if (!user) {
        return res.status(404).json({ error: 'User not found' })
      }

      const userSaves = getAll('SELECT id, archive_filename FROM saves WHERE user_id = ?', [userId])
      const userDir = path.join(getSavesDir(appRoot), sanitizeName(user.username))

      userSaves.forEach(save => {
        const filePath = path.join(userDir, save.archive_filename)
        if (fs.existsSync(filePath)) {
          try { fs.unlinkSync(filePath) } catch {}
        }
      })

      if (fs.existsSync(userDir)) {
        try { fs.rmSync(userDir, { recursive: true, force: true }) } catch {}
      }

      runQuery('DELETE FROM saves WHERE user_id = ?', [userId])
      runQuery('DELETE FROM users WHERE id = ?', [userId])

      res.json({ success: true, message: `User "${user.username}" and all their saves deleted` })
    } catch (err) {
      console.error('Delete user error:', err.message)
      res.status(500).json({ error: 'Failed to delete user' })
    }
  })

  app.delete('/api/admin/saves/:id', (req, res) => {
    try {
      const saveId = req.params.id
      const save = getOne('SELECT * FROM saves WHERE id = ?', [saveId])
      if (!save) {
        return res.status(404).json({ error: 'Save not found' })
      }

      const user = getOne('SELECT username FROM users WHERE id = ?', [save.user_id])
      const folderName = user ? sanitizeName(user.username) : String(save.user_id)
      const filePath = path.join(getSavesDir(appRoot), folderName, save.archive_filename)
      if (fs.existsSync(filePath)) {
        try { fs.unlinkSync(filePath) } catch {}
      }

      runQuery('DELETE FROM saves WHERE id = ?', [saveId])
      res.json({ success: true, message: 'Save deleted' })
    } catch (err) {
      console.error('Admin delete save error:', err.message)
      res.status(500).json({ error: 'Failed to delete save' })
    }
  })

  return app
}

module.exports = { createApi }
