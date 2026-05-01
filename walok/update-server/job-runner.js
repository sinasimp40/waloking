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
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { spawn } = require('child_process')
const { phaseById, weightSoFar, SUBSTEP_TO_PHASE } = require('./phases')

const IS_WIN = process.platform === 'win32'
const MAX_CONCURRENT_BUILDS = Math.max(1, parseInt(process.env.OTA_MAX_BUILDS || '2', 10))

// OTA_BUILD_PRIORITY: 'belowNormal' (default) | 'normal' | 'idle'.
// Lowering child-process scheduling priority is the single biggest win for
// terminal/desktop responsiveness during BUILD ALL on under-spec operator
// machines: two parallel electron-builder runs saturate every core, and at
// 'normal' priority the OS round-robins them with the operator's cmd.exe
// and browser, producing visible input lag. At BELOW_NORMAL the kernel
// preempts builds whenever the foreground asks for CPU. Builds end up
// taking the same wall-clock time on an idle machine (they get all the
// CPU anyway) but stay out of the way when the operator interacts. The
// nice value is inherited by descendants on POSIX and on Windows
// BELOW_NORMAL_PRIORITY_CLASS propagates to spawned children.
const PRIORITY_BUDGET = (() => {
  const want = String(process.env.OTA_BUILD_PRIORITY || 'belowNormal').toLowerCase()
  const c = (os.constants && os.constants.priority) || {}
  if (want === 'normal') return null
  if (want === 'idle') return c.PRIORITY_LOW != null ? c.PRIORITY_LOW : 19
  // default — belowNormal
  return c.PRIORITY_BELOW_NORMAL != null ? c.PRIORITY_BELOW_NORMAL : 10
})()

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
//
// Async (Task #16): the per-entry copyFileTreeSync calls used to run
// back-to-back synchronously, blocking the event loop for hundreds of ms
// per job. With BUILD ALL fanning out N jobs that delay stacked and the
// admin SSE stream visibly stuttered every time a new job started.
// Yielding the event loop between top-level entries (heavy dirs like
// `electron/`, `src/`, `server/`) keeps the loop free for other handlers
// + SSE flushes; total wall-clock cost is unchanged because the copy
// itself is unavoidable I/O.
async function createJobWorkspace(jobId, projectRoot) {
  const wsRoot = path.join(projectRoot, '.build-jobs', jobId)
  fs.mkdirSync(wsRoot, { recursive: true })
  for (const ent of fs.readdirSync(projectRoot)) {
    if (shouldSkipForWorkspace(ent)) continue
    const src = path.join(projectRoot, ent)
    const dest = path.join(wsRoot, ent)
    copyFileTreeSync(src, dest)
    // Yield to the event loop between top-level entries so other handlers
    // (SSE flushes, queue snapshots, even a concurrent build's runner
    // that just opened a slot) can interleave with this clone.
    await new Promise(r => setImmediate(r))
  }
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
    currentPhase: null,                  // Task #17: latest phase id emitted
                                         // by jobEmitPhase. Used both as an
                                         // idempotency guard (don't re-emit
                                         // the same phase twice) and so the
                                         // admin UI can rehydrate position
                                         // from a /api/admin/jobs snapshot.
    output: [],                          // {t, line} or {t, end, exitCode, failedStep}
    listeners: new Set(),                // SSE response.write functions for this job
    workspace: null,
    distDirs: [],                        // per-job output paths to clean after the job ends
    activeChild: null,                   // current spawned child (so cancel can kill it)
    cancelRequested: false,
    runner: null,                        // the run() closure to invoke when a slot opens
    onCancel: null,                      // optional callback fired AFTER finishJob runs
                                         // when status === 'cancelled'. Used by the
                                         // server to remove half-published payloads
                                         // for that job's channel + version.
    onCancelFired: false,                // idempotency guard so we never double-fire
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

// Emit a STRUCTURED phase event onto the per-job SSE stream (Task #17). The
// admin progress bar reads these to advance without parsing log lines. The
// event is also pushed into job.output so a page refresh mid-build replays
// the phase history and the bar lands on the right position.
//
// Idempotent per phase id: re-emitting the same phase (e.g. STEP_TO_PHASE +
// SUBSTEP_TO_PHASE both mapping to 'rebrand') is a no-op so the bar never
// jumps backwards.
function jobEmitPhase(job, phaseId) {
  const p = phaseById(phaseId)
  if (!p) return
  if (job.currentPhase === phaseId) return
  job.currentPhase = phaseId
  const entry = {
    t: nowMs(),
    phase: p.id,
    label: p.label,
    weight: p.weight,
    weightSoFar: weightSoFar(p.id),
    startedAt: nowMs(),
  }
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
  if ((m = SUBSTEP_BEGIN_RE.exec(line))) {
    job.currentSubstep = m[1]
    // Task #17: substep boundary doubles as a progress-bar phase boundary.
    // Lookup is intentionally lenient — an unknown substep name leaves the
    // bar at its current phase position rather than throwing or freezing.
    const phaseId = SUBSTEP_TO_PHASE[m[1]]
    if (phaseId) jobEmitPhase(job, phaseId)
    return
  }
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

// Fire job.onCancel exactly once. Called from BOTH:
//   * cancelJob, queued-cancel branch (no runner ever fired)
//   * finishJob, when status ends up as 'cancelled' (runner ran + got killed)
// Wrapped in try/catch — onCancel is operator-supplied and we never want a
// cleanup miss to leak an exception into the runner.
function fireOnCancelOnce(job) {
  if (!job || job.onCancelFired) return
  if (typeof job.onCancel !== 'function') {
    job.onCancelFired = true
    return
  }
  job.onCancelFired = true
  try { job.onCancel(job) } catch (e) {
    try { jobAppend(job, '[onCancel] WARN: ' + e.message) } catch (_) {}
  }
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
  // Fire onCancel BEFORE emitJobEnd so any [cancel-cleanup] log lines the
  // hook emits via jobAppend reach the live SSE listener (mirrors the
  // onComplete-before-finishJob ordering rule for the same reason).
  if (job.status === 'cancelled') fireOnCancelOnce(job)
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
// Env keys that we never expose to subprocesses with `minimalEnv: true` even
// if they slipped past the allowlist. These are admin/server secrets that
// MUST NOT leak into uploaded source's lifecycle scripts (npm install hooks
// can read process.env). The deny-list catches both our own OTA_ADMIN_*
// names and well-known third-party patterns.
const SECRET_ENV_PATTERNS = [/PASSWORD/i, /SECRET/i, /TOKEN/i, /API[_-]?KEY/i, /^OTA_ADMIN/i, /^REPLIT_DB/i]

// Allowlist of env vars that must always be present for npm/electron-builder
// to function on Windows or POSIX. Adding more here only widens what
// minimal-env subprocesses see; it never widens what trusted-build commands
// see (those use the default full-env path below).
const MINIMAL_ENV_ALLOW = [
  'PATH', 'Path', 'PATHEXT',
  'HOME', 'USERPROFILE', 'USER', 'USERNAME', 'LOGNAME',
  'TEMP', 'TMP', 'TMPDIR',
  'SystemRoot', 'SystemDrive', 'COMSPEC',
  'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData',
  'APPDATA', 'LOCALAPPDATA', 'ALLUSERSPROFILE',
  'NODE_ENV', 'NODE_PATH', 'npm_config_cache', 'npm_config_prefix',
  'LANG', 'LC_ALL', 'LC_CTYPE',
  'SHELL',
]

function buildMinimalEnv(extra) {
  const out = {}
  for (const k of MINIMAL_ENV_ALLOW) {
    if (process.env[k] != null) out[k] = process.env[k]
  }
  // Extra keys from the caller (e.g. BUILD_VERSION) override allowlisted
  // values — but we still scrub anything in the deny-list as a safety net.
  for (const [k, v] of Object.entries(extra || {})) {
    if (SECRET_ENV_PATTERNS.some(rx => rx.test(k))) continue
    out[k] = v
  }
  return out
}

function runStep(job, cmd, args, opts) {
  const cwd = opts.cwd || job.workspace
  const useShell = opts.shell === true
  jobAppend(job, '$ ' + cmd + ' ' + args.join(' '))
  // Source-build callers pass `minimalEnv: true` so the uploaded npm scripts
  // can never read OTA_ADMIN_PASSWORD / DB URLs / API keys via process.env.
  // Existing trusted build steps (build-customer.js, publish-update.js) keep
  // the default full-env path so we don't surprise their assumptions.
  const env = opts.minimalEnv
    ? { ...buildMinimalEnv(opts.env || {}), FORCE_COLOR: '0' }
    : { ...process.env, FORCE_COLOR: '0', ...(opts.env || {}) }
  let child
  try {
    child = spawn(cmd, args, {
      cwd,
      shell: useShell,
      env,
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
  // Lower scheduling priority of the spawned child so the operator's
  // foreground work (cmd.exe, browser, admin panel) preempts it. See
  // PRIORITY_BUDGET above for the full rationale. Best-effort: failures
  // here are non-fatal (no admin permission, OS without setpriority,
  // etc.) and we never want a priority issue to abort a build.
  if (PRIORITY_BUDGET != null && child.pid) {
    try { os.setPriority(child.pid, PRIORITY_BUDGET) } catch (_) { /* best-effort */ }
  }
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

function enqueueBuildJob({ label, channels, projectRoot, steps, onComplete, onCancel }) {
  const job = newJob({ label, channels, kind: 'build' })
  if (typeof onCancel === 'function') job.onCancel = onCancel

  // The runner closure: capture the workspace + steps and execute them in
  // sequence. Stops on first non-zero exit. Always calls finishJob and
  // (if provided) onComplete.
  job.runner = async () => {
    // Allocate workspace lazily (just-in-time) so a queued job that gets
    // cancelled before it runs never touches the disk.
    try {
      // Task #17: emit the very first phase BEFORE the workspace clone so
      // the admin progress bar advances off 0% the instant the job starts
      // running, instead of sitting empty for the few seconds the clone
      // takes on a fresh tree.
      jobEmitPhase(job, 'workspace')
      jobAppend(job, '== Preparing isolated build workspace…')
      job.workspace = await createJobWorkspace(job.id, projectRoot)
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
        // Task #17: a step may declare a `phase` id. The build-customer step
        // doesn't (its phases are emitted by the SUBSTEP_BEGIN log lines from
        // build-customer.js itself), but the publish step does — that one is
        // a single child process with no substeps, so the only place to mark
        // it on the bar is at step entry.
        if (step.phase) jobEmitPhase(job, step.phase)
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
    // ORDER MATTERS: onComplete BEFORE finishJob. finishJob emits {end:true}
    // and clears listeners, so any jobAppend inside onComplete must run
    // first — otherwise its lines never reach the live SSE stream and (in
    // the original bug) used to crash the process via a write-after-end
    // 'error' event on the just-ended ServerResponse.
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
    // Fire onCancel even on queued-cancel: the hook is a no-op for jobs
    // that never published anything (cleanupCancelledJob skips a missing
    // version dir silently), but if the operator pre-staged something
    // out-of-band against the same channel/version, this still sweeps it.
    fireOnCancelOnce(job)
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
    // Task #17: snapshot fields used by the admin UI to rehydrate the
    // progress bar IMMEDIATELY on a mid-build page refresh — before the SSE
    // replay catches up and even when the phase event has fallen out of the
    // 5000-entry output ring buffer for a very chatty build. The four
    // `currentPhase*` fields are a complete description of "where the bar
    // should sit right now" without needing the PHASES table client-side.
    currentPhase: j.currentPhase,
    currentPhaseLabel: j.currentPhase ? (phaseById(j.currentPhase)?.label || null) : null,
    currentPhaseWeight: j.currentPhase ? (phaseById(j.currentPhase)?.weight || 0) : 0,
    currentPhaseWeightSoFar: j.currentPhase ? weightSoFar(j.currentPhase) : 0,
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
  jobEmitPhase,
  // Exposed so source-build.js can spawn its own steps (npm install, rebrand,
  // electron-builder against uploaded source) with proper job.activeChild
  // wiring (cancel kills the tree), live log capture, and minimalEnv:true
  // (no admin password / API keys leak into uploaded npm scripts).
  runStep,
  // exported for unit tests + scripts/build-customer.js EPERM fix
  rmrfWithRetry,
  createJobWorkspace,
  disposeJobWorkspace,
  _testTriggerDrain,
}
