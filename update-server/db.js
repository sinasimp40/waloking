const fs = require('fs')
const path = require('path')
const Database = require('better-sqlite3')

// DATA_DIR is the on-disk home of launcher.db (the customer registry).
// Defaults to <update-server>/data so production behavior is unchanged.
// OTA_DATA_DIR lets integration tests point a forked server at a temp DB
// without polluting the real customer table — required by
// test-build-endpoint.js which spins up an isolated server to lock in the
// install pre-flight serialization guarantee.
const DATA_DIR = process.env.OTA_DATA_DIR
  ? path.resolve(process.env.OTA_DATA_DIR)
  : path.join(__dirname, 'data')
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })

const DB_PATH = path.join(DATA_DIR, 'launcher.db')
const db = new Database(DB_PATH)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

db.exec(`
CREATE TABLE IF NOT EXISTS customers (
  channel                  TEXT PRIMARY KEY,
  brand_name               TEXT NOT NULL,
  subtitle                 TEXT NOT NULL,
  update_server            TEXT NOT NULL,
  logo                     TEXT,
  launcher_version         TEXT,
  server_version           TEXT,
  launcher_published_at    INTEGER,
  server_published_at      INTEGER,
  last_build_at            INTEGER,
  created_at               INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000),
  updated_at               INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
);
CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT
);
`)

// Idempotent column adds for installs whose DB pre-dates the version/timestamp
// columns. SQLite has no IF NOT EXISTS for ADD COLUMN, so we inspect PRAGMA
// table_info first.
;(function ensureColumns() {
  const cols = new Set(db.prepare('PRAGMA table_info(customers)').all().map(r => r.name))
  const adds = [
    ['launcher_version',      'TEXT'],
    ['server_version',        'TEXT'],
    ['launcher_published_at', 'INTEGER'],
    ['server_published_at',   'INTEGER'],
    ['last_build_at',         'INTEGER'],
    // Rebump tracking — incremented every time the SAME version is
    // republished (only "Build From Uploaded Source" allows that). Reset to 0
    // whenever the version actually advances, so the counter always reflects
    // "how many times the operator re-shipped this exact version".
    ['launcher_rebuild_count', 'INTEGER'],
    ['server_rebuild_count',   'INTEGER'],
    ['launcher_rebuilt_at',    'INTEGER'],
    ['server_rebuilt_at',      'INTEGER'],
    // Per-customer "receive OTA updates" master switch. NULL on legacy rows
    // is treated as enabled (=1) by rowToCustomer below, so existing customers
    // never silently lose updates after migration. Operator toggles via the
    // admin UI; when 0 the server returns 404 for /updates/<channel>/latest.json
    // so launchers see "no update available" without any client-side change.
    ['updates_enabled',        'INTEGER'],
  ]
  for (const [name, type] of adds) {
    if (!cols.has(name)) db.exec('ALTER TABLE customers ADD COLUMN ' + name + ' ' + type)
  }
})()

function rowToCustomer(r) {
  if (!r) return null
  return {
    channel: r.channel,
    brandName: r.brand_name,
    subtitle: r.subtitle,
    updateServer: r.update_server,
    logo: r.logo || undefined,
    launcherVersion: r.launcher_version || null,
    serverVersion: r.server_version || null,
    launcherPublishedAt: r.launcher_published_at || null,
    serverPublishedAt: r.server_published_at || null,
    lastBuildAt: r.last_build_at || null,
    launcherRebuildCount: r.launcher_rebuild_count || 0,
    serverRebuildCount: r.server_rebuild_count || 0,
    launcherRebuiltAt: r.launcher_rebuilt_at || null,
    serverRebuiltAt: r.server_rebuilt_at || null,
    // NULL (legacy row, never toggled) ⇒ treat as ENABLED. Only an explicit
    // 0 disables OTA delivery. This means the migration does NOT silently
    // disable updates for any existing customer.
    updatesEnabled: (r.updates_enabled === null || r.updates_enabled === undefined)
      ? true
      : !!r.updates_enabled,
  }
}

const stmts = {
  list: db.prepare('SELECT * FROM customers ORDER BY brand_name COLLATE NOCASE'),
  get: db.prepare('SELECT * FROM customers WHERE channel = ?'),
  insert: db.prepare(`INSERT INTO customers (channel, brand_name, subtitle, update_server, logo)
                      VALUES (@channel, @brandName, @subtitle, @updateServer, @logo)`),
  update: db.prepare(`UPDATE customers
                       SET brand_name=@brandName,
                           subtitle=@subtitle,
                           update_server=@updateServer,
                           logo=@logo,
                           updated_at=CAST(strftime('%s','now') AS INTEGER) * 1000
                       WHERE channel=@channel`),
  delete: db.prepare('DELETE FROM customers WHERE channel = ?'),
  setLauncherVersion: db.prepare(`UPDATE customers SET launcher_version=?, launcher_published_at=?, updated_at=CAST(strftime('%s','now') AS INTEGER) * 1000 WHERE channel=?`),
  setServerVersion: db.prepare(`UPDATE customers SET server_version=?, server_published_at=?, updated_at=CAST(strftime('%s','now') AS INTEGER) * 1000 WHERE channel=?`),
  // Rebump bookkeeping — increment the per-version republish counter.
  // Called when the new version equals the previously stored version.
  bumpLauncherRebuild: db.prepare(`UPDATE customers SET launcher_rebuild_count=COALESCE(launcher_rebuild_count,0)+1, launcher_rebuilt_at=? WHERE channel=?`),
  bumpServerRebuild:   db.prepare(`UPDATE customers SET server_rebuild_count=COALESCE(server_rebuild_count,0)+1,   server_rebuilt_at=?   WHERE channel=?`),
  // Reset the rebump counter when the version actually changes.
  resetLauncherRebuild: db.prepare(`UPDATE customers SET launcher_rebuild_count=0, launcher_rebuilt_at=NULL WHERE channel=?`),
  resetServerRebuild:   db.prepare(`UPDATE customers SET server_rebuild_count=0,   server_rebuilt_at=NULL   WHERE channel=?`),
  setLastBuild: db.prepare(`UPDATE customers SET last_build_at=?, updated_at=CAST(strftime('%s','now') AS INTEGER) * 1000 WHERE channel=?`),
  // Cheap one-field toggle endpoint — avoids round-tripping the full upsert
  // payload from the admin UI just to flip a single boolean.
  setUpdatesEnabled: db.prepare(`UPDATE customers SET updates_enabled=?, updated_at=CAST(strftime('%s','now') AS INTEGER) * 1000 WHERE channel=?`),
  metaGet: db.prepare('SELECT v FROM meta WHERE k = ?'),
  metaSet: db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v'),
}

// Rewrite a legacy shared `branding/logo.<ext>` reference to the per-channel
// `branding/<channel>-logo.<ext>` convention used by the upload pipeline.
// This is the canonical path the admin upload endpoint also writes to, so
// once a row has been rewritten the operator can re-upload via the UI and
// the file will land at the right place automatically.
function rewriteLegacyLogoPath(channel, logo) {
  if (!logo || !channel) return logo || null
  const m = /^branding[/\\]logo(\.[a-z0-9]+)$/i.exec(String(logo))
  if (!m) return logo
  return 'branding/' + channel + '-logo' + m[1].toLowerCase()
}

// Resolve a `branding/...`-style path against a brandingDir argument. The
// migration/backfill helpers receive `brandingDir = repoRoot/branding`, so the
// stored path `branding/foo.png` resolves to `repoRoot/branding/../branding/foo.png`
// which is the same file. Pulled out so rewrite + copy use the same logic.
function resolveBrandingPath(brandingDir, p) {
  if (!p) return null
  if (path.isAbsolute(p)) return p
  if (!brandingDir) return null
  return path.join(brandingDir, '..', p)
}

// One-shot backfill for installs whose customers were imported BEFORE
// rewriteLegacyLogoPath existed (they still point at the shared
// `branding/logo.<ext>` source). Idempotent — keyed off a meta flag, but the
// flag is ONLY set when every required physical copy succeeded. Partial
// failures leave the flag unset so the next server startup retries.
//
// We COPY (not move) the shared file once per dependent channel, so several
// legacy customers pointing at the same shared file each end up with their
// own per-channel source. The original shared file is deleted only after
// every copy succeeds.
function backfillLogoPaths(brandingDir) {
  if (getMeta('logo_paths_backfilled_v1') === '1') return { rewritten: 0, alreadyDone: true }
  let rewritten = 0
  const failures = []
  const all = listCustomers()
  const renames = []
  for (const c of all) {
    if (!c.logo) continue
    const next = rewriteLegacyLogoPath(c.channel, c.logo)
    if (next === c.logo) continue
    renames.push({ channel: c.channel, from: c.logo, to: next, customer: c })
  }
  // Phase 1: physically migrate the shared files. If any copy fails, abort
  // BEFORE rewriting the DB so we don't leave rows pointing at non-existent
  // files. (Architect-flagged: previously the rewrite happened first and copy
  // failures were swallowed, so a hard syncLogo error would block all builds.)
  const sourcesToDelete = new Set()
  if (renames.length > 0) {
    if (!brandingDir) {
      return { rewritten: 0, failures: ['brandingDir not provided — backfill deferred'], renames }
    }
    for (const r of renames) {
      const fromPath = resolveBrandingPath(brandingDir, r.from)
      const toPath = resolveBrandingPath(brandingDir, r.to)
      try {
        let fromStat = null
        try { fromStat = fs.statSync(fromPath) } catch (e) {}
        if (!fromStat) {
          // Source file missing on disk. We can still rewrite the DB row to
          // the per-channel path — the operator's next admin upload will land
          // there. Skip the copy; do not record this as a failure.
          continue
        }
        if (!fromStat.isFile()) {
          failures.push(r.channel + ': legacy logo ' + r.from + ' is not a regular file (got ' + (fromStat.isDirectory() ? 'directory' : 'special') + ')')
          continue
        }
        // Destination already exists? Only OK if it is a regular file (we
        // assume idempotent prior copy). Anything else (directory, symlink
        // to nowhere, special file) is a hard failure — silently skipping
        // would leave the operator with a broken install AND a false success.
        if (fs.existsSync(toPath)) {
          let toStat = null
          try { toStat = fs.statSync(toPath) } catch (e) {}
          if (!toStat || !toStat.isFile()) {
            failures.push(r.channel + ': destination ' + r.to + ' exists but is not a regular file')
            continue
          }
          // Dest already a file — assume prior successful copy, skip.
          sourcesToDelete.add(fromPath)
          continue
        }
        fs.copyFileSync(fromPath, toPath)
        sourcesToDelete.add(fromPath)
      } catch (e) {
        failures.push(r.channel + ': copy ' + r.from + ' -> ' + r.to + ' failed: ' + e.message)
      }
    }
    if (failures.length > 0) {
      return { rewritten: 0, failures, renames, retrying: true }
    }
  }
  // Phase 2: rewrite the DB rows now that every required copy is on disk.
  for (const r of renames) {
    stmts.update.run({
      channel: r.customer.channel,
      brandName: r.customer.brandName,
      subtitle: r.customer.subtitle,
      updateServer: r.customer.updateServer,
      logo: r.to,
    })
    rewritten++
  }
  // Phase 3: drop the shared source files now that every channel has its own.
  for (const src of sourcesToDelete) {
    try { if (fs.existsSync(src)) fs.unlinkSync(src) } catch (e) {}
  }
  setMeta('logo_paths_backfilled_v1', '1')
  return { rewritten, renames }
}

function listCustomers() { return stmts.list.all().map(rowToCustomer) }
function getCustomer(channel) { return rowToCustomer(stmts.get.get(channel)) }
function upsertCustomer(c) {
  const data = {
    channel: c.channel,
    brandName: c.brandName,
    subtitle: c.subtitle,
    updateServer: c.updateServer,
    logo: c.logo || null,
  }
  if (stmts.get.get(c.channel)) stmts.update.run(data)
  else stmts.insert.run(data)
  return getCustomer(c.channel)
}
function deleteCustomer(channel) {
  const r = stmts.delete.run(channel)
  return r.changes > 0
}
function getMeta(k) { const r = stmts.metaGet.get(k); return r ? r.v : null }
function setMeta(k, v) { stmts.metaSet.run(k, v == null ? null : String(v)) }

// Update the published launcher/server version + publish timestamp on the
// customer row. Called from the build pipeline AND from the manual upload
// flow so the admin UI can show what's currently shipped per customer
// without having to re-read every latest.json off disk.
//
// Rebump tracking: if the new version EQUALS the version already on file, the
// per-version republish counter is incremented and `*_rebuilt_at` is set so
// the admin UI can display "Rebump ×N · <date>". If the version actually
// changed (forward OR backward — backward is technically a downgrade but the
// upload endpoint already guards that, so we just trust whatever was passed),
// the counter is reset to 0 and the rebuild timestamp is cleared. The reset
// path is critical: without it, bumping from v1.0.2 → v1.0.3 → v1.0.2 would
// show a stale "Rebump ×3" against v1.0.2 even on its first re-publish.
//
// Atomicity: read-then-write is wrapped in a sqlite transaction so the
// "previous version" lookup and the version+counter update appear as a
// single step. better-sqlite3 is synchronous and the build pipeline already
// serializes per-channel via job-runner's channel mutex, but the deprecated
// upload endpoints don't use job-runner — the transaction is defense-in-depth
// against a future code path that calls record*Published outside the mutex.
const _recordLauncherTx = db.transaction((channel, version, now) => {
  const cur = stmts.get.get(channel)
  const isRebump = !!(cur && cur.launcher_version === version)
  stmts.setLauncherVersion.run(version, now, channel)
  if (isRebump) stmts.bumpLauncherRebuild.run(now, channel)
  else stmts.resetLauncherRebuild.run(channel)
})
const _recordServerTx = db.transaction((channel, version, now) => {
  const cur = stmts.get.get(channel)
  const isRebump = !!(cur && cur.server_version === version)
  stmts.setServerVersion.run(version, now, channel)
  if (isRebump) stmts.bumpServerRebuild.run(now, channel)
  else stmts.resetServerRebuild.run(channel)
})
function recordLauncherPublished(channel, version, ts) {
  if (!channel || !version) return
  _recordLauncherTx(channel, version, ts || Date.now())
}
function recordServerPublished(channel, version, ts) {
  if (!channel || !version) return
  _recordServerTx(channel, version, ts || Date.now())
}
function recordBuild(channel, ts) {
  if (!channel) return
  stmts.setLastBuild.run(ts || Date.now(), channel)
}

// Master switch for OTA delivery to a single customer. Stored as 0/1.
// Returns the updated customer row, or null if the channel doesn't exist.
function setUpdatesEnabled(channel, enabled) {
  if (!channel) return null
  if (!stmts.get.get(channel)) return null
  stmts.setUpdatesEnabled.run(enabled ? 1 : 0, channel)
  return getCustomer(channel)
}

// Baseline refresh tracking — when did the operator last upload a Full Repo
// zip for this kind. Stored in the meta table so it survives server restarts
// without needing yet another column on customers (it's not per-customer —
// the baseline cache is shared across all customers in this OTA install).
function getBaselineRefreshedAt(kind) {
  if (kind !== 'launcher' && kind !== 'server') return null
  const v = getMeta('baseline_' + kind + '_refreshed_at')
  if (!v) return null
  const n = parseInt(v, 10)
  return Number.isFinite(n) ? n : null
}
function setBaselineRefreshedAt(kind, ts) {
  if (kind !== 'launcher' && kind !== 'server') return
  setMeta('baseline_' + kind + '_refreshed_at', String(ts || Date.now()))
}

// Master-source updated tracking — when did the operator last replace the
// on-disk master source folder (walok/src or walok/server) by uploading a
// new .zip via /api/admin/update-source. Independent from baseline_*_*
// (which belonged to the now-removed Build From Uploaded Source flow);
// this one is the canonical "did we rebuild from current code" indicator
// the admin UI shows on the Update Source Files panel.
function getSourceUpdatedAt(kind) {
  if (kind !== 'launcher' && kind !== 'server') return null
  const v = getMeta('source_' + kind + '_updated_at')
  if (!v) return null
  const n = parseInt(v, 10)
  return Number.isFinite(n) ? n : null
}
function setSourceUpdatedAt(kind, ts) {
  if (kind !== 'launcher' && kind !== 'server') return
  setMeta('source_' + kind + '_updated_at', String(ts || Date.now()))
}

// "Partial" flag — set when the overlay-fallback swap died midway and
// the live src/ or server/ tree on disk is in a mixed state (some new
// files, some old). The build endpoint refuses with 409 while either
// flag is set, so the operator must successfully re-upload that role's
// source (which clears the flag) before any further build can ship a
// half-applied tree to customers. Stored as a meta string (truthy =
// partial); cleared by writing empty string.
function getSourcePartial(kind) {
  if (kind !== 'launcher' && kind !== 'server') return false
  const v = getMeta('source_' + kind + '_partial')
  return !!(v && v !== '')
}
function setSourcePartial(kind, isPartial) {
  if (kind !== 'launcher' && kind !== 'server') return
  setMeta('source_' + kind + '_partial', isPartial ? String(Date.now()) : '')
}

// One-time migration: pull every customers/*.json into the DB if the DB has no
// rows yet. Idempotent — re-running after the migration is a no-op.
//
// After a successful import the original JSON file is MOVED to
// customers/_migrated_backup/<channel>.json so the operator has an offline
// snapshot of what the DB started with, and so the live customers/*.json
// files going forward are unambiguously DB-derived (rewritten by the mirror
// system on every change). The backup directory is git-ignored.
function migrateFromJson(customersDir) {
  if (!customersDir || !fs.existsSync(customersDir)) return { migrated: 0, skipped: 0 }
  if (getMeta('customers_migrated_v1') === '1') return { migrated: 0, skipped: 0, alreadyDone: true }
  const backupDir = path.join(customersDir, '_migrated_backup')
  const repoRoot = path.join(customersDir, '..')
  let migrated = 0, skipped = 0
  for (const f of fs.readdirSync(customersDir)) {
    if (!f.endsWith('.json')) continue
    const file = path.join(customersDir, f)
    try {
      const c = JSON.parse(fs.readFileSync(file, 'utf-8'))
      if (!c.channel || !c.brandName || !c.subtitle || !c.updateServer) { skipped++; continue }
      // Skip if already in DB (e.g. server was restarted mid-migration)
      if (stmts.get.get(c.channel)) { skipped++; continue }
      // Rewrite the legacy shared `branding/logo.<ext>` source path to a
      // per-channel filename, and physically copy the legacy file to the
      // per-channel destination at the same time. Any seed customer whose
      // JSON pointed at the shared logo file would otherwise reintroduce the
      // build-all logo-leakage bug the moment a second customer was added.
      //
      // CRITICAL: if the rewrite is needed AND a real file exists at the
      // legacy path AND the copy fails, we keep the LEGACY logo path on the
      // inserted row so backfillLogoPaths() will retry on the next startup.
      // If we rewrote unconditionally and the copy threw, the row would
      // permanently point at a missing file (backfill only matches legacy
      // shared paths) and every build would hard-fail with "logo not found".
      const candidateLogo = rewriteLegacyLogoPath(c.channel, c.logo)
      let logoToInsert = candidateLogo
      if (candidateLogo && candidateLogo !== c.logo) {
        const fromPath = path.isAbsolute(c.logo) ? c.logo : path.join(repoRoot, c.logo)
        const toPath = path.isAbsolute(candidateLogo) ? candidateLogo : path.join(repoRoot, candidateLogo)
        let fromStat = null
        try { fromStat = fs.statSync(fromPath) } catch (e) {}
        if (fromStat && fromStat.isFile()) {
          // Same isFile validation as backfillLogoPaths — never silently
          // succeed when the destination exists but is the wrong kind of
          // entry (directory, broken symlink). Defer the rewrite so the
          // next-startup backfill gets a clean chance to retry.
          let copyOk = false
          try {
            if (!fs.existsSync(toPath)) {
              fs.copyFileSync(fromPath, toPath)
              copyOk = true
            } else {
              let toStat = null
              try { toStat = fs.statSync(toPath) } catch (e) {}
              copyOk = !!(toStat && toStat.isFile())
              if (!copyOk) console.log('[db] migrate ' + c.channel + ': destination ' + candidateLogo + ' exists but is not a regular file — keeping legacy path for backfill retry')
            }
          } catch (e) {
            console.log('[db] migrate ' + c.channel + ': copy failed (' + e.message + ') — keeping legacy logo path for backfill retry')
          }
          if (!copyOk) logoToInsert = c.logo
        }
        // If fromPath didn't exist (or wasn't a regular file) we still
        // rewrite — there's nothing to copy, and the operator's next admin
        // upload will land at the per-channel destination automatically.
      }
      stmts.insert.run({
        channel: c.channel,
        brandName: c.brandName,
        subtitle: c.subtitle,
        updateServer: c.updateServer,
        logo: logoToInsert,
      })
      // Move the source file into the backup dir as proof-of-import.
      try {
        if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true })
        fs.renameSync(file, path.join(backupDir, f))
      } catch (e) { /* best-effort */ }
      migrated++
    } catch (e) {
      skipped++
    }
  }
  setMeta('customers_migrated_v1', '1')
  return { migrated, skipped }
}

// Mirror the DB row out to customers/<channel>.json. The DB is the source of
// truth; this mirror exists ONLY because the legacy build scripts
// (scripts/build-customer.js + scripts/build-all.js) still read those JSON
// files at build time. Going forward they are regenerated by this function
// on every upsert/delete and once at startup. Operators must NOT hand-edit
// customers/*.json — the next CRUD will overwrite them.
function syncJsonMirror(customersDir, channel) {
  if (!customersDir) return
  if (!fs.existsSync(customersDir)) fs.mkdirSync(customersDir, { recursive: true })
  if (channel) {
    const c = getCustomer(channel)
    const file = path.join(customersDir, channel + '.json')
    if (!c) {
      try { if (fs.existsSync(file)) fs.unlinkSync(file) } catch (e) {}
      return
    }
    const out = { channel: c.channel, brandName: c.brandName, subtitle: c.subtitle, updateServer: c.updateServer }
    if (c.logo) out.logo = c.logo
    fs.writeFileSync(file, JSON.stringify(out, null, 2))
    return
  }
  const dbChannels = new Set(listCustomers().map(c => c.channel))
  for (const f of fs.readdirSync(customersDir)) {
    if (!f.endsWith('.json')) continue
    if (f === 'README.md') continue
    const ch = f.replace(/\.json$/, '')
    if (!dbChannels.has(ch) && ch !== 'README') {
      try { fs.unlinkSync(path.join(customersDir, f)) } catch (e) {}
    }
  }
  for (const c of listCustomers()) syncJsonMirror(customersDir, c.channel)
}

module.exports = {
  db,
  listCustomers,
  getCustomer,
  upsertCustomer,
  deleteCustomer,
  getMeta,
  setMeta,
  migrateFromJson,
  backfillLogoPaths,
  rewriteLegacyLogoPath,
  syncJsonMirror,
  recordLauncherPublished,
  recordServerPublished,
  recordBuild,
  setUpdatesEnabled,
  getBaselineRefreshedAt,
  setBaselineRefreshedAt,
  getSourceUpdatedAt,
  setSourceUpdatedAt,
  getSourcePartial,
  setSourcePartial,
}
