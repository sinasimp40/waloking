// Pure-JS regression test for Task #15 (build-all logo isolation).
//
// What broke before: scripts/build-customer.js syncLogo() walked branding/
// and unlinked every image except the file it was about to write. In a
// build-all run that meant customer A's syncLogo deleted customer B's
// per-channel source (branding/B-logo.png), so B's syncLogo then hit the
// "logo not found" branch and (silently, with a WARN) inherited whatever
// branding/logo.<ext> still contained — i.e. customer A's bytes. Every
// downstream customer in the same build batch shipped customer A's logo.
//
// What this test asserts:
//   1. syncLogo is a NO-OP on sibling per-channel sources (it only removes
//      stale `branding/logo.<otherExt>` destination files).
//   2. After running syncLogo for customer A, customer B's per-channel
//      source still exists with its ORIGINAL bytes (the bug).
//   3. After running A then B back-to-back, branding/logo.<ext> contains
//      B's bytes (not A's), proving the destination is per-customer.
//   4. Missing-source is now a HARD ERROR (was: silent WARN that caused the
//      cross-customer bleed in the first place).
//   5. Unsupported extension is a HARD ERROR.
//   6. resolveBrandingIcoSource() prefers branding/logo.<ext> over an
//      unrelated readdir entry, so the rebrand step picks the file the
//      build pipeline just wrote (deterministic).
//   7. db.rewriteLegacyLogoPath rewrites the shared path to per-channel.
//   8. db.rewriteLegacyLogoPath leaves a non-shared path untouched.
//   9. db.backfillLogoPaths is idempotent (second call returns alreadyDone).

const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')

let pass = 0, fail = 0
function ok(msg) { pass++; console.log('  PASS  ' + msg) }
function bad(msg) { fail++; console.log('  FAIL  ' + msg) }
function assert(cond, msg) { cond ? ok(msg) : bad(msg) }
function assertEq(a, b, msg) { assert(a === b, msg + ' (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')') }
function sha(buf) { return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16) }

// Build a fake repo root with a branding/ dir we can scribble in. We point
// the build-customer module at it via process.chdir + ROOT trick: the module
// resolves ROOT as path.join(__dirname, '..'), so we need the real source.
// Instead of cloning the file, we let the module compute its real ROOT and
// just SWAP branding/ contents around it. That means tests share branding/
// with anyone else — but that's fine because we restore it in finally{}.

const REPO_ROOT = path.join(__dirname, '..')
const BRANDING_DIR = path.join(REPO_ROOT, 'branding')

function snapshotBranding() {
  const out = {}
  for (const f of fs.readdirSync(BRANDING_DIR)) {
    out[f] = fs.readFileSync(path.join(BRANDING_DIR, f))
  }
  return out
}
function restoreBranding(snap) {
  for (const f of fs.readdirSync(BRANDING_DIR)) {
    if (!Object.prototype.hasOwnProperty.call(snap, f)) {
      try { fs.unlinkSync(path.join(BRANDING_DIR, f)) } catch (e) {}
    }
  }
  for (const [name, bytes] of Object.entries(snap)) {
    fs.writeFileSync(path.join(BRANDING_DIR, name), bytes)
  }
}

// Generate distinct PNG payloads. We use the smallest-valid-PNG byte sequence
// then pad with a per-customer marker so each blob has a unique sha256.
const PNG_MIN = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63000100000005000100' +
  '0d0a2db40000000049454e44ae426082',
  'hex'
)
function fakePng(marker) { return Buffer.concat([PNG_MIN, Buffer.from('\n' + marker + '\n')]) }

console.log('=== Task #15: build-all logo isolation ===\n')

// Snapshot real branding/ so we can put it back after the test.
const snap = snapshotBranding()

try {
  // -------- Setup: two customers with distinct per-channel logo sources --------
  const aBytes = fakePng('CUSTOMER-A-MARKER')
  const bBytes = fakePng('CUSTOMER-B-MARKER')
  const aSha = sha(aBytes), bSha = sha(bBytes)
  assert(aSha !== bSha, 'fixtures: customer A and B logos hash differently')

  // Wipe branding/ down to just the per-channel sources we control.
  for (const f of fs.readdirSync(BRANDING_DIR)) {
    try { fs.unlinkSync(path.join(BRANDING_DIR, f)) } catch (e) {}
  }
  fs.writeFileSync(path.join(BRANDING_DIR, 'cust-a-logo.png'), aBytes)
  fs.writeFileSync(path.join(BRANDING_DIR, 'cust-b-logo.png'), bBytes)

  const { syncLogo } = require('../scripts/build-customer.js')

  // -------- A1: build customer A first --------
  const a = syncLogo({ channel: 'cust-a', logo: 'branding/cust-a-logo.png' })
  assert(a && a.sha, 'syncLogo(A) returned a result with sha')
  // Check customer B's per-channel source still exists with ORIGINAL bytes.
  const bAfterA = fs.readFileSync(path.join(BRANDING_DIR, 'cust-b-logo.png'))
  assert(bAfterA.equals(bBytes), 'after syncLogo(A): customer B per-channel source survives untouched (was the build-all leakage bug)')
  // Check branding/logo.png contains A's bytes.
  const destAfterA = fs.readFileSync(path.join(BRANDING_DIR, 'logo.png'))
  assert(destAfterA.equals(aBytes), 'after syncLogo(A): branding/logo.png == customer A bytes')

  // -------- A2: now build customer B (the smoking gun) --------
  const b = syncLogo({ channel: 'cust-b', logo: 'branding/cust-b-logo.png' })
  assert(b && b.sha, 'syncLogo(B) returned a result with sha')
  const aAfterB = fs.readFileSync(path.join(BRANDING_DIR, 'cust-a-logo.png'))
  assert(aAfterB.equals(aBytes), 'after syncLogo(B): customer A per-channel source still survives')
  const destAfterB = fs.readFileSync(path.join(BRANDING_DIR, 'logo.png'))
  assert(destAfterB.equals(bBytes), 'after syncLogo(B): branding/logo.png == customer B bytes (NOT customer A)')
  assert(!destAfterB.equals(aBytes), 'regression: B did not inherit A\'s bytes')

  // -------- A3: missing source is HARD ERROR --------
  let threwMissing = false
  try {
    syncLogo({ channel: 'cust-c', logo: 'branding/does-not-exist.png' })
  } catch (e) {
    threwMissing = /not found/i.test(e.message) && /cust-c/.test(e.message)
  }
  assert(threwMissing, 'missing source throws a clear "not found" error mentioning the channel')

  // -------- A4: unsupported extension is HARD ERROR --------
  fs.writeFileSync(path.join(BRANDING_DIR, 'cust-d-logo.gif'), Buffer.from('GIF89a'))
  let threwExt = false
  try {
    syncLogo({ channel: 'cust-d', logo: 'branding/cust-d-logo.gif' })
  } catch (e) {
    threwExt = /unsupported extension/i.test(e.message) && /\.gif/.test(e.message)
  }
  assert(threwExt, 'unsupported .gif extension throws')

  // -------- A5: extension change wipes the stale destination --------
  // Force a JPEG source for customer E, then assert branding/logo.png is gone.
  fs.writeFileSync(path.join(BRANDING_DIR, 'cust-e-logo.jpg'), Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from('CUSTOMER-E')]))
  syncLogo({ channel: 'cust-e', logo: 'branding/cust-e-logo.jpg' })
  assert(!fs.existsSync(path.join(BRANDING_DIR, 'logo.png')), 'switching from .png to .jpg removes stale branding/logo.png')
  assert(fs.existsSync(path.join(BRANDING_DIR, 'logo.jpg')), 'switching to .jpg writes branding/logo.jpg')
  assert(fs.existsSync(path.join(BRANDING_DIR, 'cust-a-logo.png')), 'extension switch did not wipe sibling sources')
  assert(fs.existsSync(path.join(BRANDING_DIR, 'cust-b-logo.png')), 'extension switch did not wipe sibling sources (B)')

  // -------- A6: rebrand picks branding/logo.<ext> deterministically --------
  // Reset to a clean branding/ with logo.png + an unrelated other.png that
  // would otherwise sort first under an alphabetical readdir.
  for (const f of fs.readdirSync(BRANDING_DIR)) {
    try { fs.unlinkSync(path.join(BRANDING_DIR, f)) } catch (e) {}
  }
  fs.writeFileSync(path.join(BRANDING_DIR, 'aaa-other-customer.png'), fakePng('SHOULD-NOT-WIN'))
  fs.writeFileSync(path.join(BRANDING_DIR, 'logo.png'), fakePng('THE-PIPELINE-WRITE'))
  const { resolveBrandingIcoSource } = require('../scripts/rebrand.js')
  const resolved = resolveBrandingIcoSource(BRANDING_DIR)
  assert(resolved && resolved.name === 'logo.png', 'rebrand picks branding/logo.png even when other images sort first')
  assertEq(resolved.strategy, 'preferred-logo.png', 'resolution strategy is preferred-logo.png')

  // Strategy: when only an "other" image exists, falls back to readdir.
  fs.unlinkSync(path.join(BRANDING_DIR, 'logo.png'))
  const fb = resolveBrandingIcoSource(BRANDING_DIR)
  assert(fb && fb.strategy === 'fallback-readdir', 'rebrand falls back to readdir when no logo.<ext> exists')

  // -------- A7: db rewrite helper --------
  const { rewriteLegacyLogoPath } = require('../update-server/db.js')
  assertEq(rewriteLegacyLogoPath('cafe-a', 'branding/logo.png'),
    'branding/cafe-a-logo.png', 'rewriteLegacyLogoPath rewrites shared logo.png to per-channel')
  assertEq(rewriteLegacyLogoPath('cafe-b', 'branding/logo.JPG'),
    'branding/cafe-b-logo.jpg', 'rewriteLegacyLogoPath normalises uppercase extensions')
  assertEq(rewriteLegacyLogoPath('cafe-c', 'branding/cafe-c-logo.png'),
    'branding/cafe-c-logo.png', 'rewriteLegacyLogoPath leaves per-channel paths untouched')
  assertEq(rewriteLegacyLogoPath('cafe-d', null), null, 'rewriteLegacyLogoPath tolerates null')
  assertEq(rewriteLegacyLogoPath('cafe-e', 'branding/sublogo.png'),
    'branding/sublogo.png', 'rewriteLegacyLogoPath does not match nested-name false-positives')

  // -------- A8: backfillLogoPaths fully isolated end-to-end test --------
  // Build an ENTIRELY isolated db.js + filesystem fixture so we don't poison
  // the real launcher.db (which already has logo_paths_backfilled_v1 set
  // from server.js startup).
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task15-backfill-'))
  const tmpDbDir = path.join(tmpDir, 'data')
  const tmpBranding = path.join(tmpDir, 'branding')
  fs.mkdirSync(tmpDbDir, { recursive: true })
  fs.mkdirSync(tmpBranding, { recursive: true })

  // We need an isolated copy of the db module pointed at a fresh DB. Easiest:
  // require it through a child Node process that overrides __dirname semantics.
  // Simpler still: load it via require, but FIRST point the module's expected
  // data dir into our temp dir. The module computes DATA_DIR relative to
  // __dirname, so we instead spawn a child to run the assertions.
  const child = require('child_process')
  const helperPath = path.join(tmpDir, 'helper.js')
  // Build a tiny driver script that copies db.js into tmpDir alongside its
  // own /data dir, requires it, exercises backfillLogoPaths, then prints JSON.
  fs.copyFileSync(path.join(__dirname, '..', 'update-server', 'db.js'), path.join(tmpDir, 'db.js'))
  // Also need better-sqlite3 — symlink the project's node_modules so require resolves.
  try { fs.symlinkSync(path.join(__dirname, '..', 'update-server', 'node_modules'), path.join(tmpDir, 'node_modules')) }
  catch (e) { /* may already exist or not allowed; child process will surface */ }

  const driver = `
    const fs = require('fs')
    const path = require('path')
    const dbApi = require('./db.js')
    const brandingDir = ${JSON.stringify(tmpBranding)}
    // Seed two customers, both pointing at the legacy shared logo.png.
    dbApi.upsertCustomer({ channel: 'alpha', brandName: 'A', subtitle: 's', updateServer: 'http://x', logo: 'branding/logo.png' })
    dbApi.upsertCustomer({ channel: 'beta',  brandName: 'B', subtitle: 's', updateServer: 'http://x', logo: 'branding/logo.png' })
    // Put a shared logo file on disk.
    fs.writeFileSync(path.join(brandingDir, 'logo.png'), Buffer.from('SHARED-LOGO-BYTES'))
    // First call: should rewrite both rows + copy file twice + delete shared.
    const r1 = dbApi.backfillLogoPaths(brandingDir)
    // Second call: should be a no-op via meta flag.
    const r2 = dbApi.backfillLogoPaths(brandingDir)
    const after = dbApi.listCustomers()
    console.log(JSON.stringify({
      r1, r2, after,
      alphaFile: fs.existsSync(path.join(brandingDir, 'alpha-logo.png')),
      betaFile:  fs.existsSync(path.join(brandingDir, 'beta-logo.png')),
      sharedGone: !fs.existsSync(path.join(brandingDir, 'logo.png')),
      alphaBytes: fs.existsSync(path.join(brandingDir, 'alpha-logo.png')) && fs.readFileSync(path.join(brandingDir, 'alpha-logo.png')).toString(),
    }))
  `
  fs.writeFileSync(helperPath, driver)
  let driverResult
  try {
    const out = child.execSync('node ' + JSON.stringify(helperPath), { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'inherit'] })
    driverResult = JSON.parse(out.trim().split(/\r?\n/).pop())
  } catch (e) {
    bad('backfill driver failed to spawn: ' + e.message)
    driverResult = null
  }
  if (driverResult) {
    assertEq(driverResult.r1.rewritten, 2, 'backfill rewrites both legacy customer rows')
    assert(driverResult.r2.alreadyDone === true, 'backfill is idempotent on second call')
    assert(driverResult.alphaFile, 'backfill physically copied to alpha-logo.png')
    assert(driverResult.betaFile, 'backfill physically copied to beta-logo.png')
    assert(driverResult.sharedGone, 'backfill deleted the shared branding/logo.png')
    assertEq(driverResult.alphaBytes, 'SHARED-LOGO-BYTES', 'alpha received the original shared bytes')
    const alphaRow = driverResult.after.find(c => c.channel === 'alpha')
    const betaRow  = driverResult.after.find(c => c.channel === 'beta')
    assertEq(alphaRow && alphaRow.logo, 'branding/alpha-logo.png', 'alpha DB row was rewritten to per-channel path')
    assertEq(betaRow && betaRow.logo, 'branding/beta-logo.png', 'beta DB row was rewritten to per-channel path')
  }
  // Cleanup tmp dir.
  try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch (e) {}

  // -------- A9: backfill copy failure aborts WITHOUT setting meta flag --------
  // Architect-flagged: a partial copy failure must leave the system in a
  // retry-on-next-start state, never silently mark itself "done" with broken
  // rows in the DB.
  const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'task15-failure-'))
  fs.mkdirSync(path.join(tmpDir2, 'branding'), { recursive: true })
  fs.copyFileSync(path.join(__dirname, '..', 'update-server', 'db.js'), path.join(tmpDir2, 'db.js'))
  try { fs.symlinkSync(path.join(__dirname, '..', 'update-server', 'node_modules'), path.join(tmpDir2, 'node_modules')) } catch (e) {}
  const failureDriver = `
    const fs = require('fs')
    const path = require('path')
    const dbApi = require('./db.js')
    const brandingDir = ${JSON.stringify(path.join(tmpDir2, 'branding'))}
    dbApi.upsertCustomer({ channel: 'gamma', brandName: 'G', subtitle: 's', updateServer: 'http://x', logo: 'branding/logo.png' })
    fs.writeFileSync(path.join(brandingDir, 'logo.png'), Buffer.from('SOURCE'))
    // Sabotage the destination: pre-create gamma-logo.png as a DIRECTORY so
    // the new isFile() validation flags it as "exists but not a regular file"
    // and records a failure (instead of the OLD code path which silently
    // skipped the copy because existsSync returned true). Backfill must
    // abort and leave the meta flag UNSET so the next call retries.
    fs.mkdirSync(path.join(brandingDir, 'gamma-logo.png'))
    const r1 = dbApi.backfillLogoPaths(brandingDir)
    // Heal the sabotage and call again — should now succeed.
    fs.rmdirSync(path.join(brandingDir, 'gamma-logo.png'))
    const r2 = dbApi.backfillLogoPaths(brandingDir)
    const after = dbApi.listCustomers()
    console.log(JSON.stringify({ r1, r2, after }))
  `
  fs.writeFileSync(path.join(tmpDir2, 'helper.js'), failureDriver)
  let failureResult
  try {
    const out2 = require('child_process').execSync('node ' + JSON.stringify(path.join(tmpDir2, 'helper.js')), { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'inherit'] })
    failureResult = JSON.parse(out2.trim().split(/\r?\n/).pop())
  } catch (e) {
    bad('failure-path driver crashed: ' + e.message)
  }
  if (failureResult) {
    assert(failureResult.r1.failures && failureResult.r1.failures.length > 0, 'first backfill records the copy failure')
    assert(failureResult.r1.retrying === true, 'first backfill marks itself as retrying (no meta flag set)')
    assertEq(failureResult.r1.rewritten, 0, 'first backfill did NOT rewrite any DB rows on copy failure')
    assertEq(failureResult.r2.rewritten, 1, 'second backfill (after sabotage healed) succeeds and rewrites the row')
    const gamma = failureResult.after.find(c => c.channel === 'gamma')
    assertEq(gamma && gamma.logo, 'branding/gamma-logo.png', 'gamma DB row was rewritten only after the copy succeeded')
  }
  try { fs.rmSync(tmpDir2, { recursive: true, force: true }) } catch (e) {}

  // -------- A10: migrateFromJson copy failure keeps legacy path so backfill retries --------
  const tmpDir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'task15-migrate-fail-'))
  fs.mkdirSync(path.join(tmpDir3, 'branding'), { recursive: true })
  fs.mkdirSync(path.join(tmpDir3, 'customers'), { recursive: true })
  fs.copyFileSync(path.join(__dirname, '..', 'update-server', 'db.js'), path.join(tmpDir3, 'db.js'))
  try { fs.symlinkSync(path.join(__dirname, '..', 'update-server', 'node_modules'), path.join(tmpDir3, 'node_modules')) } catch (e) {}
  fs.writeFileSync(path.join(tmpDir3, 'customers', 'delta.json'), JSON.stringify({
    channel: 'delta', brandName: 'D', subtitle: 's', updateServer: 'http://x', logo: 'branding/logo.png',
  }))
  fs.writeFileSync(path.join(tmpDir3, 'branding', 'logo.png'), Buffer.from('LEGACY'))
  // Sabotage: pre-create destination as directory so copy throws.
  fs.mkdirSync(path.join(tmpDir3, 'branding', 'delta-logo.png'))
  const migrateDriver = `
    const fs = require('fs')
    const path = require('path')
    const dbApi = require('./db.js')
    const customersDir = ${JSON.stringify(path.join(tmpDir3, 'customers'))}
    const brandingDir = ${JSON.stringify(path.join(tmpDir3, 'branding'))}
    const m = dbApi.migrateFromJson(customersDir)
    const after = dbApi.listCustomers()
    // Heal sabotage. Backfill must now repair the row.
    fs.rmdirSync(path.join(brandingDir, 'delta-logo.png'))
    const b = dbApi.backfillLogoPaths(brandingDir)
    const final = dbApi.listCustomers()
    console.log(JSON.stringify({ m, after, b, final }))
  `
  fs.writeFileSync(path.join(tmpDir3, 'helper.js'), migrateDriver)
  let migrateResult
  try {
    const out3 = require('child_process').execSync('node ' + JSON.stringify(path.join(tmpDir3, 'helper.js')), { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'inherit'] })
    migrateResult = JSON.parse(out3.trim().split(/\r?\n/).pop())
  } catch (e) {
    bad('migrate-failure driver crashed: ' + e.message)
  }
  if (migrateResult) {
    assertEq(migrateResult.m.migrated, 1, 'migrateFromJson migrated the legacy customer')
    const deltaAfterMigrate = migrateResult.after.find(c => c.channel === 'delta')
    assertEq(deltaAfterMigrate && deltaAfterMigrate.logo, 'branding/logo.png',
      'migrate copy failure kept LEGACY path on the row (so backfill can retry — was previously a permanent broken state)')
    assertEq(migrateResult.b.rewritten, 1, 'next-startup backfill repaired the row')
    const deltaFinal = migrateResult.final.find(c => c.channel === 'delta')
    assertEq(deltaFinal && deltaFinal.logo, 'branding/delta-logo.png',
      'after backfill retry, row points at per-channel path')
  }
  try { fs.rmSync(tmpDir3, { recursive: true, force: true }) } catch (e) {}
} finally {
  // Always restore branding/ to its on-disk state regardless of pass/fail.
  // This keeps repeated test runs deterministic and avoids polluting commits.
  try {
    for (const f of fs.readdirSync(BRANDING_DIR)) {
      try { fs.unlinkSync(path.join(BRANDING_DIR, f)) } catch (e) {}
    }
    restoreBranding(snap)
  } catch (e) {
    console.log('  WARN: branding/ restore failed: ' + e.message)
  }
}

console.log('\n=== ' + pass + ' pass, ' + fail + ' fail ===')
process.exit(fail === 0 ? 0 : 1)
