import { useState, useEffect, useRef } from 'react'

function fmtBytes(n) {
  if (!n || n <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return v.toFixed(v >= 100 || i === 0 ? 0 : v >= 10 ? 1 : 2) + ' ' + units[i]
}

export default function UpdateModal() {
  const [visible, setVisible] = useState(false)
  const [stage, setStage] = useState('idle')
  const [info, setInfo] = useState(null)
  const [progress, setProgress] = useState({ downloaded: 0, total: 0, percent: 0 })
  const [errorMsg, setErrorMsg] = useState('')
  const [countdown, setCountdown] = useState(null)
  const [speed, setSpeed] = useState(0)
  // Brand string for the kicker is pulled at runtime from ota-config.json
  // (via the ota:get-status IPC). It must NOT be hardcoded here, otherwise
  // a rebrand-style OTA update (DENFI -> BLAST) would still ship the old
  // brand text in the modal until the next full re-build.
  const [brand, setBrand] = useState('')
  const speedTrackRef = useRef({ lastTime: 0, lastBytes: 0, samples: [] })

  useEffect(() => {
    let cancelled = false
    if (typeof window !== 'undefined' && window.location && window.location.search.includes('preview-update')) {
      setBrand('EXAMPLE CAFE')
      return
    }
    if (!window.electronAPI || !window.electronAPI.ota) return
    window.electronAPI.ota.getStatus().then(s => {
      if (cancelled) return
      if (s && typeof s.brand === 'string' && s.brand.trim()) setBrand(s.brand.trim())
    }).catch(() => {})
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (typeof window !== 'undefined' && window.location && window.location.search.includes('preview-update')) {
      let cancelled = false
      const totalSize = 18_500_000
      const info = { currentVersion: '1.0.0', latestVersion: '1.0.1', notes: 'Preview' }
      setVisible(true)
      setStage('available')
      setInfo(info)
      setProgress({ downloaded: 0, total: 0, percent: 0 })
      const start = setTimeout(() => {
        if (cancelled) return
        setStage('downloading')
        setProgress({ downloaded: 0, total: totalSize, percent: 0 })
        speedTrackRef.current = { lastTime: Date.now(), lastBytes: 0, samples: [] }
        let downloaded = 0
        const tick = setInterval(() => {
          if (cancelled) { clearInterval(tick); return }
          downloaded = Math.min(totalSize, downloaded + 600_000 + Math.random() * 900_000)
          const percent = Math.round((downloaded / totalSize) * 100)
          const now = Date.now()
          const track = speedTrackRef.current
          const dt = (now - track.lastTime) / 1000
          if (dt >= 0.4) {
            const sample = (downloaded - track.lastBytes) / dt
            track.samples.push(sample)
            if (track.samples.length > 5) track.samples.shift()
            setSpeed(track.samples.reduce((a, b) => a + b, 0) / track.samples.length)
            track.lastTime = now
            track.lastBytes = downloaded
          }
          setProgress({ downloaded, total: totalSize, percent })
          if (downloaded >= totalSize) {
            clearInterval(tick)
            setTimeout(() => { if (!cancelled) setStage('verifying') }, 400)
            setTimeout(() => { if (!cancelled) setStage('applying') }, 1400)
            setTimeout(() => {
              if (cancelled) return
              setStage('ready')
              setInfo(prev => ({ ...prev, ...info }))
              setCountdown(5)
            }, 2400)
          }
        }, 220)
      }, 1200)
      return () => { cancelled = true; clearTimeout(start) }
    }

    if (!window.electronAPI || !window.electronAPI.ota) return
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
      setProgress({ downloaded: 0, total: data.totalSize || 0, percent: 0 })
      speedTrackRef.current = { lastTime: Date.now(), lastBytes: 0, samples: [] }
    }))

    offs.push(api.on('ota:download-progress', (p) => {
      setProgress(p)
      const now = Date.now()
      const track = speedTrackRef.current
      const dt = (now - track.lastTime) / 1000
      if (dt >= 0.4) {
        const dBytes = p.downloaded - track.lastBytes
        const sample = dBytes / dt
        track.samples.push(sample)
        if (track.samples.length > 5) track.samples.shift()
        const avg = track.samples.reduce((a, b) => a + b, 0) / track.samples.length
        setSpeed(avg)
        track.lastTime = now
        track.lastBytes = p.downloaded
      }
    }))

    offs.push(api.on('ota:verifying', () => setStage('verifying')))
    offs.push(api.on('ota:applying', () => setStage('applying')))

    offs.push(api.on('ota:ready-to-restart', (data) => {
      setStage('ready')
      setInfo(prev => ({ ...prev, ...data }))
      setCountdown(5)
    }))

    offs.push(api.on('ota:error', (e) => {
      setErrorMsg(e?.error || 'Unknown error')
      setStage('error')
    }))

    return () => { offs.forEach(off => off && off()) }
  }, [])

  useEffect(() => {
    if (countdown === null) return
    const isPreview = typeof window !== 'undefined' && window.location && window.location.search.includes('preview-update')
    if (countdown <= 0) {
      if (isPreview) {
        setVisible(false)
        setCountdown(null)
        setStage('idle')
      } else {
        try { window.electronAPI?.ota?.restart() } catch (e) {}
      }
      return
    }
    const t = setTimeout(() => setCountdown(c => (c == null ? null : c - 1)), 1000)
    return () => clearTimeout(t)
  }, [countdown])

  if (!visible) return null

  const versionLabel = info?.latestVersion || info?.version || '?'
  const currentVersion = info?.currentVersion || ''

  let title, subtitle, statusText
  switch (stage) {
    case 'available':
      title = 'Update available'
      subtitle = 'A new version is ready to install'
      statusText = 'Preparing download…'
      break
    case 'downloading':
      title = 'Downloading update'
      subtitle = `v${currentVersion} → v${versionLabel}`
      statusText = `${fmtBytes(progress.downloaded)} of ${fmtBytes(progress.total)}` + (speed > 0 ? `   •   ${fmtBytes(speed)}/s` : '')
      break
    case 'verifying':
      title = 'Verifying integrity'
      subtitle = `v${versionLabel}`
      statusText = 'Checking SHA-256 signature…'
      break
    case 'applying':
      title = 'Applying update'
      subtitle = `v${versionLabel}`
      statusText = 'Staging files for next launch…'
      break
    case 'ready':
      title = 'Update ready'
      subtitle = `v${currentVersion} → v${versionLabel}`
      statusText = countdown != null && countdown > 0
        ? `Restarting in ${countdown}s…`
        : 'Restarting now…'
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

  const percent = stage === 'verifying' || stage === 'applying'
    ? 100
    : stage === 'ready'
      ? 100
      : (progress.percent || 0)

  const isError = stage === 'error'

  // Premium dark palette — same tokens as the admin panel:
  //   bg          #0a0a0b   panel       #131316
  //   border      rgba(255,255,255,0.08)
  //   accent      reads --accent CSS variable (set by index.css and overridable
  //               via Settings.accentColor); used sparingly on action button
  //               and brand dot; rest of chrome is neutral
  //   text/sub/faint  #f5f5f6 / #a1a1aa / #6b6b73
  const ACCENT = isError ? '#ef4444' : 'var(--accent)'
  const ACCENT_HOVER = isError ? '#ef4444' : 'rgb(var(--accent-light-rgb))'
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
        {/* Brand row — small dot + brand name in muted small caps */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          marginBottom: 18,
        }}>
          <span style={{
            width: 6, height: 6, borderRadius: '50%',
            background: ACCENT,
            display: 'inline-block',
          }} />
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

        <h2 style={{
          margin: 0,
          fontSize: 22,
          letterSpacing: '-0.01em',
          fontWeight: 600,
          color: '#f5f5f6',
          lineHeight: 1.25,
        }}>
          {title}
        </h2>

        {subtitle && (
          <div style={{
            marginTop: 6,
            fontSize: 13,
            color: TEXT_SUB,
            lineHeight: 1.45,
          }}>
            {subtitle}
          </div>
        )}

        <div style={{ marginTop: 24 }}>
          <div style={{
            position: 'relative',
            height: 6,
            background: 'rgba(255,255,255,0.06)',
            border: 'none',
            borderRadius: 999,
            overflow: 'hidden',
          }}>
            <div
              style={{
                width: `${percent}%`,
                height: '100%',
                background: ACCENT,
                transition: 'width 0.3s ease-out',
                borderRadius: 999,
              }}
            />
          </div>

          <div style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'baseline',
            marginTop: 12,
            gap: 16,
          }}>
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
            <div style={{
              fontSize: 13,
              fontWeight: 600,
              color: '#f5f5f6',
              fontVariantNumeric: 'tabular-nums',
              flexShrink: 0,
            }}>
              {percent}%
            </div>
          </div>
        </div>

        {stage === 'ready' && (
          <div style={{
            marginTop: 24,
            display: 'flex',
            gap: 12,
            justifyContent: 'flex-end',
          }}>
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
                letterSpacing: 0,
                cursor: 'pointer',
                fontFamily: 'inherit',
                boxShadow: '0 1px 0 rgba(255,255,255,0.08) inset',
                transition: 'background 0.15s ease',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = ACCENT_HOVER }}
              onMouseLeave={(e) => { e.currentTarget.style.background = ACCENT }}
            >
              Restart now{countdown != null && countdown > 0 ? ` (${countdown})` : ''}
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
          {isError
            ? 'Will retry on the next check cycle'
            : 'Installation is required — please wait'}
        </div>
      </div>
    </div>
  )
}
