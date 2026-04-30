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
    label = 'MISSING'; cls = 'missing'
    msg = 'Project dependencies are not installed (root + server). The next BUILD will run "npm install" automatically before building — first build may take 1–3 minutes.'
  } else {
    label = 'PARTIAL'; cls = 'partial'
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
  $('#project-root').textContent = state.projectRoot || '(not detected)'
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
    populateBulkUploadTargets()
    if (state.customers.length === 0) {
      list.innerHTML = '<div class="muted">No customers yet. Click "+ ADD CUSTOMER" to create the first one.</div>'
      return
    }
    renderCustomerList()
  } catch (e) {
    list.innerHTML = '<div class="error">Failed to load: ' + escapeHtml(e.message) + '</div>'
  }
}

function populateBulkUploadTargets() {
  const sel = $('#bup-target')
  if (!sel) return
  const prev = sel.value
  sel.innerHTML = '<option value="__all__">ALL CUSTOMERS</option>' +
    state.customers.map(c => `<option value="${escapeHtml(c.channel)}">${escapeHtml(c.channel)} — ${escapeHtml(c.brandName || '')}</option>`).join('')
  if (prev) sel.value = prev
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
  // hand-typing /updates/<ch>/<v>/launcher-payload.zip. Hidden when the
  // channel has not been published yet (no version in DB).
  const launcherDl = c._launcherVersion
    ? ` <a class="dl-link" href="/updates/${encodeURIComponent(c.channel)}/${encodeURIComponent(c._launcherVersion)}/launcher-payload.zip" download title="Download launcher payload zip">[download]</a>`
    : ''
  const serverDl = c._serverVersion
    ? ` <a class="dl-link" href="/updates/${encodeURIComponent(c.channel)}-server/${encodeURIComponent(c._serverVersion)}/server-payload.zip" download title="Download server payload zip">[download]</a>`
    : ''
  const launcherV = c._launcherVersion ? `v${escapeHtml(c._launcherVersion)}${launcherDl}` : '<em>no update yet</em>'
  const serverV = c._serverVersion ? `v${escapeHtml(c._serverVersion)}${serverDl}` : '<em>no update yet</em>'
  const released = c._launcherReleased ? new Date(c._launcherReleased).toLocaleString() : '—'
  const placeholder = c._placeholderUrl
  let warnBlock = ''
  if (c._urlIssue === 'loopback-when-remote') {
    warnBlock = `<div class="placeholder-warn"><strong>⚠ Loopback (localhost) URL but admin is being accessed remotely.</strong> Installed launchers on customer machines will dial <em>their own</em> loopback — not this server — and never receive OTA updates. Click EDIT and set <code>UPDATE SERVER URL</code> to this RDP host's reachable LAN/public IP (e.g. <code>http://203.0.113.45:4231</code>).</div>`
  } else if (placeholder) {
    warnBlock = `<div class="placeholder-warn"><strong>⚠ Placeholder update server URL.</strong> Click EDIT and set <code>UPDATE SERVER URL</code> to your real RDP/server IP (e.g. <code>http://203.0.113.45:4231</code>) before building, otherwise installed launchers will never receive OTA updates.</div>`
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
      <button class="btn-secondary small" data-action="edit">EDIT</button>
      <button class="btn-primary glow" data-action="build" ${state.buildsAvailable ? '' : 'disabled'}>BUILD</button>
      <button class="btn-secondary small" data-action="upload">UPLOAD UPDATE</button>
      <button class="btn-danger" data-action="delete">DELETE</button>
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
  } else if (action === 'upload') {
    openUploadModal(channel)
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
      streamJob(j.jobId, 'BUILD ' + (j.channel || opts.channel || 'all'))
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
      '<button type="button" class="btn-secondary small console-card-cancel">CANCEL</button>' +
      '<span class="console-card-step muted small"></span>' +
    '</div>' +
    '<div class="job-error-banner hidden">' +
      '<div class="job-error-banner-title">!! BUILD FAILED</div>' +
      '<div class="job-error-banner-body">' +
        '<span class="job-error-label">Failing step:</span> ' +
        '<span class="job-error-step-text">—</span> ' +
        '<span class="job-error-divider">|</span> ' +
        '<span class="job-error-label">Exit code:</span> ' +
        '<span class="job-error-exit-text">—</span>' +
      '</div>' +
    '</div>' +
    '<pre class="console"></pre>'
  card.querySelector('.console-card-title').textContent = label + ' (job ' + jobId + ')'
  const cancelBtn = card.querySelector('.console-card-cancel')
  cancelBtn.addEventListener('click', () => cancelJob(jobId))
  area.appendChild(card)

  const rec = {
    card,
    output: card.querySelector('.console'),
    statusPill: card.querySelector('.status-pill'),
    stepEl: card.querySelector('.console-card-step'),
    cancelBtn,
    banner: card.querySelector('.job-error-banner'),
    bannerStep: card.querySelector('.job-error-step-text'),
    bannerExit: card.querySelector('.job-error-exit-text'),
    evt: null,
    finished: false,
  }
  consoleCards.set(jobId, rec)
  updateClearFinishedButton()
  return rec
}

function appendConsoleLine(rec, text, cls) {
  const line = document.createElement('div')
  if (cls) line.className = 'line-' + cls
  line.textContent = text
  rec.output.appendChild(line)
  rec.output.scrollTop = rec.output.scrollHeight
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

  appendConsoleLine(rec, '=== ' + label + ' (job ' + jobId + ') ===', 'cmd')
  setCardStatus(rec, 'RUNNING', 'running')
  rec.cancelBtn.classList.remove('hidden')

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
        } else if (ok) {
          appendConsoleLine(rec, '=== SUCCESS (exit ' + data.exitCode + ') ===', 'success')
        } else {
          appendConsoleLine(rec, '=== FAILED (exit ' + data.exitCode + ') ===', 'error')
          if (data.failedStep) {
            appendConsoleLine(rec, '!! Failing step: ' + data.failedStep, 'error')
          }
          rec.bannerStep.textContent = data.failedStep || '(unknown — see console)'
          rec.bannerExit.textContent = String(data.exitCode == null ? '?' : data.exitCode)
          rec.banner.classList.remove('hidden')
        }
        evt.close()
        rec.evt = null
        rec.finished = true
        rec.card.classList.add('finished')
        rec.cancelBtn.classList.add('hidden')
        rec.stepEl.textContent = ''
        updateClearFinishedButton()
        loadCustomers()
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
    setCardStatus(rec, 'STREAM ERROR', 'failed')
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
    const stepNote = j.currentStep ? (' — step: ' + j.currentStep) : ''
    const chans = (j.channels && j.channels.length) ? (' [' + j.channels.join(', ') + ']') : ''
    row.innerHTML =
      '<span class="queue-row-status">' + status + '</span>' +
      '<span class="queue-row-label">' + escapeHtml(j.label) + chans + '</span>' +
      '<span class="queue-row-step muted small">' + escapeHtml(stepNote) + '</span>' +
      '<button class="btn-secondary small queue-row-cancel" data-job="' + j.id + '">CANCEL</button>'
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
        streamJob(id, 'BUILD ' + chTag.toUpperCase())
      }
    }
  }
  // Mirror each running job's current step onto its console card header so
  // the operator sees "step: Build customer X v1.2.3" without scrolling
  // through the streaming log to find the latest "$ command…" line.
  for (const j of jobs) {
    const rec = consoleCards.get(j.id)
    if (rec && !rec.finished) {
      rec.stepEl.textContent = j.currentStep ? ('step: ' + j.currentStep) : ''
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
    btn.textContent = 'CANCELLING…'
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
      btn.textContent = 'CANCEL'
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
  $('#customer-modal-title').textContent = isNew ? 'NEW CUSTOMER' : 'EDIT: ' + (c.brandName || c.channel)
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

// ---- Upload pre-built update modal ----
function openUploadModal(channel) {
  $('#up-channel').textContent = channel
  $('#upload-form').dataset.channel = channel
  $('#up-version').value = state.version ? bumpPatch(state.version) : '1.0.1'
  $('#up-launcher').value = ''
  $('#up-server').value = ''
  $('#up-notes').value = ''
  $('#up-error').textContent = ''
  $('#up-busy').classList.add('hidden')
  $('#upload-modal').classList.remove('hidden')
}
function closeUploadModal() {
  $('#upload-modal').classList.add('hidden')
}

async function submitUpload(e) {
  e.preventDefault()
  const channel = $('#upload-form').dataset.channel
  const version = $('#up-version').value.trim()
  if (!/^\d+\.\d+\.\d+/.test(version)) {
    $('#up-error').textContent = 'Version must be x.y.z'
    return
  }
  const launcher = $('#up-launcher').files[0] || null
  const server = $('#up-server').files[0] || null
  if (!launcher && !server) {
    $('#up-error').textContent = 'Pick at least one zip (launcher and/or server payload)'
    return
  }
  const fd = new FormData()
  fd.append('version', version)
  if (launcher) fd.append('launcher', launcher)
  if (server) fd.append('server', server)
  const notes = $('#up-notes').value.trim()
  if (notes) fd.append('notes', notes)

  $('#up-error').textContent = ''
  $('#up-busy').classList.remove('hidden')
  try {
    const r = await api('POST', '/api/admin/customers/' + encodeURIComponent(channel) + '/upload-update', fd, true)
    closeUploadModal()
    // The bulk-upload route doesn't fan out per-customer (it accepts pre-built
    // ZIPs for one channel) so its confirmation goes to the dev console plus
    // the customer-list refresh.
    console.info('[upload-update] ' + channel + ' v' + version + ' shipped — pushed to ' + (r.pushedTo || 0) + ' live install(s)')
    await loadCustomers()
  } catch (e) {
    $('#up-error').textContent = e.message
  } finally {
    $('#up-busy').classList.add('hidden')
  }
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

$('#up-cancel').addEventListener('click', closeUploadModal)
$('#upload-form').addEventListener('submit', submitUpload)
$('#upload-modal').addEventListener('click', (e) => {
  if (e.target === $('#upload-modal')) closeUploadModal()
})

// ---- Top-level bulk UPLOAD UPDATE form ----
async function submitBulkUpload(e) {
  e.preventDefault()
  const target = $('#bup-target').value
  const version = $('#bup-version').value.trim()
  const launcher = $('#bup-launcher').files[0] || null
  const server = $('#bup-server').files[0] || null
  const notes = $('#bup-notes').value.trim()
  $('#bup-error').textContent = ''
  if (!target) { $('#bup-error').textContent = 'choose a target'; return }
  if (!/^\d+\.\d+\.\d+$/.test(version)) { $('#bup-error').textContent = 'version must be x.y.z'; return }
  if (!launcher && !server) { $('#bup-error').textContent = 'pick at least one zip'; return }
  $('#bup-busy').classList.remove('hidden')
  try {
    const fd = new FormData()
    fd.append('target', target)
    fd.append('version', version)
    if (notes) fd.append('notes', notes)
    if (launcher) fd.append('launcher', launcher)
    if (server) fd.append('server', server)
    const res = await fetch('/api/admin/upload-update', { method: 'POST', body: fd, credentials: 'same-origin' })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || ('http ' + res.status))
    streamJob(data.jobId, target === '__all__' ? 'UPLOAD UPDATE -> ALL' : 'UPLOAD UPDATE -> ' + target)
    $('#bulk-upload-form').reset()
    populateBulkUploadTargets()
  } catch (err) {
    $('#bup-error').textContent = err.message
  } finally {
    $('#bup-busy').classList.add('hidden')
  }
}
$('#bulk-upload-form').addEventListener('submit', submitBulkUpload)

init()
