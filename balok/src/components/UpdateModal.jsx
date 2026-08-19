import { useState, useEffect, useRef } from 'react'
import useStore from '../store/useStore'
import { getDefaultAccent } from '../lib/accent'

/* Walok-parity OTA modal. Self-managed: it listens to the ota:* IPC events
   broadcast by electron/updater.js and drives proceed / dismiss / restart. */

function fmtBytes(n) {
  if (!n || n <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return v.toFixed(v >= 100 || i === 0 ? 0 : v >= 10 ? 1 : 2) + ' ' + units[i]
}

export default function UpdateModal() {
  const storeAccent = useStore(s => s.settings.accentColor) || getDefaultAccent()
  const [visible, setVisible] = useState(false)
  const [stage, setStage] = useState('idle')
  const [info, setInfo] = useState(null)
  const [progress, setProgress] = useState({ downloaded: 0, total: 0, percent: 0 })
  const [errorMsg, setErrorMsg] = useState('')
  const [countdown, setCountdown] = useState(null)
  const [speed, setSpeed] = useState(0)
  // Brand kicker comes from ota-config.json at runtime — never hardcoded,
  // otherwise an OTA rebrand would still show the old name until a rebuild.
  const [brand, setBrand] = useState('')
  // Version the launcher is actually RUNNING, straight from the OTA engine.
  // Used as a fallback whenever an ota:* event payload omits currentVersion,
  // so the modal never falls back to a stale/blank version label.
  const [statusVer, setStatusVer] = useState('')
  // Build id of the running install (falls back when an event omits it).
  const [statusBuild, setStatusBuild] = useState('')
  const speedTrackRef = useRef({ lastTime: 0, lastBytes: 0, samples: [] })

  useEffect(() => {
    let cancelled = false
    if (!window.electronAPI?.ota?.getStatus) return
    window.electronAPI.ota.getStatus().then(s => {
      if (cancelled) return
      if (s && typeof s.brand === 'string' && s.brand.trim()) setBrand(s.brand.trim())
      if (s && typeof s.currentVersion === 'string' && s.currentVersion) setStatusVer(s.currentVersion)
      if (s && typeof s.currentBuildId === 'string' && s.currentBuildId) setStatusBuild(s.currentBuildId)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!window.electronAPI?.ota?.on) return
    const api = window.electronAPI.ota
    const offs = []

    offs.push(api.on('ota:update-available', (data) => {
      setVisible(true)
      setStage('available')
      setInfo(data)
      setErrorMsg('')
      setProgress({ downloaded: 0, total: 0, percent: 0 })
    }))

    offs.push(api.on('ota:download-start', (data) => {
      setVisible(true)
      setStage('downloading')
      setInfo(prev => ({ ...(prev || {}), ...(data || {}) }))
      setProgress({ downloaded: 0, total: (data && data.totalSize) || 0, percent: 0 })
      speedTrackRef.current = { lastTime: Date.now(), lastBytes: 0, samples: [] }
    }))

    offs.push(api.on('ota:download-progress', (p) => {
      setProgress(p)
      const now = Date.now()
      const track = speedTrackRef.current
      const dt = (now - track.lastTime) / 1000
      if (dt >= 0.4) {
        track.samples.push((p.downloaded - track.lastBytes) / dt)
        if (track.samples.length > 5) track.samples.shift()
        setSpeed(track.samples.reduce((a, b) => a + b, 0) / track.samples.length)
        track.lastTime = now
        track.lastBytes = p.downloaded
      }
    }))

    offs.push(api.on('ota:verifying', (data) => {
      setStage('verifying')
      setInfo(prev => ({ ...(prev || {}), ...(data || {}) }))
    }))
    offs.push(api.on('ota:applying', (data) => {
      setStage('applying')
      setInfo(prev => ({ ...(prev || {}), ...(data || {}) }))
    }))

    offs.push(api.on('ota:ready-to-restart', (data) => {
      setStage('ready')
      setInfo(prev => ({ ...prev, ...data }))
      setCountdown(5)
    }))

    offs.push(api.on('ota:error', (e) => {
      setErrorMsg((e && e.error) || 'Unknown error')
      setStage('error')
    }))

    return () => { offs.forEach(off => off && off()) }
  }, [])

  useEffect(() => {
    if (countdown === null) return
    if (countdown <= 0) {
      try { window.electronAPI?.ota?.restart() } catch (e) {}
      return
    }
    const t = setTimeout(() => setCountdown(c => (c == null ? null : c - 1)), 1000)
    return () => clearTimeout(t)
  }, [countdown])

  if (!visible) return null

  const versionLabel = info?.latestVersion || info?.version || '?'
  const currentVersion = info?.currentVersion || statusVer || ''
  // Same version on both sides = the operator re-shipped the SAME release with
  // new payload bytes (a "rebump"). Showing "v1.0.3 -> v1.0.3" reads like a
  // detection bug, so label it for what it is.
  const isRebuild = !!currentVersion && currentVersion === versionLabel
  const shortId = (b) => (typeof b === 'string' && b ? b.slice(0, 7) : '')
  const curBuild = shortId(info?.currentBuildId || statusBuild)
  const newBuild = shortId(info?.latestBuildId)
  // On a rebump the version number is identical on both sides, so the only
  // honest identity is the build id — show it instead of a bare "rebuild".
  const buildArrow = curBuild && newBuild && curBuild !== newBuild
    ? ` (build ${curBuild} → ${newBuild})`
    : (newBuild ? ` (build ${newBuild})` : '')
  const arrow = isRebuild
    ? `v${versionLabel} · rebuild${buildArrow}`
    : (currentVersion ? `v${currentVersion} → v${versionLabel}${buildArrow}` : `v${versionLabel}${buildArrow}`)

  let title, subtitle, statusText
  switch (stage) {
    case 'available':
      title = isRebuild ? 'Update re-issued' : 'Update available'
      subtitle = arrow
      statusText = 'Review the release notes below, then click Proceed Update.'
      break
    case 'downloading':
      title = 'Downloading update'
      subtitle = arrow
      statusText = `${fmtBytes(progress.downloaded)} of ${fmtBytes(progress.total)}` + (speed > 0 ? `   •   ${fmtBytes(speed)}/s` : '')
      break
    case 'verifying':
      title = 'Verifying integrity'
      subtitle = arrow
      statusText = 'Checking SHA-256 signature…'
      break
    case 'applying':
      title = 'Applying update'
      subtitle = arrow
      statusText = 'Staging files for next launch…'
      break
    case 'ready':
      title = 'Update ready'
      subtitle = arrow
      statusText = countdown != null && countdown > 0 ? `Restarting in ${countdown}s…` : 'Restarting now…'
      break
    case 'error':
      title = 'Update failed'
      subtitle = 'Will retry automatically'
      statusText = errorMsg
      break
    default:
      title = 'Update'
      subtitle = ''
      statusText = ''
  }

  const percent = stage === 'verifying' || stage === 'applying' || stage === 'ready'
    ? 100
    : (progress.percent || 0)

  const isError = stage === 'error'
  const ACCENT = isError ? '#ef4444' : storeAccent
  const TEXT_FAINT = '#6b6b73'
  const TEXT_SUB = '#a1a1aa'
  const BORDER = 'rgba(255,255,255,0.08)'

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 99999,
        background: 'rgba(8, 8, 10, 0.72)',
        backdropFilter: 'blur(12px) saturate(140%)',
        WebkitBackdropFilter: 'blur(12px) saturate(140%)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: '"Inter", "SF Pro Text", "Segoe UI", -apple-system, BlinkMacSystemFont, sans-serif',
        WebkitFontSmoothing: 'antialiased',
      }}
    >
      <div
        style={{
          width: '90%',
          maxWidth: 480,
          background: '#131316',
          border: `1px solid ${BORDER}`,
          borderRadius: 14,
          padding: '28px 32px',
          boxShadow: '0 24px 80px rgba(0,0,0,0.6), 0 2px 8px rgba(0,0,0,0.3)',
          color: '#f5f5f6',
          position: 'relative',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 18 }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: ACCENT, display: 'inline-block' }} />
          <span style={{
            fontSize: 11,
            letterSpacing: '0.12em',
            color: TEXT_FAINT,
            textTransform: 'uppercase',
            fontWeight: 600,
          }}>
            {brand || 'Update'}
          </span>
        </div>

        <h2 style={{ margin: 0, fontSize: 22, letterSpacing: '-0.01em', fontWeight: 600, color: '#f5f5f6', lineHeight: 1.25 }}>
          {title}
        </h2>

        {subtitle && (
          <div style={{ marginTop: 6, fontSize: 13, color: TEXT_SUB, lineHeight: 1.45 }}>{subtitle}</div>
        )}

        <div style={{ marginTop: 24 }}>
          <div style={{
            position: 'relative',
            height: 6,
            background: 'rgba(255,255,255,0.06)',
            borderRadius: 999,
            overflow: 'hidden',
          }}>
            <div style={{
              width: `${percent}%`,
              height: '100%',
              background: ACCENT,
              transition: 'width 0.3s ease-out',
              borderRadius: 999,
            }} />
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginTop: 12, gap: 16 }}>
            <div style={{
              fontSize: 12,
              color: TEXT_SUB,
              fontFamily: '"JetBrains Mono", "SF Mono", "Consolas", "Courier New", monospace',
              wordBreak: 'break-word',
              flex: 1,
              minHeight: 16,
            }}>
              {statusText}
            </div>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#f5f5f6', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
              {percent}%
            </div>
          </div>
        </div>

        {stage === 'available' && (
          <>
            <div style={{
              marginTop: 22,
              padding: '14px 16px',
              background: 'rgba(255,255,255,0.03)',
              border: `1px solid ${BORDER}`,
              borderRadius: 10,
              maxHeight: 220,
              overflowY: 'auto',
            }}>
              <div style={{
                fontSize: 10,
                letterSpacing: '0.12em',
                color: TEXT_FAINT,
                textTransform: 'uppercase',
                fontWeight: 600,
                marginBottom: 8,
              }}>
                What's new
              </div>
              <div style={{ fontSize: 13, color: '#e4e4e7', lineHeight: 1.55, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                {(info && (info.notes || info.manifest?.notes)) || `Update v${versionLabel}`}
              </div>
            </div>
            <div style={{ marginTop: 22, display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button
                onClick={() => {
                  try { window.electronAPI?.ota?.dismiss() } catch (e) {}
                  setVisible(false)
                }}
                style={{
                  background: 'transparent',
                  color: TEXT_SUB,
                  border: `1px solid ${BORDER}`,
                  padding: '9px 16px',
                  borderRadius: 8,
                  fontWeight: 500,
                  fontSize: 13,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                Later
              </button>
              <button
                onClick={() => { try { window.electronAPI?.ota?.proceed() } catch (e) {} }}
                style={{
                  background: ACCENT,
                  color: '#fff',
                  border: 'none',
                  padding: '9px 18px',
                  borderRadius: 8,
                  fontWeight: 600,
                  fontSize: 13,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  boxShadow: '0 1px 0 rgba(255,255,255,0.08) inset',
                }}
              >
                Proceed Update
              </button>
            </div>
          </>
        )}

        {stage === 'ready' && (
          <div style={{ marginTop: 24, display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
            <button
              onClick={() => { try { window.electronAPI?.ota?.restart() } catch (e) {} }}
              style={{
                background: ACCENT,
                color: '#fff',
                border: 'none',
                padding: '9px 18px',
                borderRadius: 8,
                fontWeight: 600,
                fontSize: 13,
                cursor: 'pointer',
                fontFamily: 'inherit',
                boxShadow: '0 1px 0 rgba(255,255,255,0.08) inset',
              }}
            >
              Restart now{countdown != null && countdown > 0 ? ` (${countdown})` : ''}
            </button>
          </div>
        )}

        {stage === 'error' && (
          <div style={{ marginTop: 22, display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <button
              onClick={() => { setVisible(false); setStage('idle') }}
              style={{
                background: 'transparent',
                color: TEXT_SUB,
                border: `1px solid ${BORDER}`,
                padding: '9px 16px',
                borderRadius: 8,
                fontWeight: 500,
                fontSize: 13,
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              Close
            </button>
          </div>
        )}

        <div style={{
          marginTop: 22,
          paddingTop: 14,
          borderTop: `1px solid ${BORDER}`,
          fontSize: 11,
          letterSpacing: '0.04em',
          color: TEXT_FAINT,
          textAlign: 'center',
        }}>
          {isError ? 'Will retry on the next check cycle' : 'Installation is required — please wait'}
        </div>
      </div>
    </div>
  )
}
