const fs = require('fs')
const path = require('path')

function scanPersistedState(dir) {
  const state = { databaseBytes: 0, archiveBytes: 0, archiveCount: 0 }
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) {
        const size = fs.statSync(full).size
        const lower = entry.name.toLowerCase()
        if (lower.endsWith('.db') || lower.endsWith('.sqlite') || lower.endsWith('.sqlite3')) {
          const fd = fs.openSync(full, 'r')
          try {
            const header = Buffer.alloc(16)
            const read = fs.readSync(fd, header, 0, header.length, 0)
            if (read === 16 && header.equals(Buffer.from('SQLite format 3\0'))) state.databaseBytes += size
          } finally {
            fs.closeSync(fd)
          }
        } else if (lower.endsWith('.zip')) {
          const fd = fs.openSync(full, 'r')
          try {
            const header = Buffer.alloc(4)
            const read = fs.readSync(fd, header, 0, header.length, 0)
            if (read === 4 && header[0] === 0x50 && header[1] === 0x4b &&
                ((header[2] === 3 && header[3] === 4) ||
                 (header[2] === 5 && header[3] === 6) ||
                 (header[2] === 7 && header[3] === 8))) {
              state.archiveBytes += size
              state.archiveCount++
            }
          } finally {
            fs.closeSync(fd)
          }
        }
      }
    }
  }
  if (fs.existsSync(dir)) walk(dir)
  state.totalBytes = state.databaseBytes + state.archiveBytes
  return state
}

function isSubstantiallyRicher(candidate, incumbent) {
  if (candidate.archiveCount > incumbent.archiveCount &&
      candidate.archiveBytes >= incumbent.archiveBytes) return true
  const margin = Math.max(4096, Math.floor(incumbent.totalBytes * 0.1))
  return candidate.totalBytes > incumbent.totalBytes + margin
}

function backupPathFor(target, now) {
  let candidate = target + '.bak.' + now
  let suffix = 0
  while (fs.existsSync(candidate)) candidate = target + '.bak.' + now + '.' + (++suffix)
  return candidate
}

function comparePersistedState(a, b) {
  if (a.totalBytes !== b.totalBytes) return a.totalBytes - b.totalBytes
  if (a.archiveCount !== b.archiveCount) return a.archiveCount - b.archiveCount
  if (a.archiveBytes !== b.archiveBytes) return a.archiveBytes - b.archiveBytes
  return a.databaseBytes - b.databaseBytes
}

// Adopts the richest meaningful data tree without ever copying one tree over
// another. Rename operations keep the displaced, weaker tree as a backup.
function migrateServerData(options) {
  const root = options.appRoot
  const currentSlug = options.currentSlug
  const legacySlugs = options.legacySlugs || []
  const log = options.log || (() => {})
  const now = options.now == null ? Date.now() : options.now
  const target = path.join(root, currentSlug + '-server-data')

  const candidates = []
  if (fs.existsSync(target)) candidates.push({ path: target, current: true })
  for (const slug of legacySlugs) {
    if (slug === currentSlug) continue
    const candidate = path.join(root, slug + '-server-data')
    if (fs.existsSync(candidate)) candidates.push({ path: candidate, current: false })
  }

  for (const candidate of candidates) {
    try {
      candidate.state = scanPersistedState(candidate.path)
    } catch (error) {
      candidate.state = { databaseBytes: 0, archiveBytes: 0, archiveCount: 0, totalBytes: 0 }
      log('Server data scan failed for ' + candidate.path + ': ' + error.message)
    }
  }

  let richest = null
  for (const candidate of candidates) {
    if (!candidate.state.totalBytes) continue
    if (!richest || comparePersistedState(candidate.state, richest.state) > 0) richest = candidate
  }
  if (!richest || richest.current) return { adopted: null, target, state: richest && richest.state }

  let backup = null
  try {
    if (fs.existsSync(target)) {
      backup = backupPathFor(target, now)
      fs.renameSync(target, backup)
    }
    try {
      fs.renameSync(richest.path, target)
    } catch (error) {
      if (backup) {
        try { fs.renameSync(backup, target) } catch (restoreError) {
          error.message += '; target restore also failed: ' + restoreError.message
        }
      }
      throw error
    }
    return { adopted: richest.path, target, backup, state: richest.state }
  } catch (error) {
    log('Server data migration failed for ' + richest.path + ': ' + error.message)
    return { adopted: null, target, error }
  }
}

module.exports = { scanPersistedState, isSubstantiallyRicher, comparePersistedState, migrateServerData }