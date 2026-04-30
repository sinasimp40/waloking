const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')
const { cleanupAfterBuild } = require('../update-server/cleanup')

const ROOT = path.join(__dirname, '..')
const CUSTOMERS_DIR = path.join(ROOT, 'customers')
const UPDATES_PUBLIC_DIR = path.join(ROOT, 'update-server', 'public', 'updates')

function log(msg) { console.log('[build-all] ' + msg) }

function listCustomers() {
  if (!fs.existsSync(CUSTOMERS_DIR)) return []
  return fs.readdirSync(CUSTOMERS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => path.join(CUSTOMERS_DIR, f))
}

function main() {
  const customers = listCustomers()
  if (customers.length === 0) {
    console.error('[build-all] No customer configs found in customers/')
    console.error('[build-all] Add at least one .json file in customers/ then re-run.')
    process.exit(1)
  }

  log('Found ' + customers.length + ' customer(s):')
  customers.forEach(c => log('  - ' + path.basename(c, '.json')))
  log('')

  // Per-channel pre-iteration cleanup so disks don't grow unbounded across
  // repeated batch runs. build-customer.js also runs its own cleanup, but we
  // do an explicit pass here so a failure inside one customer build still
  // leaves the OTHER customers' folders pruned.
  const channels = customers.map(f => path.basename(f, '.json'))
  try {
    const summary = cleanupAfterBuild({
      projectRoot: ROOT,
      updatesPublicDir: UPDATES_PUBLIC_DIR,
      channels,
      version: null,
      keepNewest: false,
    })
    for (const s of summary) {
      const removed = [
        ...(s.releases.removed || []).map(v => 'releases/' + v),
        ...(s.published.removed || []).map(v => 'updates/' + v),
        ...(s.publishedServer.removed || []).map(v => 'updates-server/' + v),
      ]
      if (removed.length > 0) log('[cleanup] ' + s.channel + ' — removed: ' + removed.join(', '))
    }
  } catch (e) {
    log('[cleanup] WARN: pre-iteration cleanup failed: ' + e.message)
  }

  const results = []
  for (const file of customers) {
    const id = path.basename(file, '.json')
    log('========================================')
    log('Building: ' + id)
    log('========================================')
    try {
      execSync('node scripts/build-customer.js "' + id + '"', {
        cwd: ROOT,
        stdio: 'inherit'
      })
      results.push({ id, status: 'OK' })
    } catch (e) {
      results.push({ id, status: 'FAILED', error: e.message })
      log('FAILED: ' + id)
    }
  }

  log('')
  log('========================================')
  log('BUILD-ALL SUMMARY')
  log('========================================')
  results.forEach(r => log('  ' + (r.status === 'OK' ? '[OK] ' : '[FAIL]') + ' ' + r.id))
  const failed = results.filter(r => r.status !== 'OK').length
  if (failed > 0) {
    log(failed + ' build(s) failed')
    process.exit(1)
  }
  log('All builds successful!')
}

main()
