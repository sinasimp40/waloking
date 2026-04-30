// Build-phase model used by the admin progress bar (Task #17).
//
// A "phase" is a coarse, human-meaningful chunk of a customer build. The job
// runner emits a STRUCTURED `phase` event on the per-job SSE stream every time
// a phase starts (in addition to the existing per-line `line` events used by
// the collapsible log view).
//
// Wire shape (one SSE `data:` event per phase boundary):
//   { t, phase: '<id>', label: '<human label>',
//     weight: <0..1>, weightSoFar: <0..1>, startedAt: <ms> }
//
// `weightSoFar` is the cumulative weight of all phases BEFORE this one — i.e.
// where the progress bar should jump to at the moment this phase starts. The
// admin UI then animates from `weightSoFar` toward `weightSoFar + weight`
// over the phase's expected duration so the bar never freezes mid-step.
//
// Weights are RELATIVE proportions of total wall-clock time on a typical
// operator machine (~90s per customer). They don't have to be precise — the
// only invariant the UI cares about is that they sum to ~1.0 and that they
// roughly reflect "where am I" so the bar advances monotonically.
//
// Phases ordered by execution sequence inside enqueueOneCustomerJob:
//
//   1. workspace      .build-jobs/<id>/ clone of the source tree
//   2. rebrand        scripts/rebrand.js (find/replace + ICO gen) + logo sync
//   3. vite           npm run build (vite production bundle for the renderer)
//   4. pack-launcher  electron-builder for the launcher (zip + win-unpacked)
//   5. pack-server    electron-builder for the companion server
//   6. collect        copy artifacts into releases/<channel>/<version>/
//   7. publish        scripts/publish-update.js (manifest + payload zips)
const PHASES = [
  { id: 'workspace',     label: 'Preparing workspace',         weight: 0.02 },
  { id: 'rebrand',       label: 'Rebranding source',           weight: 0.03 },
  { id: 'vite',          label: 'Bundling launcher (Vite)',    weight: 0.08 },
  { id: 'pack-launcher', label: 'Packing launcher payload',    weight: 0.36 },
  { id: 'pack-server',   label: 'Packing server payload',      weight: 0.36 },
  { id: 'collect',       label: 'Collecting artifacts',        weight: 0.05 },
  { id: 'publish',       label: 'Publishing to update server', weight: 0.10 },
]

// scripts/build-customer.js emits "[SUBSTEP_BEGIN] <label>" before each of
// its inner steps. The runner reads those lines and re-broadcasts the
// matching phase event. Keys MUST match the labels passed to substep() in
// scripts/build-customer.js exactly.
const SUBSTEP_TO_PHASE = {
  'sync logo + rebrand source':   'rebrand',
  'vite build (launcher)':        'vite',
  'electron-builder (launcher)':  'pack-launcher',
  'electron-builder (server)':    'pack-server',
  'collect artifacts':            'collect',
}

function phaseById(id) {
  return PHASES.find(p => p.id === id) || null
}

function weightSoFar(id) {
  let acc = 0
  for (const p of PHASES) {
    if (p.id === id) return acc
    acc += p.weight
  }
  return acc
}

function totalWeight() {
  return PHASES.reduce((acc, p) => acc + p.weight, 0)
}

module.exports = {
  PHASES,
  SUBSTEP_TO_PHASE,
  phaseById,
  weightSoFar,
  totalWeight,
}
