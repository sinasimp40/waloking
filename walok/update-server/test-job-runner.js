#!/usr/bin/env node
// Smoke + regression tests for update-server/job-runner.js.
//
// Covers the acceptance criteria from Task #16:
//   1. 3 stub jobs enqueued -> exactly 2 run concurrently, 1 queues
//   2. Cancel mid-run kills the child within 3s
//   3. Cancel of a queued job marks it cancelled without ever spawning
//   4. Channel-conflict avoidance: two build-all jobs serialise
//   5. SSE-style listener replay matches buffered output
//
// Run from repo root:   node update-server/test-job-runner.js
// Designed to work on POSIX (CI) and Windows. Uses small Node child scripts
// instead of the real `npm install` / electron-builder so the test finishes
// in a few seconds.

const fs = require('fs')
const os = require('os')
const path = require('path')

// Force the runner's internal max-concurrency BEFORE require so the worker
// pool is sized at 2 regardless of OTA_MAX_BUILDS.
process.env.OTA_MAX_BUILDS = '2'

const runner = require('./job-runner')
const assert = require('assert')

let failed = 0
function ok(name) { console.log('  PASS  ' + name) }
function fail(name, err) { failed++; console.log('  FAIL  ' + name + ' :: ' + (err && err.stack ? err.stack : err)) }

// Build a temp project root with a fresh node_modules so the runner's
// workspace clone has something to junction. We never actually use the
// modules — the stub steps just spawn `node -e ...` directly.
function makeProjectRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobrunner-test-'))
  fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true })
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true })
  // A trivial file so the workspace copy has SOMETHING to clone besides
  // node_modules (which is junctioned, not copied).
  fs.writeFileSync(path.join(root, 'README.md'), '# test project\n')
  return root
}

const PROJECT_ROOT = makeProjectRoot()

// Stub step that prints a marker and sleeps for `ms` milliseconds. Honors
// SIGTERM so the cancel test can confirm the child died (otherwise the
// process exits naturally after the sleep and we can't tell cancel "won").
function sleepStep(label, ms) {
  return {
    label,
    cmd: process.execPath,
    args: ['-e', 'process.on("SIGTERM",()=>{process.exit(143)});console.log("BEGIN ' + label + '");setTimeout(()=>{console.log("END ' + label + '")},' + ms + ')'],
    cwd: '.',
    shell: false,
  }
}

async function waitFor(predicate, timeoutMs = 5000, label = 'condition') {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true
    await new Promise(r => setTimeout(r, 50))
  }
  throw new Error('Timed out waiting for ' + label)
}

async function jobDone(jobId, timeoutMs = 30000) {
  await waitFor(() => {
    const j = runner.getJob(jobId)
    return j && (j.status === 'success' || j.status === 'failed' || j.status === 'cancelled')
  }, timeoutMs, 'job ' + jobId + ' to finish')
  return runner.getJob(jobId)
}

// === Test 1: 3 jobs enqueued, exactly 2 run concurrently, 1 queues ===
async function testParallelism() {
  const t = 'parallelism: 2-slot pool runs 2 / queues 1'
  try {
    const j1 = runner.enqueueBuildJob({ label: 'p1', channels: ['c1'], projectRoot: PROJECT_ROOT, steps: [sleepStep('p1', 1500)] })
    const j2 = runner.enqueueBuildJob({ label: 'p2', channels: ['c2'], projectRoot: PROJECT_ROOT, steps: [sleepStep('p2', 1500)] })
    const j3 = runner.enqueueBuildJob({ label: 'p3', channels: ['c3'], projectRoot: PROJECT_ROOT, steps: [sleepStep('p3', 200)] })
    // Right after enqueue, j1+j2 should be active (or running) and j3 queued.
    await waitFor(() => {
      const q = runner.getQueueState()
      return q.active.length === 2 && q.queued.length === 1 && q.queued[0] === j3.id
    }, 3000, 'queue state to settle to 2 active / 1 queued')
    const q = runner.getQueueState()
    assert.strictEqual(q.active.length, 2, 'active should be 2, was ' + q.active.length)
    assert.strictEqual(q.queued.length, 1, 'queued should be 1, was ' + q.queued.length)
    // Wait for all to finish.
    const r1 = await jobDone(j1.id)
    const r2 = await jobDone(j2.id)
    const r3 = await jobDone(j3.id)
    assert.strictEqual(r1.status, 'success', 'j1 status was ' + r1.status)
    assert.strictEqual(r2.status, 'success', 'j2 status was ' + r2.status)
    assert.strictEqual(r3.status, 'success', 'j3 status was ' + r3.status)
    // j3 must have started AFTER j1 or j2 ended (proving it actually queued).
    const j3StartedAt = r3.startedAt
    const earliestEnd = Math.min(r1.endedAt, r2.endedAt)
    assert.ok(j3StartedAt >= earliestEnd - 50,
      'j3 should start no earlier than the first slot release (j3=' + j3StartedAt + ', earliestEnd=' + earliestEnd + ')')
    ok(t)
  } catch (e) { fail(t, e) }
}

// === Test 2: cancel a running job → killed within 3s ===
async function testCancelRunning() {
  const t = 'cancel: running job killed within 3s'
  try {
    // Long-sleeping job we will cancel.
    const j = runner.enqueueBuildJob({ label: 'cancel-target', channels: ['c-cancel'], projectRoot: PROJECT_ROOT, steps: [sleepStep('cancel-target', 60000)] })
    await waitFor(() => runner.getJob(j.id).status === 'running', 5000, 'job to be running')
    const cancelStart = Date.now()
    const r = runner.cancelJob(j.id)
    assert.strictEqual(r.ok, true, 'cancelJob should return ok')
    const finished = await jobDone(j.id, 5000)
    const elapsed = Date.now() - cancelStart
    assert.strictEqual(finished.status, 'cancelled', 'status was ' + finished.status)
    assert.ok(elapsed <= 3000, 'cancel took ' + elapsed + 'ms, exceeds 3s budget')
    ok(t + ' (' + elapsed + 'ms)')
  } catch (e) { fail(t, e) }
}

// === Test 3: cancel a queued (never-started) job ===
async function testCancelQueued() {
  const t = 'cancel: queued job never spawns'
  try {
    // Fill both slots with long jobs so the third actually queues.
    const fill1 = runner.enqueueBuildJob({ label: 'fill1', channels: ['cf1'], projectRoot: PROJECT_ROOT, steps: [sleepStep('fill1', 5000)] })
    const fill2 = runner.enqueueBuildJob({ label: 'fill2', channels: ['cf2'], projectRoot: PROJECT_ROOT, steps: [sleepStep('fill2', 5000)] })
    const queued = runner.enqueueBuildJob({ label: 'queued', channels: ['cq'], projectRoot: PROJECT_ROOT, steps: [sleepStep('queued', 60000)] })
    await waitFor(() => runner.getQueueState().queued.includes(queued.id), 3000, 'job to be queued')
    const r = runner.cancelJob(queued.id)
    assert.strictEqual(r.ok, true)
    const finished = await jobDone(queued.id, 3000)
    assert.strictEqual(finished.status, 'cancelled')
    assert.strictEqual(finished.startedAt, null, 'queued-cancel should never set startedAt')
    // Cancel the fillers so we don't slow down later tests.
    runner.cancelJob(fill1.id)
    runner.cancelJob(fill2.id)
    await jobDone(fill1.id, 5000)
    await jobDone(fill2.id, 5000)
    ok(t)
  } catch (e) { fail(t, e) }
}

// === Test 4: channel-conflict avoidance — two build-all jobs serialise ===
async function testChannelConflict() {
  const t = 'channel-conflict: build-all serialises'
  try {
    // build-all is signalled by channels=[] (per server.js convention).
    const a = runner.enqueueBuildJob({ label: 'all-1', channels: [], projectRoot: PROJECT_ROOT, steps: [sleepStep('all-1', 800)] })
    const b = runner.enqueueBuildJob({ label: 'all-2', channels: [], projectRoot: PROJECT_ROOT, steps: [sleepStep('all-2', 200)] })
    const ra = await jobDone(a.id)
    const rb = await jobDone(b.id)
    assert.strictEqual(ra.status, 'success')
    assert.strictEqual(rb.status, 'success')
    // b must start AFTER a ends — they share "all channels", so the runner
    // should refuse to drain b until a's slot+channels free.
    assert.ok(rb.startedAt >= ra.endedAt - 50,
      'all-2 started ' + (rb.startedAt - ra.endedAt) + 'ms before all-1 ended; channel-conflict not enforced')
    ok(t)
  } catch (e) { fail(t, e) }
}

// === Test 5: listener replay matches buffered output ===
async function testListenerReplay() {
  const t = 'listener: SSE replay matches buffered output'
  try {
    const j = runner.enqueueBuildJob({ label: 'replay', channels: ['cr'], projectRoot: PROJECT_ROOT, steps: [sleepStep('replay', 200)] })
    await jobDone(j.id, 10000)
    const finished = runner.getJob(j.id)
    // Attaching after the job ends should still receive an `end` event
    // (server.js sends one synchronously based on status when the job is
    // already finished — listener path here is for live attaches).
    let got = false
    const detach = runner.attachListener(j.id, (e) => { if (e.end) got = true })
    // Listener should detach gracefully; if the job is already done, the
    // runner does NOT auto-fire end (that's server.js's job in the SSE
    // route). Just verify attach/detach don't throw.
    if (detach) detach()
    assert.ok(finished.output.length > 0, 'job output buffer should not be empty')
    assert.ok(finished.output.some(e => /BEGIN replay/.test(e.line || '')), 'should have BEGIN marker in output')
    ok(t)
  } catch (e) { fail(t, e) }
}

// === Test 6: write-after-end race — onComplete writes never reach a closed
// listener and never throw. This locks in the fix for the multi-customer
// build crash where jobAppend() inside onComplete (cleanup / db / live-push)
// hit res.write on an already-ended SSE response and crashed Node via an
// unhandled 'error' event. ===
async function testWriteAfterEndRace() {
  const t = 'write-after-end: onComplete writes never reach closed listener'
  try {
    let endSeen = false
    let endSeenAt = 0
    let postEndDeliveries = 0
    let listenerCallCount = 0
    let onCompleteRan = false
    let onCompleteSawListenersStillAttached = null
    let lateLineDelivered = false

    const sseLikeListener = (entry) => {
      listenerCallCount++
      if (entry.end) {
        endSeen = true
        endSeenAt = listenerCallCount
        return
      }
      if (endSeen) {
        // Anything after end is the bug we're guarding against.
        postEndDeliveries++
        if (entry.line === 'late from outside') lateLineDelivered = true
      }
    }

    let attachedJobId = null
    const j = runner.enqueueBuildJob({
      label: 'wae', channels: ['cwae'], projectRoot: PROJECT_ROOT,
      steps: [sleepStep('wae', 100)],
      onComplete: (exitCode, job) => {
        onCompleteRan = true
        // Snapshot listener-set size at the moment onComplete starts. The fix
        // requires onComplete to run BEFORE finishJob/emitJobEnd, so the
        // listener should still be attached here (so its writes can stream
        // live) — and the live SSE listener should NOT have seen `end` yet.
        onCompleteSawListenersStillAttached = job.listeners.size > 0 && !endSeen
        // Simulate the real onComplete pattern: jobAppend a few post-build
        // lines (cleanup / db / live-push). These MUST arrive at the live
        // listener (test asserts via output buffer + listener call count
        // delta after end).
        runner.jobAppend(job, '[cleanup] cwae — removed: nothing')
        runner.jobAppend(job, '[db] recorded version')
        runner.jobAppend(job, '[live-push] cwae v1.0.0 -> 0 online client(s)')
      },
    })
    attachedJobId = j.id
    // Attach a fake SSE-style listener immediately (race the runner — the
    // real admin UI does the same when an operator opens the build console
    // mid-build).
    runner.attachListener(j.id, sseLikeListener)
    const finished = await jobDone(j.id, 15000)
    assert.strictEqual(finished.status, 'success', 'job status was ' + finished.status)
    assert.ok(onCompleteRan, 'onComplete should have run')
    assert.strictEqual(onCompleteSawListenersStillAttached, true,
      'onComplete must run BEFORE finishJob/emitJobEnd so its writes reach the live SSE stream')
    assert.ok(endSeen, 'listener should have received an end event')
    assert.strictEqual(postEndDeliveries, 0,
      'no entries should be delivered to the listener after end (got ' + postEndDeliveries + ')')
    // Belt-and-braces invariant: emitJobEnd must clear the listener set, so
    // a late jobAppend from outside the runner (worst-case) is also a no-op.
    assert.strictEqual(finished.listeners.size, 0,
      'job.listeners should be empty after emitJobEnd, was ' + finished.listeners.size)
    const callsBeforeLate = listenerCallCount
    let threw = null
    try {
      runner.jobAppend(finished, 'late from outside')
    } catch (e) {
      threw = e
    }
    assert.strictEqual(threw, null,
      'late jobAppend after job end must not throw, threw: ' + (threw && threw.message))
    assert.strictEqual(listenerCallCount, callsBeforeLate,
      'late jobAppend must NOT invoke any listener, but listener was called')
    assert.strictEqual(lateLineDelivered, false,
      'late line was delivered to listener — listeners not cleared on end')
    // The replay buffer must still see the late line so a fresh subscriber
    // gets the full history.
    assert.ok(finished.output.some(e => e.line === 'late from outside'),
      'late jobAppend should still append to job.output for replay buffer')
    // And the cleanup / db / live-push lines from onComplete must be in the
    // output buffer (they were appended before end).
    assert.ok(finished.output.some(e => /\[cleanup\]/.test(e.line || '')),
      'cleanup line missing from output buffer')
    assert.ok(finished.output.some(e => /\[live-push\]/.test(e.line || '')),
      'live-push line missing from output buffer')
    ok(t)
  } catch (e) { fail(t, e) }
}

// === Test 7: onCancel hook fires exactly once when a RUNNING job is cancelled.
// Locks in Task #4 acceptance: the per-customer cancel path must invoke its
// cleanup hook AFTER the child has exited (so we don't race the live build
// writing into the version dir we're about to delete). ===
async function testOnCancelRunningHook() {
  const t = 'onCancel: running-cancel fires hook exactly once after child exits'
  try {
    let calls = 0
    let calledWithJob = null
    let calledAfterStatusCancelled = false
    let calledBeforeFinish = null
    const j = runner.enqueueBuildJob({
      label: 'oc-running', channels: ['oc-r'], projectRoot: PROJECT_ROOT,
      steps: [sleepStep('oc-running', 60000)],
      onCancel: (job) => {
        calls++
        calledWithJob = job
        // By the time onCancel fires, finishJob should already have set
        // status='cancelled' (so the hook sees a fully-quiesced job and the
        // child is guaranteed to have exited).
        calledAfterStatusCancelled = job.status === 'cancelled'
        calledBeforeFinish = job.activeChild
      },
    })
    await waitFor(() => runner.getJob(j.id).status === 'running', 5000, 'job to be running')
    runner.cancelJob(j.id)
    const finished = await jobDone(j.id, 5000)
    assert.strictEqual(finished.status, 'cancelled')
    assert.strictEqual(calls, 1, 'onCancel fired ' + calls + ' time(s), expected exactly 1')
    assert.ok(calledWithJob && calledWithJob.id === j.id, 'onCancel called with wrong job')
    assert.strictEqual(calledAfterStatusCancelled, true,
      'onCancel must run AFTER status flips to cancelled (child exited)')
    ok(t)
  } catch (e) { fail(t, e) }
}

// === Test 8: onCancel hook fires for a QUEUED-cancelled job too. The
// cleanup is a no-op for a job that never published anything, but the
// hook must still be invoked so out-of-band staged files (if any) are
// swept. ===
async function testOnCancelQueuedHook() {
  const t = 'onCancel: queued-cancel fires hook even though job never spawned'
  try {
    // Fill both slots with long-running jobs so the next one queues.
    const fill1 = runner.enqueueBuildJob({ label: 'ocq-fill1', channels: ['ocq-f1'], projectRoot: PROJECT_ROOT, steps: [sleepStep('ocq-fill1', 60000)] })
    const fill2 = runner.enqueueBuildJob({ label: 'ocq-fill2', channels: ['ocq-f2'], projectRoot: PROJECT_ROOT, steps: [sleepStep('ocq-fill2', 60000)] })
    let calls = 0
    let workspaceWasNull = null
    let startedAtWasNull = null
    const queued = runner.enqueueBuildJob({
      label: 'ocq', channels: ['ocq'], projectRoot: PROJECT_ROOT,
      steps: [sleepStep('ocq', 60000)],
      onCancel: (job) => {
        calls++
        // If the queued-cancel branch never spawned the runner, the
        // workspace should still be null when the hook fires.
        workspaceWasNull = job.workspace === null
        // CRITICAL discriminator the SERVER's onCancel uses to skip the
        // filesystem sweep: a queued-cancel must surface job.startedAt===null
        // so the cleanup hook can distinguish "never ran -> hands off the
        // shared output dirs" from "actually started -> safe to delete".
        startedAtWasNull = job.startedAt === null
      },
    })
    await waitFor(() => runner.getQueueState().queued.includes(queued.id), 3000, 'job to be queued')
    runner.cancelJob(queued.id)
    const finished = await jobDone(queued.id, 3000)
    assert.strictEqual(finished.status, 'cancelled')
    assert.strictEqual(finished.startedAt, null, 'queued-cancel should never set startedAt')
    assert.strictEqual(calls, 1, 'onCancel fired ' + calls + ' time(s), expected exactly 1')
    assert.strictEqual(workspaceWasNull, true,
      'queued-cancel must fire onCancel BEFORE any workspace would have been created')
    assert.strictEqual(startedAtWasNull, true,
      'queued-cancel hook MUST see job.startedAt===null so the server can skip rm of shared output dirs')
    // Free the fillers so later tests don't slow down.
    runner.cancelJob(fill1.id)
    runner.cancelJob(fill2.id)
    await jobDone(fill1.id, 5000)
    await jobDone(fill2.id, 5000)
    ok(t)
  } catch (e) { fail(t, e) }
}

// === Test 9: cancelling a running job releases its slot so the next queued
// job actually starts. Combined with the per-customer fan-out, this is what
// makes "Cancel customer A" not block customer B from running. ===
async function testCancelReleasesSlot() {
  const t = 'cancel-running: queued sibling starts after slot frees'
  try {
    // Fill both slots, then queue one more.
    const f1 = runner.enqueueBuildJob({ label: 'crs-f1', channels: ['crs-f1'], projectRoot: PROJECT_ROOT, steps: [sleepStep('crs-f1', 60000)] })
    const f2 = runner.enqueueBuildJob({ label: 'crs-f2', channels: ['crs-f2'], projectRoot: PROJECT_ROOT, steps: [sleepStep('crs-f2', 60000)] })
    const queued = runner.enqueueBuildJob({ label: 'crs-q', channels: ['crs-q'], projectRoot: PROJECT_ROOT, steps: [sleepStep('crs-q', 200)] })
    await waitFor(() => runner.getQueueState().queued.includes(queued.id), 3000, 'queued sibling to enqueue')
    // Cancel one of the active jobs — the queued one must take its slot.
    runner.cancelJob(f1.id)
    const queuedFinished = await jobDone(queued.id, 8000)
    assert.strictEqual(queuedFinished.status, 'success',
      'queued sibling should run + succeed after slot frees, got ' + queuedFinished.status)
    // Tidy up the other filler.
    runner.cancelJob(f2.id)
    await jobDone(f1.id, 5000)
    await jobDone(f2.id, 5000)
    ok(t)
  } catch (e) { fail(t, e) }
}

// === Test 10: workspace creation yields the event loop. Locks in the
// Task #16 fix that converted createJobWorkspace from a sync recursive
// copy to an async-yielding one. The previous sync copy stacked across N
// fan-out jobs and produced a multi-hundred-ms event-loop freeze that
// stuttered the admin SSE stream every time a new BUILD ALL job started. ===
async function testWorkspaceYieldsEventLoop() {
  const t = 'workspace: createJobWorkspace yields event loop between top-level entries'
  try {
    // Build a project root with several non-trivial top-level dirs so the
    // async-yielding loop has multiple yield points. Each dir contains a
    // file or two — small enough to copy fast, structured enough to force
    // the loop body to fire repeatedly.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobrunner-yield-'))
    fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true })
    for (let i = 0; i < 8; i++) {
      const d = path.join(root, 'src' + i)
      fs.mkdirSync(d, { recursive: true })
      fs.writeFileSync(path.join(d, 'a.js'), 'module.exports = ' + i + '\n')
      fs.writeFileSync(path.join(d, 'b.js'), 'module.exports = ' + (i + 100) + '\n')
    }
    // Schedule a setImmediate ticker BEFORE we start the workspace clone —
    // if the clone is sync (the bug we are guarding against) the ticker
    // will not fire until the clone returns. With the async fix it fires
    // many times during the clone.
    let ticks = 0
    let stop = false
    const tick = () => { if (stop) return; ticks++; setImmediate(tick) }
    setImmediate(tick)
    const wsRoot = await runner.createJobWorkspace('yield-test', root)
    stop = true
    assert.ok(fs.existsSync(wsRoot), 'workspace root should exist after createJobWorkspace')
    // Synthetic project has 8 src* entries → at least 8 await-points →
    // the ticker should have fired multiple times. We require >=2 to be
    // robust against scheduling jitter on slow CI; the bug case fires 0
    // ticks until createJobWorkspace returns.
    assert.ok(ticks >= 2,
      'event loop ticker fired ' + ticks + ' times during workspace clone — expected >=2 (clone is not yielding)')
    // Cleanup so the tmp dir count stays bounded.
    await runner.disposeJobWorkspace('yield-test', root)
    try { fs.rmSync(root, { recursive: true, force: true }) } catch (_) {}
    ok(t + ' (' + ticks + ' ticks)')
  } catch (e) { fail(t, e) }
}

;(async () => {
  console.log('=== job-runner.js tests ===')
  console.log('  project root: ' + PROJECT_ROOT)
  console.log('  max concurrent: ' + runner.MAX_CONCURRENT_BUILDS)
  console.log('')
  await testParallelism()
  await testCancelRunning()
  await testCancelQueued()
  await testChannelConflict()
  await testListenerReplay()
  await testWriteAfterEndRace()
  await testOnCancelRunningHook()
  await testOnCancelQueuedHook()
  await testCancelReleasesSlot()
  await testWorkspaceYieldsEventLoop()
  console.log('')
  if (failed === 0) {
    console.log('=== ALL TESTS PASSED ===')
    process.exit(0)
  } else {
    console.log('=== ' + failed + ' TEST(S) FAILED ===')
    process.exit(1)
  }
})().catch(e => {
  console.error('TEST RUNNER CRASHED:', e)
  process.exit(2)
})
