const $ = (sel) => document.querySelector(sel)
const $$ = (sel) => Array.from(document.querySelectorAll(sel))

const state = {
  customers: [],
  version: null,
  serverVersion: null,
  projectRoot: null,
  buildsAvailable: false,
  online: {},
  onlineEvtSrc: null,
  // Last fanned-out job id streamed — kept for legacy keyboard shortcuts /
  // future UX, but the per-card CANCEL buttons in the consoles area are the
  // primary cancel surface in the multi-console UI.
  currentJobId: null,
  // EventSource for /api/admin/jobs/stream — pushes queue+slots snapshots so
  // the BUILD QUEUE panel updates without polling.
  queueEvtSrc: null,
  // Last queue snapshot, used by the cancel-button click handler to avoid an
  // extra round-trip when the operator cancels a queued (not-yet-running) job.
  lastQueueSnapshot: { queue: { active: [], queued: [], maxConcurrent: 2 }, jobs: [] },
}

async function api(method, path, body, isForm) {
  const opts = { method, credentials: 'include', headers: {} }
  if (body && !isForm) {
    opts.headers['Content-Type'] = 'application/json'
    opts.body = JSON.stringify(body)
  } else if (body && isForm) {
    opts.body = body
  }
  const res = await fetch(path, opts)
  let data = null
  try { data = await res.json() } catch (e) {}
  if (!res.ok) throw new Error(data?.error || ('HTTP ' + res.status))
  return data
}

async function init() {
  try {
    const status = await api('GET', '/api/admin/status')
    state.version = status.version
    state.serverVersion = status.serverVersion || null
    state.projectRoot = status.projectRoot
    state.buildsAvailable = status.buildsAvailable
    state.deps = status.deps || null
    state.buildStamp = status.buildStamp || null
    if (status.authenticated) showApp()
    else showLogin()
  } catch (e) {
    showLogin()
  }
}

// Format the update-server build stamp as a compact one-liner the operator
// can read at a glance: "7ca8680 · 2026-04-30 14:02 · node v24.10.0".
// Click-to-copy puts the full JSON on the clipboard for support questions.
function renderBuildStamp(stamp) {
  const el = $('#build-stamp')
  if (!el) return
  if (!stamp) { el.textContent = '?'; return }
  const builtAt = stamp.builtAt
    ? new Date(stamp.builtAt).toISOString().slice(0, 16).replace('T', ' ')
    : '—'
  const hash = stamp.contentHash || '?'
  const node = stamp.node || ''
  el.textContent = hash + ' · ' + builtAt + (node ? ' · node ' + node : '')
  el.title = JSON.stringify(stamp, null, 2) +
    '\n\nClick to copy this build stamp to the clipboard.'
  el.onclick = async () => {
    const prev = el.textContent
    try {
      await navigator.clipboard.writeText(JSON.stringify(stamp))
      el.textContent = 'copied'
    } catch (_) {
      el.textContent = 'copy failed'
    }
    setTimeout(() => { el.textContent = prev }, 900)
  }
}

function renderDepsStatus(deps) {
  const pill = $('#deps-status')
  const banner = $('#deps-banner')
  if (!pill || !banner) return
  if (!deps) {
    pill.textContent = '?'
    pill.className = 'deps-pill'
    banner.classList.add('hidden')
    return
  }
  const root = !!deps.root
  const server = deps.serverDirExists ? !!deps.server : true
  let label, cls, msg = ''
  if (root && server) {
    label = 'OK'; cls = 'ok'
  } else if (!root && !server) {
    label = 'Missing'; cls = 'missing'
    msg = 'Project dependencies are not installed (root + server). The next BUILD will run "npm install" automatically before building — first build may take 1–3 minutes.'
  } else {
    label = 'Partial'; cls = 'partial'
    msg = 'Some dependencies are missing (' + (!root ? 'root ' : '') + (!server && deps.serverDirExists ? 'server ' : '') + 'node_modules). The next BUILD will install them automatically.'
  }
  pill.textContent = label
  pill.className = 'deps-pill ' + cls
  if (msg) {
    banner.textContent = '⚠ ' + msg
    banner.classList.remove('hidden')
  } else {
    banner.classList.add('hidden')
  }
}

function showLogin() {
  $('#login-screen').classList.remove('hidden')
  $('#app-screen').classList.add('hidden')
  closeOnlineStream()
}

async function showApp() {
  $('#login-screen').classList.add('hidden')
  $('#app-screen').classList.remove('hidden')
  $('#current-version').textContent = state.version || '?'
  $('#server-version').textContent = state.serverVersion ? ('v' + state.serverVersion) : '?'
  const pathEl = $('#project-root')
  pathEl.textContent = state.projectRoot || '(not detected)'
  // Full path shown as a tooltip for cases where the topbar narrows and
  // the visible text gets ellipsis-truncated.
  pathEl.title = state.projectRoot || ''
  $('#version-input').value = ''
  $('#version-input').placeholder = state.version ? bumpPatch(state.version) : '1.0.1'
  renderDepsStatus(state.deps)
  renderBuildStamp(state.buildStamp)
  if (!state.buildsAvailable) {
    const banner = $('#warning-banner')
    banner.textContent = 'Project root not detected — admin can edit customer configs but CANNOT trigger builds. Set OTA_PROJECT_ROOT environment variable to the path of your launcher project, then restart this server.'
    banner.classList.remove('hidden')
    $('#build-all-btn').disabled = true
    $('#bump-version-btn').disabled = true
  }
  await loadCustomers()
  openOnlineStream()
  openQueueStream()
}

function bumpPatch(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v || '')
  if (!m) return '1.0.1'
  return m[1] + '.' + m[2] + '.' + (parseInt(m[3], 10) + 1)
}

async function loadCustomers() {
  const list = $('#customer-list')
  try {
    const data = await api('GET', '/api/admin/customers')
    state.customers = data.customers || []
    state.version = data.version
    if (data.serverVersion) {
      state.serverVersion = data.serverVersion
      $('#server-version').textContent = 'v' + data.serverVersion
    }
    if (data.deps) {
      state.deps = data.deps
      renderDepsStatus(state.deps)
    }
    $('#current-version').textContent = state.version || '?'
    $('#version-input').placeholder = state.version ? bumpPatch(state.version) : '1.0.1'
    refreshSourceStatus()
    if (state.customers.length === 0) {
      list.innerHTML = '<div class="muted">No customers yet. Click "+ Add Customer" to create the first one.</div>'
      return
    }
    renderCustomerList()
  } catch (e) {
    list.innerHTML = '<div class="error">Failed to load: ' + escapeHtml(e.message) + '</div>'
  }
}

// ---- Update Source Files panel ---------------------------------------
// Pulls /api/admin/source-status and re-paints the two source cards
// (launcher / server) with "present + last replaced N ago" or a
// "not yet uploaded" placeholder. Fired once on load and again after each
// successful source replace + after each successful build (so the operator
// always sees fresh "last replaced" timestamps).
function fmtAge(ms) {
  if (!ms) return ''
  const s = Math.floor((Date.now() - ms) / 1000)
  if (s < 60) return s + 's ago'
  const m = Math.floor(s / 60); if (m < 60) return m + 'm ago'
  const h = Math.floor(m / 60); if (h < 48) return h + 'h ago'
  const d = Math.floor(h / 24); return d + 'd ago'
}

async function refreshSourceStatus() {
  const lEl = $('#src-launcher-status')
  const sEl = $('#src-server-status')
  if (!lEl && !sEl) return
  let data
  try {
    data = await api('GET', '/api/admin/source-status')
  } catch (e) {
    if (lEl) lEl.innerHTML = '<span class="src-warn">Could not load: ' + escapeHtml(e.message) + '</span>'
    if (sEl) sEl.innerHTML = '<span class="src-warn">Could not load: ' + escapeHtml(e.message) + '</span>'
    return
  }
  const paint = (el, st) => {
    if (!el) return
    if (!st || !st.present) {
      el.innerHTML = '<span class="src-pill missing">not present on disk</span>'
      return
    }
    const age = st.updatedAt ? fmtAge(st.updatedAt) : 'unknown'
    const when = st.updatedAt ? new Date(st.updatedAt).toLocaleString() : '—'
    el.innerHTML = `<span class="src-pill ok" title="${escapeHtml(when)}">on disk · last replaced ${escapeHtml(age)}</span>`
  }
  paint(lEl, data.launcher)
  paint(sEl, data.server)
}

// Submits one source-card form. Disables the button, shows the busy line,
// then POSTs multipart to /api/admin/update-source. On success: clears the
// file input + repaints status. On 409 (build running) or 4xx: surfaces the
// server error in the card-local error slot.
async function submitUpdateSource(form) {
  const kind = form.dataset.sourceKind
  if (kind !== 'launcher' && kind !== 'server') return
  const fileInput = form.querySelector('input[type="file"]')
  const file = fileInput && fileInput.files[0]
  const errEl = $('#src-' + kind + '-error')
  const busyEl = $('#src-' + kind + '-busy')
  const submitBtn = form.querySelector('button[type="submit"]')
  const origLabel = submitBtn ? submitBtn.textContent : null
  if (errEl) errEl.textContent = ''
  if (!file) { if (errEl) errEl.textContent = 'pick a .zip first'; return }
  const fd = new FormData()
  fd.append('kind', kind)
  fd.append('file', file)
  if (busyEl) busyEl.classList.remove('hidden')
  if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Replacing…' }
  try {
    const res = await fetch('/api/admin/update-source', { method: 'POST', body: fd, credentials: 'same-origin' })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || ('http ' + res.status))
    form.reset()
    refreshSourceStatus()
  } catch (e) {
    if (errEl) errEl.textContent = e.message
  } finally {
    if (busyEl) busyEl.classList.add('hidden')
    if (submitBtn) { submitBtn.disabled = false; if (origLabel) submitBtn.textContent = origLabel }
  }
}

function renderCustomerList() {
  const list = $('#customer-list')
  list.innerHTML = state.customers.map(renderCustomer).join('')
  bindCustomerActions()
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]))
}

// Group an array of online instances by version: [{version, count}], newest first.
function groupByVersion(arr) {
  const m = new Map()
  for (const item of arr || []) {
    const v = item.version || '?'
    m.set(v, (m.get(v) || 0) + 1)
  }
  const cmp = (a, b) => {
    const pa = String(a).split('.').map(n => parseInt(n, 10) || 0)
    const pb = String(b).split('.').map(n => parseInt(n, 10) || 0)
    for (let i = 0; i < 3; i++) { if (pa[i] !== pb[i]) return pb[i] - pa[i] }
    return 0
  }
  return [...m.entries()].sort((a, b) => cmp(a[0], b[0])).map(([version, count]) => ({ version, count }))
}

function rolePill(role, instances) {
  const total = (instances || []).length
  const cls = total > 0 ? 'live-online' : 'live-offline'
  const dot = total > 0 ? '●' : '○'
  const groups = groupByVersion(instances)
  const grouped = groups.length
    ? ' ' + groups.map(g => `${g.count}× v${escapeHtml(g.version)}`).join(', ')
    : ''
  return `<div class="live-pill role-pill ${cls}"><span class="live-role ${role}">${role.toUpperCase()}</span><span class="live-count">${dot} ${total}</span>${grouped ? `<span class="live-versions">${grouped}</span>` : ''}</div>`
}

function renderOnlinePill(channel) {
  const o = state.online[channel] || { launchers: [], servers: [], total: 0 }

  // Per-instance detail list (kept for the operator who wants to see individual
  // instance ids — collapsed by default to keep the card compact).
  const lines = []
  for (const l of o.launchers || []) {
    lines.push(`<div class="live-row"><span class="live-role launcher">LAUNCHER</span><span class="live-ver">v${escapeHtml(l.version || '?')}</span><span class="live-instance">${escapeHtml((l.instance || '').slice(0, 8))}</span></div>`)
  }
  for (const s of o.servers || []) {
    lines.push(`<div class="live-row"><span class="live-role server">SERVER</span><span class="live-ver">v${escapeHtml(s.version || '?')}</span><span class="live-instance">${escapeHtml((s.instance || '').slice(0, 8))}</span></div>`)
  }

  return `
    <div class="live-block">
      <div class="live-pills-row">
        ${rolePill('launcher', o.launchers)}
        ${rolePill('server', o.servers)}
      </div>
      ${lines.length ? `<div class="live-detail">${lines.join('')}</div>` : ''}
    </div>`
}

function renderCustomer(c) {
  // Per-customer payload download links — surface the published .zip URL on
  // the card so the operator can grab the latest installer/payload without
  // hand-typing /updates/<ch>/<v>/launcher-payload.zip.
  //
  // Three render states per role (launcher / server):
  //   1. No version known          → "no update yet" (never built)
  //   2. Version known, file present → [download] link
  //   3. Version known, file MISSING → "[file missing — rebuild]" warning
  //      (the publish step crashed mid-way, OR cleanup removed the zip;
  //       silently hiding the link here was the bug that made the operator
  //       think a successful build "didn't work" with zero diagnostic.)
  function dlMarkup(version, fileExists, channel, role) {
    if (!version) return ''
    const filename = role === 'launcher' ? 'launcher-payload.zip' : 'server-payload.zip'
    const channelPart = role === 'launcher' ? channel : channel + '-server'
    if (fileExists) {
      return ` <a class="dl-link" href="/updates/${encodeURIComponent(channelPart)}/${encodeURIComponent(version)}/${filename}" download title="Download ${role} payload zip">[download]</a>`
    }
    return ` <span class="dl-missing" title="The ${role} v${version} build was recorded but the payload zip is missing on the server. The publish step likely failed — please rebuild this customer and watch the BUILD CONSOLE for an error.">[file missing — rebuild]</span>`
  }
  const launcherDl = dlMarkup(c._launcherVersion, c._launcherFileExists, c.channel, 'launcher')
  const serverDl = dlMarkup(c._serverVersion, c._serverFileExists, c.channel, 'server')
  // Rebump pill — shown next to the version when the operator has reshipped
  // the SAME version one or more times via "Build From Uploaded Source".
  // Counter resets to 0 the moment the version actually changes, so a
  // visible pill is always relevant to the version it sits next to.
  function rebumpPill(count, ts) {
    if (!count || count < 1) return ''
    const when = ts ? new Date(ts).toLocaleString() : '—'
    const tip = `This version was re-shipped ${count} time${count === 1 ? '' : 's'} via Build From Uploaded Source. Most recent: ${when}.`
    return ` <span class="rebump-pill" title="${escapeHtml(tip)}">⟳ rebump ×${count} · ${escapeHtml(when)}</span>`
  }
  const launcherV = c._launcherVersion
    ? `v${escapeHtml(c._launcherVersion)}${launcherDl}${rebumpPill(c._launcherRebumpCount, c._launcherRebumpAt)}`
    : '<em>no update yet</em>'
  const serverV = c._serverVersion
    ? `v${escapeHtml(c._serverVersion)}${serverDl}${rebumpPill(c._serverRebumpCount, c._serverRebumpAt)}`
    : '<em>no update yet</em>'
  // "Last release" reflects the most recent publish event across launcher OR
  // server (rebumps update those timestamps too), so the operator immediately
  // sees activity from a re-shipped version.
  const lastTs = Math.max(c._launcherReleased || 0, c._serverReleased || 0,
                          c._launcherRebumpAt || 0, c._serverRebumpAt || 0)
  const released = lastTs ? new Date(lastTs).toLocaleString() : '—'
  const placeholder = c._placeholderUrl
  let warnBlock = ''
  if (c._urlIssue === 'loopback-when-remote') {
    warnBlock = `<div class="placeholder-warn"><strong>⚠ Loopback (localhost) URL but admin is being accessed remotely.</strong> Installed launchers on customer machines will dial <em>their own</em> loopback — not this server — and never receive OTA updates. Click <strong>Edit</strong> and set <code>Update Server URL</code> to this RDP host's reachable LAN/public IP (e.g. <code>http://203.0.113.45:4231</code>).</div>`
  } else if (placeholder) {
    warnBlock = `<div class="placeholder-warn"><strong>⚠ Placeholder update server URL.</strong> Click <strong>Edit</strong> and set <code>Update Server URL</code> to your real RDP/server IP (e.g. <code>http://203.0.113.45:4231</code>) before building, otherwise installed launchers will never receive OTA updates.</div>`
  }
  return `
  <div class="customer-card${placeholder ? ' has-warning' : ''}" data-channel="${escapeHtml(c.channel)}">
    <div class="name">${escapeHtml(c.brandName || c.channel)}</div>
    <div class="channel">channel: ${escapeHtml(c.channel)}</div>
    <div class="live-slot" data-live-slot="${escapeHtml(c.channel)}">${renderOnlinePill(c.channel)}</div>
    ${warnBlock}
    <div class="meta">
      <div><strong>Subtitle:</strong> ${escapeHtml(c.subtitle || '—')}</div>
      <div><strong>Server:</strong> ${escapeHtml(c.updateServer || '—')}</div>
      <div><strong>Logo:</strong> ${escapeHtml(c.logo || '<em>(none)</em>')}</div>
      <div><strong>Launcher current:</strong> ${launcherV}</div>
      <div><strong>Server current:</strong> ${serverV}</div>
      <div><strong>Last release:</strong> ${escapeHtml(released)}</div>
    </div>
    <div class="actions">
      <button class="btn-secondary small" data-action="edit">Edit</button>
      <button class="btn-primary" data-action="build" ${state.buildsAvailable ? '' : 'disabled'} title="Rebuild + ship BOTH launcher and server for this customer using the master source on disk.">Build</button>
      <button class="btn-secondary small" data-action="build-launcher" ${state.buildsAvailable ? '' : 'disabled'} title="Rebuild + ship ONLY the launcher (skips the server electron-builder substep).">Launcher</button>
      <button class="btn-secondary small" data-action="build-server" ${state.buildsAvailable ? '' : 'disabled'} title="Rebuild + ship ONLY the server (skips the vite + launcher electron-builder substep).">Server</button>
      <button class="btn-danger" data-action="delete">Delete</button>
    </div>
  </div>`
}

function bindCustomerActions() {
  $$('#customer-list .customer-card').forEach(card => {
    const channel = card.dataset.channel
    card.querySelectorAll('button[data-action]').forEach(btn => {
      btn.onclick = () => handleCustomerAction(channel, btn.dataset.action)
    })
  })
}

async function handleCustomerAction(channel, action) {
  if (action === 'edit') {
    openCustomerModal(state.customers.find(c => c.channel === channel))
  } else if (action === 'build') {
    triggerBuild({ channel })
  } else if (action === 'build-launcher') {
    triggerBuild({ channel, roles: ['launcher'] })
  } else if (action === 'build-server') {
    triggerBuild({ channel, roles: ['server'] })
  } else if (action === 'delete') {
    if (!confirm('Delete customer "' + channel + '"?\n\nThis removes the customer config AND all of its published builds (launcher + server payloads under /updates/' + channel + ', plus any local releases/' + channel + ' folder). This cannot be undone.')) return
    try {
      await api('DELETE', '/api/admin/customers/' + encodeURIComponent(channel))
      await loadCustomers()
    } catch (e) { alert('Delete failed: ' + e.message) }
  }
}

async function bumpVersion(silent) {
  const v = $('#version-input').value.trim() || $('#version-input').placeholder
  if (!/^\d+\.\d+\.\d+/.test(v)) {
    if (!silent) alert('Version must be in x.y.z format')
    return null
  }
  try {
    await api('POST', '/api/admin/version', { version: v })
    state.version = v
    $('#current-version').textContent = v
    $('#version-input').value = ''
    $('#version-input').placeholder = bumpPatch(v)
    // Toast-via-window is fine for non-job context messages — no need for
    // a job console card just to confirm a metadata-only mutation.
    if (!silent) console.info('[version] bumped to v' + v)
    return v
  } catch (e) {
    if (!silent) alert('Bump failed: ' + e.message)
    return null
  }
}

async function triggerBuild(opts) {
  const versionInput = $('#version-input').value.trim()
  let version = versionInput || null
  if (version && !/^\d+\.\d+\.\d+/.test(version)) {
    alert('Version must be x.y.z')
    return
  }
  // The single BUILD action always rebuilds + ships the update + cleans up + live-pushes.
  const body = { ...opts, version }
  try {
    const res = await api('POST', '/api/admin/build', body)
    // Server now always returns a jobs[] array (one entry per fanned-out
    // customer). Older single-channel callers still get jobId/status fields
    // for back-compat, but jobs[] is the source of truth here.
    const jobs = Array.isArray(res.jobs) ? res.jobs : (res.jobId ? [{
      jobId: res.jobId,
      channel: opts.channel,
      version,
      status: res.status,
    }] : [])
    if (jobs.length === 0) throw new Error('server returned no job ids')
    for (const j of jobs) {
      streamJob(j.jobId, 'Build ' + (j.channel || opts.channel || 'all'))
    }
    if (version) {
      state.version = version
      $('#current-version').textContent = version
      $('#version-input').value = ''
      $('#version-input').placeholder = bumpPatch(version)
    }
  } catch (e) {
    alert('Build failed to start: ' + e.message)
  }
}

// Per-job console card registry. Keys are jobId -> {card, output, status,
// step, cancelBtn, banner, evt}. Used by streamJob to upsert cards and by
// the CLEAR FINISHED button to drop terminated cards in one click.
const consoleCards = new Map()

// Task #17: total typical wall-clock for one customer build on the operator's
// machine. Used purely as the ETA denominator for the in-phase "creep" so the
// bar never freezes during a long step (electron-builder = ~30s with no log
// output). Wrong by 2x in either direction is fine — the bar still lands at
// the next phase's start whenever the next phase event fires, and snaps to
// 100% on success.
const BUILD_TOTAL_ETA_SEC = 90

function ensureConsoleCard(jobId, label) {
  const empty = document.getElementById('consoles-empty')
  if (empty) empty.classList.add('hidden')
  const existing = consoleCards.get(jobId)
  if (existing) return existing

  const area = document.getElementById('consoles-area')
  const card = document.createElement('div')
  card.className = 'console-card'
  card.id = 'console-card-' + jobId
  card.innerHTML =
    '<div class="console-card-head">' +
      '<span class="console-card-title"></span>' +
      '<span class="status-pill running">RUNNING</span>' +
      '<span class="console-card-elapsed" title="Elapsed wall-clock since the job started">00:00</span>' +
      '<button type="button" class="btn-secondary small console-card-cancel">Cancel</button>' +
    '</div>' +
    '<div class="progress-block">' +
      '<div class="progress-row">' +
        '<span class="progress-phase">Waiting in queue…</span>' +
        '<span class="progress-pct">0%</span>' +
      '</div>' +
      '<div class="progress-bar">' +
        '<div class="progress-fill" style="width:0%"></div>' +
      '</div>' +
    '</div>' +
    '<div class="job-error-banner hidden">' +
      '<div class="job-error-banner-title">Build Failed</div>' +
      '<div class="job-error-banner-body">' +
        '<span class="job-error-label">Failing step:</span> ' +
        '<span class="job-error-step-text">—</span> ' +
        '<span class="job-error-divider">|</span> ' +
        '<span class="job-error-label">Exit code:</span> ' +
        '<span class="job-error-exit-text">—</span>' +
      '</div>' +
    '</div>' +
    '<div class="log-toggle-row">' +
      '<button type="button" class="btn-ghost small log-toggle">Show Log</button>' +
    '</div>' +
    '<pre class="console hidden"></pre>'
  card.querySelector('.console-card-title').textContent = label + ' (job ' + jobId + ')'
  const cancelBtn = card.querySelector('.console-card-cancel')
  cancelBtn.addEventListener('click', () => cancelJob(jobId))
  const logToggle = card.querySelector('.log-toggle')
  const consoleEl = card.querySelector('.console')
  logToggle.addEventListener('click', () => {
    const hidden = consoleEl.classList.toggle('hidden')
    logToggle.textContent = hidden ? 'Show Log' : 'Hide Log'
    if (!hidden) consoleEl.scrollTop = consoleEl.scrollHeight
  })
  area.appendChild(card)

  const rec = {
    card,
    output: consoleEl,
    statusPill: card.querySelector('.status-pill'),
    cancelBtn,
    elapsedEl: card.querySelector('.console-card-elapsed'),
    phaseEl: card.querySelector('.progress-phase'),
    pctEl: card.querySelector('.progress-pct'),
    fillEl: card.querySelector('.progress-fill'),
    logToggle,
    banner: card.querySelector('.job-error-banner'),
    bannerStep: card.querySelector('.job-error-step-text'),
    bannerExit: card.querySelector('.job-error-exit-text'),
    evt: null,
    finished: false,
    // --- DOM batching state (see appendConsoleLine / flushConsoleQueue) ---
    // SSE can deliver hundreds of log lines per animation frame during heavy
    // build steps (npm install, packaging). Doing one DOM mutation per line
    // freezes the tab. We queue lines and flush at most once per rAF, in a
    // single DocumentFragment, with one autoscroll at the end.
    queue: [],
    flushScheduled: false,
    totalAppended: 0,
    // Hard ceiling so a runaway stream cannot OOM the tab. When exceeded we
    // remove old <div> children from the head of `output`. 5000 lines is more
    // than enough to debug and well below the point where the tab struggles.
    MAX_LINES: 5000,
    // --- Progress / phase state ---
    // The current phase event we received, plus an interval id for the
    // in-phase "creep" + the elapsed-timer tick. setProgressFromPhase()
    // owns these.
    currentPhase: null,    // {phase, label, weight, weightSoFar} or null
    barFraction: 0,        // 0..1 — last fraction we set on .progress-fill
    creepTimer: null,
    elapsedTimer: null,
    startedAt: null,
  }
  rec._jobId = jobId
  consoleCards.set(jobId, rec)
  updateClearFinishedButton()
  return rec
}

// Animate the bar smoothly within the current phase. The CSS transition
// already handles the jump-to-phase-start when a phase event fires; this
// function adds the in-phase "creep" so a long step (electron-builder is
// ~30s with periods of total log silence) doesn't make the bar look frozen.
//
// Creep target = weightSoFar + 0.95*weight. We deliberately stop short of
// the next phase's start so the bar still has somewhere to JUMP when the
// next phase event arrives — that visible step-up is the operator's cue
// that "the next thing started", which matters for cancellable steps.
function setProgressFromPhase(rec, phaseEvt) {
  rec.currentPhase = phaseEvt
  const start = phaseEvt.weightSoFar
  const end = Math.min(0.999, start + phaseEvt.weight * 0.95)
  rec.phaseEl.textContent = phaseEvt.label
  setBarFraction(rec, start)
  // Clear any previous creep before starting a new one.
  if (rec.creepTimer) { clearInterval(rec.creepTimer); rec.creepTimer = null }
  // Per-phase ETA in ms — a fraction of the global build estimate scaled
  // by this phase's weight.
  const etaMs = Math.max(800, phaseEvt.weight * BUILD_TOTAL_ETA_SEC * 1000)
  const ticks = 30                                   // ~3.3% of phase per tick
  const stepInterval = Math.max(150, etaMs / ticks)
  const startedTickAt = Date.now()
  rec.creepTimer = setInterval(() => {
    if (rec.finished) {
      clearInterval(rec.creepTimer)
      rec.creepTimer = null
      return
    }
    const elapsed = Date.now() - startedTickAt
    // Asymptotic curve toward `end` so the bar never quite reaches it
    // before the next phase fires. Looks like a slowing creep.
    const progress = 1 - Math.exp(-elapsed / etaMs)
    const target = start + (end - start) * progress
    if (target > rec.barFraction) setBarFraction(rec, target)
  }, stepInterval)
}

function setBarFraction(rec, frac) {
  const f = Math.max(0, Math.min(1, frac))
  rec.barFraction = f
  const pct = Math.round(f * 100)
  rec.fillEl.style.width = pct + '%'
  rec.pctEl.textContent = pct + '%'
}

function fmtElapsed(ms) {
  if (ms < 0) ms = 0
  const s = Math.floor(ms / 1000)
  const mm = Math.floor(s / 60)
  const ss = s % 60
  return String(mm).padStart(2, '0') + ':' + String(ss).padStart(2, '0')
}

function startElapsedTicker(rec) {
  if (rec.elapsedTimer) return
  if (!rec.startedAt) rec.startedAt = Date.now()
  rec.elapsedEl.textContent = fmtElapsed(Date.now() - rec.startedAt)
  rec.elapsedTimer = setInterval(() => {
    if (rec.finished) return
    rec.elapsedEl.textContent = fmtElapsed(Date.now() - rec.startedAt)
  }, 1000)
}

function stopElapsedTicker(rec) {
  if (rec.elapsedTimer) {
    clearInterval(rec.elapsedTimer)
    rec.elapsedTimer = null
  }
  if (rec.creepTimer) {
    clearInterval(rec.creepTimer)
    rec.creepTimer = null
  }
  if (rec.startedAt) {
    rec.elapsedEl.textContent = fmtElapsed(Date.now() - rec.startedAt)
  }
}

// Flush all queued lines for `rec` in a single DOM mutation. Called from
// requestAnimationFrame (normal path) and synchronously from the terminal
// `data.end` handler (so the user sees every line before the SUCCESS pill).
function flushConsoleQueue(rec) {
  rec.flushScheduled = false
  if (!rec.queue.length) return
  const frag = document.createDocumentFragment()
  for (const item of rec.queue) {
    const line = document.createElement('div')
    if (item.cls) line.className = 'line-' + item.cls
    line.textContent = item.text
    frag.appendChild(line)
  }
  rec.queue.length = 0
  rec.output.appendChild(frag)
  rec.totalAppended = rec.output.childNodes.length
  // Bound the DOM size. Removing from the head keeps the most-recent log
  // visible (which is what the user is reading).
  if (rec.totalAppended > rec.MAX_LINES) {
    const drop = rec.totalAppended - rec.MAX_LINES
    for (let i = 0; i < drop; i++) {
      const first = rec.output.firstChild
      if (!first) break
      rec.output.removeChild(first)
    }
    // One sentinel so the user knows the head was elided.
    if (!rec.output.firstChild || rec.output.firstChild.dataset.elision !== '1') {
      const sentinel = document.createElement('div')
      sentinel.className = 'line-cmd'
      sentinel.dataset.elision = '1'
      sentinel.textContent = '[… older lines elided to keep the page responsive …]'
      rec.output.insertBefore(sentinel, rec.output.firstChild)
    }
  }
  rec.output.scrollTop = rec.output.scrollHeight
}

function appendConsoleLine(rec, text, cls) {
  rec.queue.push({ text, cls })
  if (!rec.flushScheduled) {
    rec.flushScheduled = true
    requestAnimationFrame(() => flushConsoleQueue(rec))
  }
}

function setCardStatus(rec, text, cls) {
  rec.statusPill.textContent = text || ''
  rec.statusPill.className = 'status-pill' + (cls ? ' ' + cls : '')
}

function streamJob(jobId, label) {
  const rec = ensureConsoleCard(jobId, label)
  // If we're already streaming this job (rare — operator double-clicks
  // BUILD), keep the existing EventSource and skip rewiring.
  if (rec.evt) return
  // Track the most-recently-opened job so the keyboard shortcut (if any) and
  // the legacy single-job CANCEL JOB header button keep working.
  state.currentJobId = jobId

  // Only print the per-card header line if the console doesn't already have
  // one. After a mid-build page refresh the queue snapshot rehydrates this
  // card by calling streamJob again; without this guard each refresh would
  // tack on another '=== BUILD <channel> (job …) ===' line on top of the
  // one already shown. A brand-new card has an empty <pre>, so the header
  // is still printed in the common (non-rehydrate) case.
  const headerText = '=== ' + label + ' (job ' + jobId + ') ==='
  const alreadyHasHeader = Array.from(rec.output.children).some(
    child => child.textContent === headerText
  )
  if (!alreadyHasHeader) {
    appendConsoleLine(rec, headerText, 'cmd')
  }
  setCardStatus(rec, 'RUNNING', 'running')
  rec.cancelBtn.classList.remove('hidden')
  // NOTE: we deliberately do NOT call startElapsedTicker here. The ticker
  // is started by renderQueue's snapshot pass once the job is observed in
  // the active set, with rec.startedAt seeded from j.startedAt (the
  // server-authoritative start time). Starting it eagerly here would
  // wrongly include queue-wait time for rehydrated cards whose underlying
  // job is still QUEUED — and would tick from the local card-creation
  // moment instead of the server's startedAt for jobs that just dispatched.

  const evt = new EventSource('/api/admin/jobs/' + jobId + '/stream')
  rec.evt = evt
  evt.onmessage = (m) => {
    try {
      const data = JSON.parse(m.data)
      if (data.end) {
        const cancelled = data.status === 'cancelled'
        const ok = data.exitCode === 0 && !cancelled
        let pillText, pillCls
        if (cancelled) { pillText = 'CANCELLED'; pillCls = 'failed' }
        else if (ok) { pillText = 'SUCCESS'; pillCls = 'success' }
        else { pillText = 'FAILED (' + data.exitCode + ')'; pillCls = 'failed' }
        setCardStatus(rec, pillText, pillCls)
        appendConsoleLine(rec, '', '')
        if (cancelled) {
          appendConsoleLine(rec, '=== CANCELLED ===', 'error')
          // Stop the bar wherever it is, mute its colour. Don't snap to 100%
          // — leaving it at the cancelled position preserves the operator's
          // mental model of "it stopped here".
          rec.card.classList.add('cancelled')
          rec.phaseEl.textContent = 'Cancelled'
        } else if (ok) {
          appendConsoleLine(rec, '=== SUCCESS (exit ' + data.exitCode + ') ===', 'success')
          // Snap the bar to 100% on success so a fast build that didn't have
          // time to creep through every phase still LOOKS finished.
          setBarFraction(rec, 1)
          rec.phaseEl.textContent = 'Done'
        } else {
          appendConsoleLine(rec, '=== FAILED (exit ' + data.exitCode + ') ===', 'error')
          if (data.failedStep) {
            appendConsoleLine(rec, '!! Failing step: ' + data.failedStep, 'error')
          }
          rec.bannerStep.textContent = data.failedStep || '(unknown — see console)'
          rec.bannerExit.textContent = String(data.exitCode == null ? '?' : data.exitCode)
          rec.banner.classList.remove('hidden')
          rec.card.classList.add('failed')
          rec.phaseEl.textContent = 'Failed: ' + (data.failedStep || 'unknown step')
          // Auto-expand the log on failure so the operator immediately sees
          // the tail without an extra click.
          if (rec.output.classList.contains('hidden')) {
            rec.output.classList.remove('hidden')
            rec.logToggle.textContent = 'Hide Log'
          }
        }
        // Force a synchronous flush so the user sees every queued line
        // (including the just-appended === SUCCESS === / banner) BEFORE the
        // EventSource closes. Without this the queue could still be sitting
        // in a pending rAF when we tear the connection down.
        flushConsoleQueue(rec)
        evt.close()
        rec.evt = null
        rec.finished = true
        rec.card.classList.add('finished')
        rec.cancelBtn.classList.add('hidden')
        stopElapsedTicker(rec)
        updateClearFinishedButton()
        loadCustomers()
        // A successful Full Repo build refreshes the cached baseline on the
        // server; invalidate the local cache so the next renderer (or a
        // mode-toggle click) re-fetches fresh "refreshed Ns ago" timestamps.
        // Cheap to do unconditionally — patch successes won't have changed
        // the baseline, but the refetch is harmless and keeps the banner
        // accurate even if a parallel Full upload landed during this build.
        if (ok) {
          refreshSourceStatus()
        }
        // T005: Only successful builds auto-clear. Failed/cancelled cards
        // stay so the operator never misses a failure. startAutoClear is a
        // no-op if the card is already marked failed/cancelled, so this is
        // safe even if the success branch above didn't run.
        if (ok) startAutoClear(rec)
        return
      }
      // Task #17: structured phase event drives the progress bar.
      if (data.phase) {
        setProgressFromPhase(rec, data)
        return
      }
      let cls = ''
      const line = data.line || ''
      if (/^\$\s/.test(line)) cls = 'cmd'
      else if (/^===\s/.test(line)) cls = 'cmd'
      else if (/^!!\s/.test(line)) cls = 'error'
      else if (/error|failed|fatal/i.test(line)) cls = 'error'
      else if (/^==\s|^=== DONE|success|\[OK\]/i.test(line)) cls = 'success'
      appendConsoleLine(rec, line, cls)
    } catch (e) {}
  }
  evt.onerror = () => {
    if (rec.finished) return
    setCardStatus(rec, 'Stream Error', 'failed')
    try { evt.close() } catch (_) {}
    rec.evt = null
  }
}

function updateClearFinishedButton() {
  const btn = document.getElementById('clear-finished-consoles-btn')
  if (!btn) return
  const anyFinished = Array.from(consoleCards.values()).some(r => r.finished)
  if (anyFinished) btn.classList.remove('hidden')
  else btn.classList.add('hidden')
}

function clearFinishedConsoles() {
  for (const [id, rec] of Array.from(consoleCards.entries())) {
    if (rec.finished) {
      stopAutoClear(rec)
      rec.card.remove()
      consoleCards.delete(id)
    }
  }
  updateClearFinishedButton()
  if (consoleCards.size === 0) {
    const empty = document.getElementById('consoles-empty')
    if (empty) empty.classList.remove('hidden')
  }
}

// T005: Auto-clear successful build consoles after 15s of no interaction.
// Failed/cancelled cards are EXEMPT — they stay until the operator clicks
// "Clear Finished" so failures cannot be missed. Hovering or focusing the
// card cancels the countdown; clicking the inline "keep" link does the same.
const AUTO_CLEAR_SECONDS = 15
const AUTO_CLEAR_FADE_MS = 200

function startAutoClear(rec) {
  if (!rec || !rec.finished) return
  if (rec.card.classList.contains('failed') || rec.card.classList.contains('cancelled')) return
  if (rec.autoClearTimer) return // already running

  const head = rec.card.querySelector('.console-card-head')
  if (!head) return
  // Drop any stale pill from a previous start (defensive — shouldn't happen).
  const old = head.querySelector('.auto-clear-pill')
  if (old) old.remove()

  let remaining = AUTO_CLEAR_SECONDS
  const pill = document.createElement('span')
  pill.className = 'auto-clear-pill'
  pill.innerHTML = '<span class="auto-clear-text">Auto-clear in ' + remaining + 's</span> · ' +
                   '<button type="button" class="auto-clear-keep" title="Cancel auto-clear and keep this card">keep</button>'
  // Insert before the cancel button (which is hidden on finished cards) so
  // the pill sits next to the status pill.
  const cancelBtn = head.querySelector('.console-card-cancel')
  if (cancelBtn) head.insertBefore(pill, cancelBtn); else head.appendChild(pill)
  rec.autoClearPill = pill
  const textEl = pill.querySelector('.auto-clear-text')

  // Clicking the inline "keep" link — or hovering / focusing the card —
  // cancels the countdown. We bind hover/focus on the CARD (not the pill)
  // so any operator interaction with the card pins it.
  const cancelHandler = () => stopAutoClear(rec)
  pill.querySelector('.auto-clear-keep').addEventListener('click', (e) => {
    e.preventDefault()
    cancelHandler()
  })
  rec.autoClearHoverHandler = cancelHandler
  rec.card.addEventListener('mouseenter', cancelHandler, { once: true })
  rec.card.addEventListener('focusin', cancelHandler, { once: true })

  rec.autoClearTimer = setInterval(() => {
    remaining -= 1
    if (remaining > 0) {
      if (textEl) textEl.textContent = 'Auto-clear in ' + remaining + 's'
      return
    }
    // Time's up — fade then remove. Stop the interval first so a slow tab
    // can't tick again mid-fade.
    clearInterval(rec.autoClearTimer)
    rec.autoClearTimer = null
    rec.card.classList.add('fading-out')
    setTimeout(() => {
      // The user may have clicked "Clear Finished" during the 200ms fade,
      // which already removed the card. Guard against double-remove.
      if (consoleCards.has(rec._jobId)) {
        rec.card.remove()
        consoleCards.delete(rec._jobId)
      }
      updateClearFinishedButton()
      if (consoleCards.size === 0) {
        const empty = document.getElementById('consoles-empty')
        if (empty) empty.classList.remove('hidden')
      }
    }, AUTO_CLEAR_FADE_MS)
  }, 1000)
}

function stopAutoClear(rec) {
  if (!rec) return
  if (rec.autoClearTimer) { clearInterval(rec.autoClearTimer); rec.autoClearTimer = null }
  if (rec.autoClearPill) { rec.autoClearPill.remove(); rec.autoClearPill = null }
  if (rec.autoClearHoverHandler) {
    rec.card.removeEventListener('mouseenter', rec.autoClearHoverHandler)
    rec.card.removeEventListener('focusin', rec.autoClearHoverHandler)
    rec.autoClearHoverHandler = null
  }
}

// ---- BUILD QUEUE panel ----
// Cancel buttons now live ON each console card (per-job) AND on each queue
// row — there is no global CANCEL JOB button anymore, since the multi-console
// fan-out makes "the current job" ambiguous.

function openQueueStream() {
  closeQueueStream()
  // Seed once via REST so the panel paints immediately on page load even
  // before the SSE connection lands.
  api('GET', '/api/admin/jobs').then(d => { if (d) renderQueue(d) }).catch(() => {})
  const evt = new EventSource('/api/admin/jobs/stream')
  state.queueEvtSrc = evt
  evt.onmessage = (m) => {
    try { renderQueue(JSON.parse(m.data)) } catch (e) {}
  }
  evt.onerror = () => {
    // Auto-reconnect after a beat — the EventSource itself will retry, but
    // we re-paint as soon as a fresh snapshot arrives.
  }
}

function closeQueueStream() {
  if (state.queueEvtSrc) {
    try { state.queueEvtSrc.close() } catch (e) {}
    state.queueEvtSrc = null
  }
}

function renderQueue(snap) {
  state.lastQueueSnapshot = snap
  const queue = snap.queue || { active: [], queued: [], maxConcurrent: 2 }
  const jobs = snap.jobs || []
  const byId = new Map(jobs.map(j => [j.id, j]))
  $('#queue-slots').textContent = 'SLOTS ' + queue.active.length + '/' + queue.maxConcurrent
  const list = $('#queue-list')
  list.innerHTML = ''
  const rows = []
  queue.active.forEach(id => {
    const j = byId.get(id); if (j) rows.push({ j, kind: 'active', pos: null })
  })
  queue.queued.forEach((id, i) => {
    const j = byId.get(id); if (j) rows.push({ j, kind: 'queued', pos: i + 1 })
  })
  if (rows.length === 0) {
    list.innerHTML = '<div class="muted small">No active or queued jobs.</div>'
    return
  }
  for (const { j, kind, pos } of rows) {
    const row = document.createElement('div')
    row.className = 'queue-row queue-row-' + kind
    const status = kind === 'active' ? 'RUNNING' : ('QUEUED #' + pos)
    // Prefer the more granular phase label when the job has reached one;
    // fall back to the coarser step label for jobs still in the early
    // workspace-allocation phase before the first SUBSTEP_BEGIN fires.
    const phaseLabel = j.currentPhaseLabel
      ? (' — ' + j.currentPhaseLabel)
      : (j.currentStep ? (' — step: ' + j.currentStep) : '')
    const stepNote = phaseLabel
    const chans = (j.channels && j.channels.length) ? (' [' + j.channels.join(', ') + ']') : ''
    row.innerHTML =
      '<span class="queue-row-status">' + status + '</span>' +
      '<span class="queue-row-label">' + escapeHtml(j.label) + chans + '</span>' +
      '<span class="queue-row-step muted small">' + escapeHtml(stepNote) + '</span>' +
      '<button class="btn-secondary small queue-row-cancel" data-job="' + j.id + '">Cancel</button>'
    list.appendChild(row)
  }
  list.querySelectorAll('.queue-row-cancel').forEach(btn => {
    btn.addEventListener('click', () => cancelJob(btn.getAttribute('data-job')))
  })
  // Rehydrate console cards on page reload: any active/queued job without a
  // console card yet (operator hit refresh mid-build) gets a fresh stream
  // attached so the multi-console UI reflects in-flight work instead of
  // looking idle while jobs are actually running. streamJob is idempotent
  // via the consoleCards Map so this is safe to call repeatedly.
  for (const id of [...queue.active, ...queue.queued]) {
    if (!consoleCards.has(id)) {
      const j = byId.get(id)
      if (j) {
        const chTag = (j.channels && j.channels.length === 1) ? j.channels[0] : 'all'
        streamJob(id, 'Build ' + chTag)
      }
    }
  }
  // Mirror each non-terminal job's queue/run status onto its console card,
  // and — critically for Task #17 mid-build refresh UX — seed the progress
  // bar from the snapshot data so a refreshed card never sits at 0% or
  // "Waiting in queue…" while waiting for the SSE replay to catch up. The
  // snapshot carries currentPhase + currentPhaseLabel + currentPhaseWeight
  // + currentPhaseWeightSoFar (see job-runner.listJobs), which is enough
  // to reconstruct the same {phase,label,weight,weightSoFar} object that
  // setProgressFromPhase consumes during a live SSE stream. We also seed
  // the elapsed timer from j.startedAt so the mm:ss counter is wall-clock
  // accurate even if the operator opened the panel mid-build.
  const queuedSet = new Set(queue.queued)
  const activeSet = new Set(queue.active)
  for (const j of jobs) {
    const rec = consoleCards.get(j.id)
    if (rec && !rec.finished) {
      if (queuedSet.has(j.id)) {
        setCardStatus(rec, 'QUEUED', 'queued')
        if (!rec.currentPhase) rec.phaseEl.textContent = 'Waiting in queue…'
        // Queued jobs haven't started running yet — make sure the elapsed
        // counter stays at 00:00 (a previously-active card that re-queued
        // somehow would otherwise keep ticking up). The ticker is restarted
        // when this job moves to ACTIVE on a later snapshot.
        if (rec.elapsedTimer) {
          clearInterval(rec.elapsedTimer)
          rec.elapsedTimer = null
        }
        rec.elapsedEl.textContent = '00:00'
      } else if (activeSet.has(j.id)) {
        setCardStatus(rec, 'RUNNING', 'running')
        // Always trust j.startedAt as the source of truth for when the
        // job ACTUALLY started running (server clock). This prevents the
        // elapsed counter from including queue-wait time and corrects
        // any earlier seed that was off (e.g. card created before the
        // job dispatched, or different system clocks).
        if (j.startedAt) rec.startedAt = j.startedAt
        startElapsedTicker(rec)
      }
      // Seed the progress bar from the snapshot. Skip if a more recent
      // phase has already arrived via SSE (rec.currentPhase is the live
      // phase event object whose .phase id we compare). For queued jobs
      // currentPhase is null so this is a no-op — the bar correctly stays
      // at 0% until the job becomes active.
      if (j.currentPhase && (!rec.currentPhase || rec.currentPhase.phase !== j.currentPhase)) {
        setProgressFromPhase(rec, {
          phase: j.currentPhase,
          label: j.currentPhaseLabel || j.currentPhase,
          weight: j.currentPhaseWeight || 0,
          weightSoFar: j.currentPhaseWeightSoFar || 0,
          startedAt: j.startedAt || Date.now(),
        })
      }
    }
  }
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]))
}

async function cancelJob(jobId) {
  if (!jobId) return
  if (!confirm('Cancel job ' + jobId + '? If it is running this will kill the build process tree.')) return
  // Optimistic UI: grey-out + disable any queue-row CANCEL button for this
  // jobId immediately so the operator gets feedback without waiting for the
  // next queue snapshot. The next renderQueue tick will rebuild rows from
  // the authoritative snapshot — terminal rows naturally drop off at that
  // point. If the API call itself fails, we re-enable in the catch below.
  const rowBtns = Array.from(document.querySelectorAll('.queue-row-cancel[data-job="' + jobId + '"]'))
  for (const btn of rowBtns) {
    btn.disabled = true
    btn.textContent = 'Cancelling…'
    const row = btn.closest('.queue-row')
    if (row) row.classList.add('queue-row-cancelling')
  }
  try {
    await api('POST', '/api/admin/jobs/' + encodeURIComponent(jobId) + '/cancel')
    // If we have a console card for this job, write a confirmation line so
    // the operator sees the cancel-request immediately rather than waiting
    // for the server's [cancel] log line to arrive over SSE.
    const rec = consoleCards.get(jobId)
    if (rec) appendConsoleLine(rec, '[cancel] requested cancellation of job ' + jobId, 'cmd')
  } catch (e) {
    // Revert the optimistic grey-out so the operator can retry.
    for (const btn of rowBtns) {
      btn.disabled = false
      btn.textContent = 'Cancel'
      const row = btn.closest('.queue-row')
      if (row) row.classList.remove('queue-row-cancelling')
    }
    alert('Cancel failed: ' + e.message)
  }
}

// Wire the global CLEAR FINISHED button (only visible when at least one
// console card has reached a terminal state). Per-job cancel buttons are
// wired in ensureConsoleCard.
document.addEventListener('DOMContentLoaded', () => {
  const b = document.getElementById('clear-finished-consoles-btn')
  if (b) b.addEventListener('click', clearFinishedConsoles)
})

// ---- Live online status (SSE) ----
function openOnlineStream() {
  closeOnlineStream()
  // Seed once via REST in case SSE init fails on slow links
  api('GET', '/api/admin/online').then(d => {
    if (d && d.online) {
      state.online = d.online
      updateAllLiveSlots()
    }
  }).catch(() => {})

  try {
    const evt = new EventSource('/api/admin/online/stream')
    state.onlineEvtSrc = evt
    evt.onmessage = (m) => {
      try {
        const data = JSON.parse(m.data)
        if (data.online) {
          state.online = data.online
          updateAllLiveSlots()
        }
      } catch (e) {}
    }
    evt.onerror = () => {
      // Auto-retry by closing + reopening after a delay
      try { evt.close() } catch (e) {}
      state.onlineEvtSrc = null
      setTimeout(() => {
        if ($('#app-screen').classList.contains('hidden')) return
        openOnlineStream()
      }, 5000)
    }
  } catch (e) {}
}
function closeOnlineStream() {
  if (state.onlineEvtSrc) {
    try { state.onlineEvtSrc.close() } catch (e) {}
    state.onlineEvtSrc = null
  }
}
function updateAllLiveSlots() {
  $$('#customer-list .live-slot').forEach(slot => {
    const ch = slot.dataset.liveSlot
    slot.innerHTML = renderOnlinePill(ch)
  })
}

// ---- Customer modal ----
function openCustomerModal(c) {
  const isNew = !c
  $('#customer-modal-title').textContent = isNew ? 'New Customer' : 'Edit: ' + (c.brandName || c.channel)
  $('#cm-channel').value = c?.channel || ''
  $('#cm-channel').readOnly = !isNew
  if (isNew) {
    $('#cm-channel-label').classList.remove('hidden')
    $('#cm-channel-readonly').classList.add('hidden')
  } else {
    $('#cm-channel-label').classList.add('hidden')
    $('#cm-channel-readonly').classList.remove('hidden')
    $('#cm-channel-readonly-value').textContent = c.channel
  }
  $('#cm-brand').value = c?.brandName || ''
  $('#cm-subtitle').value = c?.subtitle || ''
  $('#cm-server').value = c?.updateServer || ('http://' + window.location.hostname + ':4231')
  $('#cm-logo').value = c?.logo || ''
  $('#cm-logo-upload').value = ''
  $('#cm-error').textContent = ''
  $('#customer-modal').classList.remove('hidden')
}

function closeCustomerModal() {
  $('#customer-modal').classList.add('hidden')
}

async function saveCustomer(e) {
  e.preventDefault()
  const channel = $('#cm-channel').value.trim()
  const file = $('#cm-logo-upload').files[0]
  const typedLogo = $('#cm-logo').value.trim()
  const body = {
    channel,
    brandName: $('#cm-brand').value.trim(),
    subtitle: $('#cm-subtitle').value.trim(),
    updateServer: $('#cm-server').value.trim(),
    logo: file ? undefined : (typedLogo || undefined),
  }
  try {
    await api('POST', '/api/admin/customers', body)
    if (file) {
      const fd = new FormData()
      fd.append('logo', file)
      await api('POST', '/api/admin/customers/' + encodeURIComponent(channel) + '/logo', fd, true)
    } else if (typedLogo) {
      $('#cm-error').textContent = 'Saved. NOTE: logo path "' + typedLogo + '" must exist on disk before BUILD or the build will fail.'
      $('#cm-error').classList.add('warn-only')
      setTimeout(() => { $('#cm-error').classList.remove('warn-only') }, 4000)
    }
    closeCustomerModal()
    await loadCustomers()
  } catch (e) {
    $('#cm-error').textContent = e.message
  }
}

function autoFillLogoPathFromUpload() {
  const file = $('#cm-logo-upload').files[0]
  if (!file) return
  const channel = $('#cm-channel').value.trim()
  if (!channel) return
  const ext = (file.name.match(/\.[^.]+$/) || ['.png'])[0].toLowerCase()
  const allowed = ['.png', '.jpg', '.jpeg', '.webp', '.bmp']
  const safeExt = allowed.includes(ext) ? ext : '.png'
  $('#cm-logo').value = 'branding/' + channel + '-logo' + safeExt
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  $('#login-error').textContent = ''
  const password = $('#login-password').value
  try {
    await api('POST', '/api/admin/login', { password })
    const status = await api('GET', '/api/admin/status')
    state.version = status.version
    state.serverVersion = status.serverVersion || null
    state.projectRoot = status.projectRoot
    state.buildsAvailable = status.buildsAvailable
    state.deps = status.deps || null
    state.buildStamp = status.buildStamp || null
    showApp()
  } catch (e) {
    $('#login-error').textContent = e.message
  }
})

$('#logout-btn').addEventListener('click', async () => {
  try { await api('POST', '/api/admin/logout') } catch (e) {}
  showLogin()
})

$('#bump-version-btn').addEventListener('click', () => bumpVersion(false))
$('#build-all-btn').addEventListener('click', () => triggerBuild({ all: true }))
$('#add-customer-btn').addEventListener('click', () => openCustomerModal(null))
$('#cm-cancel').addEventListener('click', closeCustomerModal)
$('#customer-form').addEventListener('submit', saveCustomer)
$('#cm-logo-upload').addEventListener('change', autoFillLogoPathFromUpload)
$('#cm-channel').addEventListener('input', autoFillLogoPathFromUpload)
$('#customer-modal').addEventListener('click', (e) => {
  if (e.target === $('#customer-modal')) closeCustomerModal()
})

// ---- Update Source Files: wire the two source-card forms ------------
// Each form carries a data-source-kind="launcher|server" attribute and
// posts to /api/admin/update-source via submitUpdateSource(). Wired with
// addEventListener (not onsubmit) so we can attach to both at once.
document.querySelectorAll('.source-card-form').forEach(f => {
  f.addEventListener('submit', (e) => { e.preventDefault(); submitUpdateSource(f) })
})

init()
