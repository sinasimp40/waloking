// Keep discovery independent of React so startup and manual scans share the
// same rules and can be tested without touching a user's saved settings.
const pendingScans = new WeakMap()
function discoverOnce(discover) {
  let pending = pendingScans.get(discover)
  if (!pending) {
    pending = Promise.resolve().then(() => discover(8000))
    pendingScans.set(discover, pending)
    const cleanup = () => pendingScans.delete(discover)
    pending.then(cleanup, cleanup)
  }
  return pending
}

export async function connectSaveServer({ discover, getState, replaceExisting = false, isActive = () => true }) {
  const initialUrl = getState().settings.saveLoadServerUrl || ''
  if (initialUrl && !replaceExisting) return { success: true, url: initialUrl, configured: true }
  if (typeof discover !== 'function') return { success: false, unavailable: true }
  try {
    // StrictMode remounts and manual clicks can overlap startup. Share one UDP
    // listener rather than competing for the same discovery port.
    const result = await discoverOnce(discover)
    if (!result?.success || typeof result.url !== 'string' || !result.url.trim()) {
      return { success: false, error: result?.error || 'No Save & Load server found on this network.' }
    }
    // A scan must not overwrite an address edited while it was running.
    if (!isActive() || (getState().settings.saveLoadServerUrl || '') !== initialUrl) {
      return { success: false, cancelled: true }
    }
    getState().updateSettings({ saveLoadServerUrl: result.url })
    return result
  } catch (error) {
    return { success: false, error: error?.message || 'Server discovery failed.' }
  }
}
