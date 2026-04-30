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
      title = 'UPDATE INCOMING'
      subtitle = 'A new version has been detected'
      statusText = 'Preparing download...'
      break
    case 'downloading':
      title = 'DOWNLOADING UPDATE'
      subtitle = `v${currentVersion} → v${versionLabel}`
      statusText = `${fmtBytes(progress.downloaded)} / ${fmtBytes(progress.total)}` + (speed > 0 ? `  •  ${fmtBytes(speed)}/s` : '')
      break
    case 'verifying':
      title = 'VERIFYING INTEGRITY'
      subtitle = `v${versionLabel}`
      statusText = 'Checking SHA-256 signature...'
      break
    case 'applying':
      title = 'APPLYING UPDATE'
      subtitle = `v${versionLabel}`
      statusText = 'Staging files for next launch...'
      break
    case 'ready':
      title = 'UPDATE READY'
      subtitle = `v${currentVersion} → v${versionLabel}`
      statusText = countdown != null && countdown > 0
        ? `Restarting in ${countdown}s...`
        : 'Restarting now...'
      break
    case 'error':
      title = 'UPDATE FAILED'
      subtitle = 'Will retry automatically'
      statusText = errorMsg
      break
    default:
      title = 'UPDATE'
      subtitle = ''
      statusText = ''
  }

  const percent = stage === 'verifying' || stage === 'applying'
    ? 100
    : stage === 'ready'
      ? 100
      : (progress.percent || 0)

  const isError = stage === 'error'

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 99999,
        background: 'rgba(5, 3, 0, 0.92)',
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: '"Segoe UI", "Rajdhani", sans-serif',
      }}
    >
      <div
        style={{
          width: '90%',
          maxWidth: 580,
          background: 'linear-gradient(135deg, #100806 0%, #1a0c05 100%)',
          border: `2px solid ${isError ? '#ff3030' : '#ff6a00'}`,
          borderRadius: 12,
          padding: '36px 40px',
          boxShadow: isError
            ? '0 0 60px rgba(255, 48, 48, 0.4), inset 0 0 30px rgba(255, 48, 48, 0.08)'
            : '0 0 60px rgba(255, 106, 0, 0.5), inset 0 0 30px rgba(255, 106, 0, 0.08)',
          color: '#fff',
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            position: 'absolute',
            top: 0, left: 0, right: 0, height: 3,
            background: isError
              ? 'linear-gradient(90deg, transparent, #ff3030, transparent)'
              : 'linear-gradient(90deg, transparent, #ff6a00, #ffb070, #ff6a00, transparent)',
            backgroundSize: '200% 100%',
            animation: 'ota-scan 2.5s linear infinite',
          }}
        />

        <div style={{
          fontSize: 11,
          letterSpacing: 4,
          color: isError ? '#ff8080' : '#ffaa66',
          marginBottom: 8,
          textTransform: 'uppercase',
          fontWeight: 600,
        }}>
          {brand ? `// ${brand} OTA SYSTEM //` : '// OTA SYSTEM //'}
        </div>

        <h2 style={{
          margin: 0,
          fontSize: 32,
          letterSpacing: 3,
          fontWeight: 800,
          color: isError ? '#ff5050' : '#ff6a00',
          textShadow: isError
            ? '0 0 20px rgba(255, 80, 80, 0.6)'
            : '0 0 20px rgba(255, 106, 0, 0.6)',
          fontFamily: '"Rajdhani", "Segoe UI", sans-serif',
        }}>
          {title}
        </h2>

        {subtitle && (
          <div style={{
            marginTop: 6,
            fontSize: 15,
            color: '#ddd',
            letterSpacing: 1,
            opacity: 0.9,
          }}>
            {subtitle}
          </div>
        )}

        <div style={{ marginTop: 28 }}>
          <div style={{
            position: 'relative',
            height: 26,
            background: '#1a0e08',
            border: '1px solid #3a1f0e',
            borderRadius: 4,
            overflow: 'hidden',
          }}>
            <div
              style={{
                width: `${percent}%`,
                height: '100%',
                background: isError
                  ? 'linear-gradient(90deg, #6a1010 0%, #ff3030 50%, #ff6060 100%)'
                  : 'linear-gradient(90deg, #6a3500 0%, #ff6a00 50%, #ffb070 100%)',
                transition: 'width 0.3s ease-out',
                boxShadow: isError
                  ? 'inset 0 0 12px rgba(255, 200, 200, 0.3), 0 0 18px rgba(255, 48, 48, 0.6)'
                  : 'inset 0 0 12px rgba(255, 220, 200, 0.3), 0 0 18px rgba(255, 106, 0, 0.6)',
              }}
            />
            {!isError && stage === 'downloading' && (
              <div
                style={{
                  position: 'absolute',
                  top: 0, bottom: 0, left: 0,
                  width: '100%',
                  background: 'linear-gradient(90deg, transparent 0%, rgba(255, 220, 180, 0.15) 50%, transparent 100%)',
                  animation: 'ota-shimmer 1.6s linear infinite',
                  pointerEvents: 'none',
                }}
              />
            )}
            <div style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 13,
              fontWeight: 700,
              letterSpacing: 2,
              color: '#fff',
              textShadow: '0 0 6px rgba(0,0,0,0.8)',
              pointerEvents: 'none',
            }}>
              {percent}%
            </div>
          </div>

          <div style={{
            marginTop: 14,
            fontSize: 13,
            color: isError ? '#ffb0b0' : '#ffcca0',
            fontFamily: '"Consolas", "Courier New", monospace',
            letterSpacing: 0.5,
            minHeight: 18,
            wordBreak: 'break-word',
          }}>
            {statusText}
          </div>
        </div>

        {stage === 'ready' && (
          <div style={{
            marginTop: 28,
            display: 'flex',
            gap: 12,
            justifyContent: 'flex-end',
          }}>
            <button
              onClick={() => { try { window.electronAPI?.ota?.restart() } catch (e) {} }}
              style={{
                background: 'linear-gradient(135deg, #ff6a00 0%, #ff8c30 100%)',
                color: '#fff',
                border: 'none',
                padding: '12px 28px',
                borderRadius: 4,
                fontWeight: 800,
                fontSize: 14,
                letterSpacing: 2,
                cursor: 'pointer',
                textTransform: 'uppercase',
                boxShadow: '0 0 20px rgba(255, 106, 0, 0.5)',
              }}
            >
              RESTART NOW {countdown != null && countdown > 0 ? `(${countdown})` : ''}
            </button>
          </div>
        )}

        <div style={{
          marginTop: 24,
          paddingTop: 14,
          borderTop: '1px solid #3a1f0e',
          fontSize: 10,
          letterSpacing: 1.5,
          color: '#664433',
          textTransform: 'uppercase',
          textAlign: 'center',
        }}>
          {isError
            ? 'WILL RETRY ON NEXT CHECK CYCLE'
            : 'INSTALLATION IS MANDATORY • PLEASE WAIT'}
        </div>
      </div>

      <style>{`
        @keyframes ota-scan {
          0% { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
        @keyframes ota-shimmer {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(100%); }
        }
      `}</style>
    </div>
  )
}
