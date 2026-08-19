// Unit tests for the rebump tracking logic added to db.js
// (recordLauncherPublished / recordServerPublished increment a per-version
// counter when the SAME version is republished, and reset to 0 the moment
// the version actually changes).
//
// Uses a temp PROJECT_ROOT so it does not touch the real OTA database.

const fs = require('fs')
const os = require('os')
const path = require('path')

// db.js resolves its sqlite file as `${OTA_DATA_DIR}/launcher.db` (falling
// back to `<repo>/data` when unset). MUST set OTA_DATA_DIR to a fresh temp
// dir BEFORE the require — otherwise the test scribbles into the real
// production DB and inherits whatever rebump counters were left there from
// previous runs (architect-flagged: nondeterministic 5/7 vs 7/7).
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'walok-rebump-test-'))
process.env.OTA_DATA_DIR = tmpRoot
const dbApi = require('./db')

let pass = 0, fail = 0
function ok(name) { pass++; console.log('  ok  ' + name) }
function bad(name, e) { fail++; console.log('  FAIL ' + name + ' — ' + (e?.message || e)) }
function test(name, fn) { try { fn(); ok(name) } catch (e) { bad(name, e) } }
function eq(a, b, msg) { if (a !== b) throw new Error((msg || 'eq') + ': expected ' + JSON.stringify(b) + ' got ' + JSON.stringify(a)) }

// Seed a customer row.
dbApi.upsertCustomer({
  channel: 'rebump-test',
  brandName: 'Rebump Test',
  subtitle: 'X',
  updateServer: 'http://localhost:1',
})

test('initial state: no rebump count', () => {
  const c = dbApi.getCustomer('rebump-test')
  eq(c.launcherRebuildCount, 0, 'launcher count')
  eq(c.serverRebuildCount, 0, 'server count')
  eq(c.launcherRebuiltAt, null, 'launcher ts')
  eq(c.serverRebuiltAt, null, 'server ts')
})

test('first launcher publish does NOT count as rebump', () => {
  dbApi.recordLauncherPublished('rebump-test', '1.0.0', 1000)
  const c = dbApi.getCustomer('rebump-test')
  eq(c.launcherVersion, '1.0.0')
  eq(c.launcherRebuildCount, 0, 'count stays 0 on first publish')
  eq(c.launcherRebuiltAt, null, 'ts stays null on first publish')
})

test('republishing SAME launcher version increments rebump count', () => {
  dbApi.recordLauncherPublished('rebump-test', '1.0.0', 2000)
  let c = dbApi.getCustomer('rebump-test')
  eq(c.launcherRebuildCount, 1, 'count=1 after 1st rebump')
  eq(c.launcherRebuiltAt, 2000, 'ts captured')

  dbApi.recordLauncherPublished('rebump-test', '1.0.0', 3000)
  c = dbApi.getCustomer('rebump-test')
  eq(c.launcherRebuildCount, 2, 'count=2 after 2nd rebump')
  eq(c.launcherRebuiltAt, 3000, 'ts updated')
})

test('publishing a NEW launcher version resets rebump count', () => {
  dbApi.recordLauncherPublished('rebump-test', '1.0.1', 4000)
  const c = dbApi.getCustomer('rebump-test')
  eq(c.launcherVersion, '1.0.1')
  eq(c.launcherRebuildCount, 0, 'count reset')
  eq(c.launcherRebuiltAt, null, 'ts cleared')
})

test('rebump again after version change works independently', () => {
  dbApi.recordLauncherPublished('rebump-test', '1.0.1', 5000)
  const c = dbApi.getCustomer('rebump-test')
  eq(c.launcherRebuildCount, 1, 'count=1 against new version')
  eq(c.launcherRebuiltAt, 5000)
})

test('server-role rebump is independent of launcher', () => {
  dbApi.recordServerPublished('rebump-test', '2.0.0', 6000)
  let c = dbApi.getCustomer('rebump-test')
  eq(c.serverVersion, '2.0.0')
  eq(c.serverRebuildCount, 0, 'first server publish: no rebump')
  // launcher counters untouched
  eq(c.launcherRebuildCount, 1, 'launcher count preserved')

  dbApi.recordServerPublished('rebump-test', '2.0.0', 7000)
  c = dbApi.getCustomer('rebump-test')
  eq(c.serverRebuildCount, 1, 'server count=1')
  eq(c.serverRebuiltAt, 7000)
  eq(c.launcherRebuildCount, 1, 'launcher count still preserved')
})

test('downgrade-style version change still resets the counter', () => {
  // The endpoint blocks strict downgrades, but db.js itself trusts the
  // caller. Verify the reset path triggers on ANY version change, not just
  // forward bumps — otherwise a future code path that legitimately rolls
  // back (e.g. revert-to-previous) would carry stale rebump counters.
  dbApi.recordLauncherPublished('rebump-test', '0.9.0', 8000)
  const c = dbApi.getCustomer('rebump-test')
  eq(c.launcherVersion, '0.9.0')
  eq(c.launcherRebuildCount, 0, 'count reset on backward change too')
  eq(c.launcherRebuiltAt, null)
})

console.log('== ' + pass + ' passed, ' + fail + ' failed ==')

// Cleanup
try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch (_) {}

process.exit(fail === 0 ? 0 : 1)
