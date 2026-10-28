import React, { useState, useCallback, useEffect } from 'react'
import { Search, Settings, Save, Minus, Square, X, ZoomIn, ZoomOut } from 'lucide-react'
import useStore from '../store/useStore'
import { getDefaultAccent } from '../lib/accent'
import VolumePin from './VolumePin'

function useClock() {
  const [now, setNow] = useState(new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(t)
  }, [])
  return now
}

export default function TopBar({ onSaveLoad }) {
  const { settings, searchQuery, setSearchQuery, openAdmin, otaBranding, updateSettings } = useStore()
  const zoom = settings.uiZoom || 100
  const setZoom = (z) => updateSettings({ uiZoom: Math.max(100, Math.min(200, Math.round(z / 10) * 10)) })
  const accent = settings.accentColor || getDefaultAccent()
  const [focused, setFocused] = useState(false)
  const [pkgVer, setPkgVer] = useState(null)
  const [otaVer, setOtaVer] = useState(null)
  const now = useClock()

  useEffect(() => {
    window.electronAPI?.appVersion?.().then(v => { if (v) setPkgVer(v) }).catch(() => {})
    // The OTA engine resolves the version we're REALLY running (config vs
    // bundled package.json vs last applied build). It can be newer than
    // app.getVersion(), which only reflects the exe/asar we booted from.
    const readOta = () => {
      window.electronAPI?.ota?.getStatus?.().then(s => {
        if (s && s.currentVersion) setOtaVer(s.currentVersion)
      }).catch(() => {})
    }
    readOta()
    // The OTA engine loads its config asynchronously at startup, so poll a
    // few times — otherwise an early empty status leaves the stale exe
    // version (e.g. 1.0.0) on screen for the whole session.
    const t = setInterval(readOta, 5000)
    return () => clearInterval(t)
  }, [])

  // Pick the HIGHEST of the three sources so the badge never shows a stale
  // version after an OTA update replaced the bundle.
  const version = React.useMemo(() => {
    const cmp = (a, b) => {
      const pa = String(a).split(/[.-]/), pb = String(b).split(/[.-]/)
      for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const na = parseInt(pa[i], 10) || 0, nb = parseInt(pb[i], 10) || 0
        if (na !== nb) return na - nb
      }
      return 0
    }
    const all = [otaVer, pkgVer, otaBranding?.version].filter(Boolean)
    if (all.length === 0) return null
    return all.reduce((best, v) => (cmp(v, best) > 0 ? v : best))
  }, [otaVer, pkgVer, otaBranding?.version])


  const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true })
  const dateStr = now.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })

  // Window controls
  const minimize = () => window.electronAPI?.minimizeWindow?.()
  const maximize = () => window.electronAPI?.toggleMaximize?.()
  const close    = () => window.electronAPI?.closeWindow?.()

  // 5-tap on search icon → open admin
  const tapRef = React.useRef({ count: 0, timer: null })
  const handleSearchIconTap = useCallback(() => {
    const t = tapRef.current
    t.count++
    if (t.timer) clearTimeout(t.timer)
    if (t.count >= 5) { t.count = 0; openAdmin() }
    else t.timer = setTimeout(() => { t.count = 0 }, 2000)
  }, [openAdmin])

  return (
    <div
      className="flex items-center flex-shrink-0 relative z-30"
      style={{
        height: '44px',
        background: 'var(--bg-sidebar)',
        borderBottom: '1px solid var(--border)',
        // Launcher is always maximized — no window drag region here, so a
        // click/drag on the top bar can never resize or restore the window.
        WebkitAppRegion: 'no-drag',
      }}
    >
      {/* ── Left: clock + date + version ── */}
      <div
        className="flex items-center gap-0 pl-3 flex-shrink-0"
        style={{ minWidth: 220, WebkitAppRegion: 'no-drag' }}
      >
        {/* Left accent bar */}
        <div
          className="w-0.5 h-5 rounded-full mr-3 flex-shrink-0"
          style={{ background: `linear-gradient(180deg, ${accent}, ${accent}44)` }}
        />

        {/* Two-line block */}
        <div className="flex flex-col justify-center leading-none gap-0.5">
          {/* Row 1: time */}
          <span
            className="font-syne font-black tabular-nums"
            style={{ fontSize: 14, color: 'rgba(255,255,255,0.92)', letterSpacing: '-0.01em' }}
          >
            {timeStr}
          </span>
          {/* Row 2: date + version pill inline */}
          <div className="flex items-center gap-1.5">
            <span
              className="font-jakarta"
              style={{ fontSize: 9.5, color: 'rgba(255,255,255,0.35)', letterSpacing: '0.04em', textTransform: 'uppercase' }}
            >
              {dateStr}
            </span>
            {version && (
              <>
                <span style={{ fontSize: 8, color: 'rgba(255,255,255,0.15)' }}>·</span>
                <span
                  className="font-jakarta font-bold"
                  style={{ fontSize: 9, color: accent, letterSpacing: '0.06em', opacity: 0.9 }}
                >
                  v{version}
                </span>
              </>
            )}
          </div>
        </div>
      </div>

      {/* ── Center: search ── */}
      <div className="flex-1 flex justify-center" style={{ WebkitAppRegion: 'no-drag' }}>
        <div
          className="flex items-center gap-2 px-3 rounded-lg"
          style={{
            width: 260,
            height: 28,
            background: focused ? 'rgba(255,255,255,0.07)' : 'rgba(255,255,255,0.04)',
            border: `1px solid ${focused ? accent + '45' : 'rgba(255,255,255,0.07)'}`,
            transition: 'all 0.15s ease',
            boxShadow: focused ? `0 0 0 3px ${accent}10` : 'none',
            WebkitAppRegion: 'no-drag',
          }}
        >
          <Search
            size={11}
            style={{ color: focused ? accent : 'rgba(255,255,255,0.25)', flexShrink: 0, cursor: 'default', transition: 'color 0.15s' }}
            onClick={handleSearchIconTap}
          />
          <input
            type="text"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            placeholder="Search games..."
            className="flex-1 bg-transparent text-white/75 placeholder:text-white/20 focus:outline-none min-w-0"
            style={{ fontSize: 11, WebkitAppRegion: 'no-drag', fontFamily: 'Inter, sans-serif' }}
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="flex-shrink-0 w-3.5 h-3.5 rounded-full flex items-center justify-center hover:bg-white/20 transition-colors"
              style={{ WebkitAppRegion: 'no-drag' }}
            >
              <X size={8} style={{ color: 'rgba(255,255,255,0.4)' }} />
            </button>
          )}
        </div>
      </div>

      {/* ── Right: zoom + actions + window controls ── */}
      <div
        className="flex items-center gap-0.5 pr-2 flex-shrink-0"
        style={{ WebkitAppRegion: 'no-drag', minWidth: 220, justifyContent: 'flex-end' }}
      >
        {/* Zoom out / level / zoom in — scales the game list cards only */}
        <div
          className="flex flex-shrink-0 items-center gap-0.5 mr-1 rounded-lg px-0.5"
          style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)' }}
        >
          <button
            onClick={() => setZoom(zoom - 10)}
            disabled={zoom <= 100}
            title="Smaller game cards"
            className="w-6 h-6 rounded-md flex items-center justify-center transition-all hover:bg-white/10 disabled:opacity-25"
            style={{ WebkitAppRegion: 'no-drag' }}
          >
            <ZoomOut size={11} style={{ color: 'rgba(255,255,255,0.55)' }} />
          </button>
          <button
            onClick={() => setZoom(100)}
            title="Reset card size"
            className="font-jakarta font-semibold tabular-nums px-1 transition-colors hover:text-white"
            style={{ fontSize: 9.5, color: zoom === 100 ? 'rgba(255,255,255,0.35)' : accent, WebkitAppRegion: 'no-drag' }}
          >
            {zoom}%
          </button>
          <button
            onClick={() => setZoom(zoom + 10)}
            disabled={zoom >= 200}
            title="Bigger game cards"
            className="w-6 h-6 rounded-md flex items-center justify-center transition-all hover:bg-white/10 disabled:opacity-25"
            style={{ WebkitAppRegion: 'no-drag' }}
          >
            <ZoomIn size={11} style={{ color: 'rgba(255,255,255,0.55)' }} />
          </button>
        </div>

        <VolumePin accent={accent} compact />

          <button
            onClick={onSaveLoad}
            className="w-7 h-7 flex-shrink-0 rounded-lg flex items-center justify-center transition-all hover:bg-white/10"
            title="Save & Load"
            aria-label="Save & Load"
            style={{ WebkitAppRegion: 'no-drag' }}
          >
            <Save size={12} style={{ color: 'rgba(255,255,255,0.4)' }} />
          </button>
        <button
          onClick={openAdmin}
          className="w-7 h-7 flex-shrink-0 rounded-lg flex items-center justify-center transition-all hover:bg-white/10"
          title="Admin Panel"
          aria-label="Open Admin Panel"
          style={{ WebkitAppRegion: 'no-drag', color: accent }}
        >
          <Settings size={13} style={{ color: accent }} />
        </button>

        {/* Divider */}
        <div className="w-px h-4 mx-1.5" style={{ background: 'rgba(255,255,255,0.08)' }} />


        {/* Window controls */}
        <button
          onClick={minimize}
          className="w-7 h-7 flex-shrink-0 rounded-md flex items-center justify-center transition-all hover:bg-white/10"
          style={{ WebkitAppRegion: 'no-drag' }}
        >
          <Minus size={10} style={{ color: 'rgba(255,255,255,0.45)' }} />
        </button>
        <button
          onClick={maximize}
          className="w-7 h-7 flex-shrink-0 rounded-md flex items-center justify-center transition-all hover:bg-white/10"
          style={{ WebkitAppRegion: 'no-drag' }}
        >
          <Square size={9} style={{ color: 'rgba(255,255,255,0.45)' }} />
        </button>
        <button
          onClick={close}
          className="w-7 h-7 flex-shrink-0 rounded-md flex items-center justify-center transition-all hover:bg-red-500/75 group"
          style={{ WebkitAppRegion: 'no-drag' }}
        >
          <X size={11} style={{ color: 'rgba(255,255,255,0.45)' }} className="group-hover:text-white" />
        </button>
      </div>
    </div>
  )
}
