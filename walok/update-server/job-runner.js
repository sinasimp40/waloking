// Build-job runner: queue, parallelism, real cancel, per-job isolated workspace.
//
// Why this exists: the previous BUILD_LOCKS approach allowed only one build at
// a time AND its CANCEL endpoint was a stub (didn't actually kill anything).
// The operator also hit EPERM on `dist-electron` because Windows Explorer / AV
// hold transient handles on that folder after a build, blocking the next
// build's wipe. This runner fixes all three:
//
//   * Up to MAX_CONCURRENT_BUILDS (default 2) jobs run at the same time.
//   * Each job runs in its own isolated workspace (a per-job copy of the
//     source tree under .build-jobs/<jobId>/) so two parallel builds can
//     rebrand + vite + electron-builder without touching each other's files.
//   * node_modules is shared via a junction/symlink for speed (read-only at
//     build time anyway), so the per-job copy is small (single-digit MB) and
//     fast (<1s on a typical machine).
//   * The CANCEL endpoint kills the spawned child process tree (Windows:
//     `taskkill /T /F`, POSIX: process-group SIGKILL) and removes
//     queued-but-not-started jobs from the queue with no spawn at all.
//   * Channel-conflict avoidance: a job whose channels overlap with any
//     RUNNING job's channels stays queued until the conflict clears, so two
//     parallel builds never publish the same channel concurrently.
//   * Per-job dist directories (dist-electron-<jobId>/ inside the workspace)
//     mean leftover handles on the canonical dist-electron/ never block the
//     next build.

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { spawn } = require('child_process')

const IS_WIN = process.platform === 'win32'
const MAX_CONCURRENT_BUILDS = Math.max(1, parseInt(process.env.OTA_MAX_BUILDS || '2', 10))

// ============ utilities ============

function nowMs() { return Date.now() }

// Recursive remove that retries on EPERM/EBUSY (Windows AV / Explorer holds
// transient handles on freshly-built dist dirs). Best-effort: returns true on
// success, false if it ultimately couldn't remove. NEVER throws.
async function rmrfWithRetry(p, { attempts = 6, baseDelayMs = 200 } = {}) {
  if (!fs.existsSync(p)) return true
  let lastErr = null
  for (let i = 0; i < attempts; i++) {
    try {
      fs.rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
      if (!fs.existsSync(p)) return true
    } catch (e) {
      lastErr = e
    }
    // Exponential backoff: 200, 400, 800, 1600, 3200, 6400 ms
    const delay = baseDelayMs * Math.pow(2, i)
    await new Promise(r => setTimeout(r, delay))
  }
  // Final check — might have succeeded on the last attempt's retry sweep
  return !fs.existsSync(p)
}

// Hardlink-or-copy clone of the source tree into the per-job workspace.
// Hardlinks would be faster but rebrand.js MUTATES files in-place, so we
// must use real copies for files (otherwise rebrand would corrupt the main
// project). For directories that won't change (node_modules) we use a
// junction/symlink instead of a copy to save time and disk space.
//
// SKIP set: anything that is rebuilt per-job (dist, dist-electron*) or is
// runtime state we don't need (.build-jobs, .git, node_modules — handled
// separately).
const WORKSPACE_SKIP_NAMES = new Set([
  'node_modules', 'dist', '.build-jobs', '.git', '.svn', '.hg',
  'releases', 'attached_assets', '.local', '.config', '.cache',
])
function shouldSkipForWorkspace(name) {
  if (WORKSPACE_SKIP_NAMES.has(name)) return true
  if (name.startsWith('dist-electron')) return true
  return false
}

function copyFileTreeSync(src, dest) {
  const stat = fs.lstatSync(src)
  if (stat.isSymbolicLink()) {
    // Preserve symlinks as symlinks
    const target = fs.readlinkSync(src)
    try { fs.symlinkSync(target, dest) } catch (e) { /* best effort */ }
    return
  }
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true })
    for (const ent of fs.readdirSync(src)) {
      if (shouldSkipForWorkspace(ent)) continue
      copyFileTreeSync(path.join(src, ent), path.join(dest, ent))
    }
    return
  }
  if (stat.isFile()) {
    fs.copyFileSync(src, dest)
  }
}

function symlinkDir(src, dest) {
  if (!fs.existsSync(src)) return
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  if (fs.existsSync(dest)) {
    try { fs.rmSync(dest, { recursive: true, force: true }) } catch (e) {}
  }
  // 'junction' is the right kind on Windows (no admin required, points
  // at a directory). On POSIX it's silently treated as a regular symlink.
  try {
    fs.symlinkSync(src, dest, IS_WIN ? 'junction' : 'dir')
  } catch (e) {
    // Symlink failed (rare, e.g. cross-device). Fall back to a recursive
    // copy — slower but functionally equivalent for read-only use.
    copyFileTreeSync(src, dest)
  }
}

// Create a per-job workspace at <projectRoot>/.build-jobs/<jobId>/.
// The workspace is a self-contained copy of the source tree with shared
// node_modules junctions. Returns the absolute path to the workspace root.
function createJobWorkspace(jobId, projectRoot) {
  const wsRoot = path.join(projectRoot, '.build-jobs', jobId)
  fs.mkdirSync(wsRoot, { recursive: true })
  // Copy top-level source dirs and files (skipping the heavy/regenerated ones).
  for (const ent of fs.readdirSync(projectRoot)) {
    if (shouldSkipForWorkspace(ent)) continue
    const src = path.join(projectRoot, ent)
    const dest = path.join(wsRoot, ent)
    copyFileTreeSync(src, dest)
  }
  // Junction node_modules so the workspace can resolve modules without
  // duplicating ~600MB on disk per job.
  symlinkDir(path.join(projectRoot, 'node_modules'), path.join(wsRoot, 'node_modules'))
  symlinkDir(path.join(projectRoot, 'server', 'node_modules'), path.join(wsRoot, 'server', 'node_modules'))
  return wsRoot
}

async function disposeJobWorkspace(jobId, projectRoot) {
  const wsRoot = path.join(projectRoot, '.build-jobs', jobId)
  await rmrfWithRetry(wsRoot, { attempts: 6 })
}

// ============ job + queue state ============

const JOBS = new Map()                   // jobId -> Job
const QUEUE = []                         // jobIds in FIFO order, awaiting a slot
const ACTIVE = new Set()                 // jobIds currently running

// onSlotChange callback fires when ACTIVE/QUEUE change so the SSE-broadcast
// of /api/admin/jobs can push a fresh snapshot to the admin UI.
let onSlotChange = () => {}
function setOnSlotChange(fn) { onSlotChange = typeof fn === 'function' ? fn : (() => {}) }

function newJob({ label, channels = [], kind = 'build' }) {
  const id = crypto.randomBytes(8).toString('hex')
  const job = {
    id,
    label,
    kind,
    channels: Array.from(new Set(channels)),
    status: 'queued',                    // queued | running | cancelling | cancelled | success | failed
    queuedAt: nowMs(),
    startedAt: null,
    endedAt: null,
    exitCode: null,
    failedStep: null,
    currentStep: null,
    currentSubstep: null,
    output: [],                          // {t, line} or {t, end, exitCode, failedStep}
    listeners: new Set(),                // SSE response.write functions for this job
    workspace: null,
    distDirs: [],                        // per-job output paths to clean after the job ends
    activeChild: null,                   // current spawned child (so cancel can kill it)
    cancelRequested: false,
    runner: null,                        // the run() closure to invoke when a slot opens
  }
  JOBS.set(id, job)
  // Auto-evict completed jobs after 1 hour to avoid unbounded memory growth.
  setTimeout(() => {
    if (JOBS.get(id) === job && job.status !== 'queued' && job.status !== 'running' && job.status !== 'cancelling') {
      JOBS.delete(id)
    }
  }, 1000 * 60 * 60 + 5000)
  return job
}

function jobAppend(job, line) {
  const entry = { t: nowMs(), line }
  job.output.push(entry)
  if (job.output.length > 5000) job.output.splice(0, job.output.length - 5000)
  for (const send of job.listeners) {
    try { send(entry) } catch (_) {}
  }
}

function emitJobEnd(job) {
  const payload = { t: nowMs(), end: true, exitCode: job.exitCode, failedStep: job.failedStep, status: job.status }
  for (const send of job.listeners) {
    try { send(payload) } catch (_) {}
  }
  // Belt-and-braces: drop all listeners now that the stream has signalled its
  // end. Any future jobAppend (e.g. from a still-running onComplete callback,
  // late cleanup write, or future code path) becomes a no-op for listeners,
  // which means it can never trigger res.write-after-end on a closed SSE
  // response. Output is still appended to job.output for the replay buffer.
  job.listeners.clear()
}

// Sub-step parsing (printed by build-customer.js as [SUBSTEP_BEGIN] etc.)
const SUBSTEP_BEGIN_RE = /\[SUBSTEP_BEGIN\]\s*(.+?)\s*$/
const SUBSTEP_END_OK_RE = /\[SUBSTEP_END_OK\]\s*(.+?)\s*$/
const SUBSTEP_END_FAIL_RE = /\[SUBSTEP_END_FAIL\]\s*(.+?)\s*$/
function processLineForSubsteps(job, line) {
  let m
  if ((m = SUBSTEP_BEGIN_RE.exec(line))) { job.currentSubstep = m[1]; return }
  if ((m = SUBSTEP_END_OK_RE.exec(line))) { if (job.currentSubstep === m[1]) job.currentSubstep = null; return }
  if ((m = SUBSTEP_END_FAIL_RE.exec(line))) { job.currentSubstep = m[1]; return }
}

// Channel conflict check: a queued job can only start if its channels do NOT
// overlap with any currently-running job's channels. Build-all jobs (channels
// = []) conflict with everything. This guarantees we never publish the same
// channel from two parallel builds.
function jobHasConflict(job) {
  if (job.channels.length === 0) {
    // build-all conflicts with any running job
    return ACTIVE.size > 0
  }
  for (const aid of ACTIVE) {
    const a = JOBS.get(aid)
    if (!a) continue
    if (a.channels.length === 0) return true              // a build-all is mid-flight
    for (const ch of job.channels) {
      if (a.channels.includes(ch)) return true
    }
  }
  return false
}

// Drain: walk the queue and start jobs that fit (slot available + no channel
// conflict). Stops when no more jobs can start in this pass. Called whenever
// the queue or ACTIVE set changes.
function drainQueue() {
  let started = false
  for (let i = 0; i < QUEUE.length; ) {
    if (ACTIVE.size >= MAX_CONCURRENT_BUILDS) break
    const jobId = QUEUE[i]
    const job = JOBS.get(jobId)
    if (!job || job.cancelRequested) {
      QUEUE.splice(i, 1)
      continue
    }
    if (jobHasConflict(job)) {
      // skip this one, try the next; its turn will come when the conflicting
      // active job finishes.
      i++
      continue
    }
    QUEUE.splice(i, 1)
    ACTIVE.add(job.id)
    job.status = 'running'
    job.startedAt = nowMs()
    started = true
    Promise.resolve().then(() => {
      try { job.runner() } catch (e) {
        jobAppend(job, 'RUNNER ERROR: ' + e.message)
        finishJob(job, -1)
      }
    })
  }
  if (started || true) onSlotChange()
}

function finishJob(job, exitCode) {
  job.exitCode = exitCode
  job.endedAt = nowMs()
  if (job.cancelRequested) {
    job.status = 'cancelled'
  } else if (exitCode === 0) {
    job.status = 'success'
    jobAppend(job, '')
    jobAppend(job, '== JOB COMPLETE ==')
  } else {
    job.status = 'failed'
    jobAppend(job, '')
    jobAppend(job, '!! JOB FAILED at step: ' + (job.failedStep || job.currentStep || '?') + ' (exit ' + exitCode + ')')
  }
  emitJobEnd(job)
  ACTIVE.delete(job.id)

  // Best-effort dispose of the per-job workspace + dist dirs. Failures here
  // are non-fatal (the next admin restart will hit them anyway).
  ;(async () => {
    for (const d of job.distDirs) {
      const ok = await rmrfWithRetry(d, { attempts: 4 })
      if (!ok) jobAppend(job, '[cleanup] WARN: could not remove ' + d + ' (likely held by AV/Explorer; safe to ignore)')
    }
    if (job.workspace) {
      const ok = await rmrfWithRetry(job.workspace, { attempts: 4 })
      if (!ok) jobAppend(job, '[cleanup] WARN: could not remove workspace ' + job.workspace)
    }
    drainQueue()
  })()
}

// ============ child-process supervision ============

// Spawn a step inside the job's workspace. Uses detached:true on POSIX so we
// can kill the entire process group (process.kill(-pid)). On Windows we use
// taskkill /T /F /PID instead, which walks the child's tree.
function runStep(job, cmd, args, opts) {
  const cwd = opts.cwd || job.workspace
  const useShell = opts.shell === true
  jobAppend(job, '$ ' + cmd + ' ' + args.join(' '))
  let child
  try {
    child = spawn(cmd, args, {
      cwd,
      shell: useShell,
      env: { ...process.env, FORCE_COLOR: '0', ...(opts.env || {}) },
      // POSIX: new process group so we can kill the whole subtree at once.
      // Windows: detached has no kill-tree benefit; we use taskkill instead.
      detached: !IS_WIN,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (e) {
    jobAppend(job, 'SPAWN ERROR: ' + e.message)
    return Promise.resolve(-1)
  }
  job.activeChild = child
  return new Promise((resolve) => {
    let settled = false
    const handleData = d => d.toString().split(/\r?\n/).forEach(l => {
      if (!l) return
      processLineForSubsteps(job, l)
      jobAppend(job, l)
    })
    child.stdout.on('data', handleData)
    child.stderr.on('data', handleData)
    child.on('error', e => {
      if (settled) return
      settled = true
      jobAppend(job, 'ERROR: ' + e.message)
      job.activeChild = null
      resolve(-1)
    })
    child.on('exit', (code, signal) => {
      if (settled) return
      settled = true
      jobAppend(job, '[exit ' + code + (signal ? ' signal=' + signal : '') + ']')
      job.activeChild = null
      // signal-killed (SIGKILL/SIGTERM) → expose as -1 so the chain stops
      resolve(code == null ? -1 : code)
    })
  })
}

// Kill a child process tree synchronously-ish. Returns immediately; the
// child's 'exit' handler will fire when it's actually gone (usually within
// a few hundred ms on Windows, instantly on POSIX SIGKILL).
function killChildTree(child) {
  if (!child || child.killed || child.exitCode != null) return
  if (IS_WIN) {
    try {
      // /T = include child processes, /F = force. spawn() to avoid blocking.
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
        .on('error', () => {})
    } catch (_) {}
    // Belt and braces — also send SIGKILL via Node's kill() in case taskkill
    // isn't on PATH (rare, but possible on stripped-down Windows containers).
    try { child.kill('SIGKILL') } catch (_) {}
  } else {
    // Negative pid = the process GROUP. Detached child became its own group
    // leader, so this kills it AND all of its descendants in one syscall.
    try { process.kill(-child.pid, 'SIGKILL') } catch (_) {}
    try { child.kill('SIGKILL') } catch (_) {}
  }
}

// ============ public API ============

function enqueueBuildJob({ label, channels, projectRoot, steps, onComplete }) {
  const job = newJob({ label, channels, kind: 'build' })

  // The runner closure: capture the workspace + steps and execute them in
  // sequence. Stops on first non-zero exit. Always calls finishJob and
  // (if provided) onComplete.
  job.runner = async () => {
    // Allocate workspace lazily (just-in-time) so a queued job that gets
    // cancelled before it runs never touches the disk.
    try {
      jobAppend(job, '== Preparing isolated build workspace…')
      job.workspace = createJobWorkspace(job.id, projectRoot)
      jobAppend(job, '   workspace: ' + path.relative(projectRoot, job.workspace))
    } catch (e) {
      jobAppend(job, 'WORKSPACE ERROR: ' + e.message)
      job.failedStep = 'create workspace'
      // onComplete first, then finishJob — see comment in the success path.
      if (onComplete) try { onComplete(-1, job) } catch (_) {}
      finishJob(job, -1)
      return
    }
    // Per-job dist output dirs INSIDE the workspace. These are passed to
    // build-customer.js via env vars and to electron-builder via -c overrides.
    const launcherDist = path.join(job.workspace, 'dist-electron-' + job.id)
    const serverDist = path.join(job.workspace, 'server', 'dist-electron-' + job.id)
    job.distDirs = [launcherDist, serverDist]

    let exitCode = 0
    try {
      for (const step of steps) {
        if (job.cancelRequested) { exitCode = -1; break }
        if (step.skipIf && step.skipIf(job)) {
          jobAppend(job, '')
          jobAppend(job, '== SKIP: ' + step.label + ' (already satisfied)')
          continue
        }
        jobAppend(job, '')
        jobAppend(job, '=== ' + step.label + ' ===')
        job.currentStep = step.label
        job.currentSubstep = null
        const stepEnv = {
          ...(step.env || {}),
          BUILD_OUTPUT_DIR: launcherDist,
          BUILD_SERVER_OUTPUT_DIR: serverDist,
          // Tell collect-artifacts where to find the dists if it's running
          // outside build-customer.js (e.g. publish-update.js).
          BUILD_PROJECT_ROOT: job.workspace,
        }
        // step.cwd is RELATIVE to the workspace root unless it's absolute.
        const stepCwd = step.cwd
          ? (path.isAbsolute(step.cwd) ? step.cwd : path.join(job.workspace, step.cwd))
          : job.workspace
        const code = await runStep(job, step.cmd, step.args, {
          cwd: stepCwd,
          shell: step.shell,
          env: stepEnv,
        })
        if (code !== 0) {
          job.failedStep = job.currentSubstep
            ? step.label + ' > ' + job.currentSubstep
            : step.label
          exitCode = code
          break
        }
      }
    } catch (e) {
      jobAppend(job, 'CHAIN ERROR: ' + e.message)
      exitCode = -1
    }
    // Run onComplete BEFORE finishJob so any jobAppend() it does (cleanup
    // summary, db record, [live-push] line) reaches the live SSE stream
    // instead of being silently swallowed by the just-closed response.
    // finishJob() emits the {end:true} event and clears all listeners, so
    // doing this in the wrong order both (a) drops these lines from the live
    // build console and (b) used to crash the process via an unhandled
    // 'error' event on the now-ended ServerResponse.
    if (onComplete) try { onComplete(exitCode, job) } catch (_) {}
    finishJob(job, exitCode)
  }

  QUEUE.push(job.id)
  drainQueue()
  return job
}

// Same queue/cancel semantics as enqueueBuildJob, but runs inline async work
// instead of spawning child processes. Used by /api/admin/upload-update,
// which has its payload buffers already in memory and doesn't need a
// workspace clone. The work function receives the job object so it can call
// jobAppend(job, '...') for live console output.
function enqueueInlineJob({ label, channels = [], work }) {
  const job = newJob({ label, channels, kind: 'inline' })
  job.runner = async () => {
    let exitCode = 0
    try {
      await work(job)
    } catch (e) {
      jobAppend(job, 'INLINE JOB ERROR: ' + e.message)
      job.failedStep = job.currentStep || 'inline work'
      exitCode = -1
    }
    finishJob(job, exitCode)
  }
  QUEUE.push(job.id)
  drainQueue()
  return job
}

function cancelJob(jobId) {
  const job = JOBS.get(jobId)
  if (!job) return { ok: false, error: 'job not found' }
  if (job.status === 'success' || job.status === 'failed' || job.status === 'cancelled') {
    return { ok: true, status: job.status, note: 'already finished' }
  }
  job.cancelRequested = true
  if (job.status === 'queued') {
    // Just remove from queue — never spawned anything.
    const idx = QUEUE.indexOf(jobId)
    if (idx >= 0) QUEUE.splice(idx, 1)
    job.status = 'cancelled'
    job.endedAt = nowMs()
    jobAppend(job, '== CANCELLED (was queued, never started) ==')
    emitJobEnd(job)
    drainQueue()
    return { ok: true, status: 'cancelled' }
  }
  if (job.status === 'running' || job.status === 'cancelling') {
    job.status = 'cancelling'
    jobAppend(job, '== CANCEL requested — killing child process tree… ==')
    killChildTree(job.activeChild)
    return { ok: true, status: 'cancelling' }
  }
  return { ok: false, status: job.status }
}

function getJob(jobId) { return JOBS.get(jobId) }

function listJobs() {
  // Newest-first; cap to recent + active so the admin UI stays snappy.
  const all = Array.from(JOBS.values())
  all.sort((a, b) => (b.startedAt || b.queuedAt) - (a.startedAt || a.queuedAt))
  return all.slice(0, 50).map(j => ({
    id: j.id,
    label: j.label,
    kind: j.kind,
    channels: j.channels,
    status: j.status,
    queuedAt: j.queuedAt,
    startedAt: j.startedAt,
    endedAt: j.endedAt,
    exitCode: j.exitCode,
    failedStep: j.failedStep,
    currentStep: j.currentStep,
    currentSubstep: j.currentSubstep,
    queuePosition: j.status === 'queued' ? (QUEUE.indexOf(j.id) + 1) : null,
  }))
}

function getQueueState() {
  return {
    maxConcurrent: MAX_CONCURRENT_BUILDS,
    active: Array.from(ACTIVE),
    queued: QUEUE.slice(),
  }
}

function attachListener(jobId, send) {
  const job = JOBS.get(jobId)
  if (!job) return null
  job.listeners.add(send)
  return () => { job.listeners.delete(send) }
}

// Test/utility hook so the test runner can trigger a fresh drain.
function _testTriggerDrain() { drainQueue() }

module.exports = {
  MAX_CONCURRENT_BUILDS,
  enqueueBuildJob,
  enqueueInlineJob,
  cancelJob,
  getJob,
  listJobs,
  getQueueState,
  attachListener,
  setOnSlotChange,
  jobAppend,
  // exported for unit tests + scripts/build-customer.js EPERM fix
  rmrfWithRetry,
  createJobWorkspace,
  disposeJobWorkspace,
  _testTriggerDrain,
}
