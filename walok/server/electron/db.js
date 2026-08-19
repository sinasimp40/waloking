const path = require('path')
const fs = require('fs')
const { SERVER_DATA_DIR, SERVER_DB_FILE, LEGACY_DB_FILES } = require('./brand')

let db = null
let dbPath = ''

function getDataDir(appRoot) {
  const dataDir = path.join(appRoot, SERVER_DATA_DIR)
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true })
  }
  return dataDir
}

function getSavesDir(appRoot) {
  const savesDir = path.join(getDataDir(appRoot), 'saves')
  if (!fs.existsSync(savesDir)) {
    fs.mkdirSync(savesDir, { recursive: true })
  }
  return savesDir
}

async function initDatabase(appRoot) {
  const initSqlJs = require('sql.js')
  const SQL = await initSqlJs()

  dbPath = path.join(getDataDir(appRoot), SERVER_DB_FILE)

  // Migrate any older brand's .db to the current SERVER_DB_FILE name —
  // first match wins. LEGACY_DB_FILES is generated from
  // LEGACY_BRAND_SLUGS in brand.js, so adding a past brand there
  // automatically extends this migration.
  for (const oldName of LEGACY_DB_FILES) {
    const oldDbPath = path.join(getDataDir(appRoot), oldName)
    if (!fs.existsSync(dbPath) && fs.existsSync(oldDbPath)) {
      try { fs.renameSync(oldDbPath, dbPath) } catch (e) {}
      break
    }
  }

  if (fs.existsSync(dbPath)) {
    const fileBuffer = fs.readFileSync(dbPath)
    db = new SQL.Database(fileBuffer)
  } else {
    db = new SQL.Database()
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      last_login_at TEXT
    )
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS saves (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      game_name TEXT NOT NULL,
      save_name TEXT NOT NULL,
      archive_filename TEXT NOT NULL,
      archive_size INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `)

  try {
    db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_saves_user_game_save ON saves(user_id, game_name, save_name)')
    saveToFile()
  } catch (e) {}

  saveToFile()
  return db
}

function saveToFile() {
  if (!db || !dbPath) return
  try {
    const data = db.export()
    const buffer = Buffer.from(data)
    fs.writeFileSync(dbPath, buffer)
  } catch (e) {
    console.error('Failed to save database:', e.message)
  }
}

function getDb() {
  return db
}

function runQuery(sql, params = []) {
  if (!db) return null
  db.run(sql, params)
  const changes = db.getRowsModified()
  const lastId = getLastInsertRowId()
  saveToFile()
  return { changes, lastInsertRowid: lastId }
}

function getLastInsertRowId() {
  if (!db) return 0
  try {
    const stmt = db.prepare('SELECT last_insert_rowid()')
    if (stmt.step()) {
      const val = stmt.get()[0]
      stmt.free()
      return val || 0
    }
    stmt.free()
  } catch (e) {}
  return 0
}

function getOne(sql, params = []) {
  if (!db) return null
  const stmt = db.prepare(sql)
  stmt.bind(params)
  if (stmt.step()) {
    const cols = stmt.getColumnNames()
    const vals = stmt.get()
    stmt.free()
    const row = {}
    cols.forEach((c, i) => { row[c] = vals[i] })
    return row
  }
  stmt.free()
  return null
}

function getAll(sql, params = []) {
  if (!db) return []
  const stmt = db.prepare(sql)
  stmt.bind(params)
  const rows = []
  const cols = stmt.getColumnNames()
  while (stmt.step()) {
    const vals = stmt.get()
    const row = {}
    cols.forEach((c, i) => { row[c] = vals[i] })
    rows.push(row)
  }
  stmt.free()
  return rows
}

module.exports = { initDatabase, getDb, getDataDir, getSavesDir, runQuery, getOne, getAll, saveToFile }
