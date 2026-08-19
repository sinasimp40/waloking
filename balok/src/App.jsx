import React, { useEffect, useState } from 'react'
import { Toaster } from 'react-hot-toast'
import useStore from './store/useStore'
import LeftSidebar from './components/LeftSidebar'
import TopBar from './components/TopBar'
import MainContent from './components/MainContent'
import RightPanel from './components/RightPanel'
import AdminPanel from './components/AdminPanel'
import AdminLogin from './components/AdminLogin'
import SaveLoadModal from './components/SaveLoadModal'
import UpdateModal from './components/UpdateModal'
import IPTVPlayer from './components/IPTVPlayer'

function hexToRgb(hex) {
  const h = hex.replace('#', '')
  const num = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16)
  return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 }
}

function useIdleDetection(ms = 30000) {
  useEffect(() => {
    let timer = null
    const goIdle = () => document.documentElement.classList.add('app-idle')
    const wake = () => {
      document.documentElement.classList.remove('app-idle')
      clearTimeout(timer)
      timer = setTimeout(goIdle, ms)
    }
    const evts = ['mousemove','mousedown','keydown','touchstart','scroll','wheel']
    evts.forEach(e => window.addEventListener(e, wake, { passive: true }))
    timer = setTimeout(goIdle, ms)
    return () => { clearTimeout(timer); evts.forEach(e => window.removeEventListener(e, wake)) }
  }, [ms])
}

export default function App() {
  const store = useStore()
  window.useStore = useStore
  const { isAdminOpen, isAdminAuthenticated, settings, updateSettings, isIPTVOpen } = store
  const [showSaveLoad, setShowSaveLoad] = useState(false)
  const setLocalIP = useStore(s => s.setLocalIP)
  const setOtaBranding = useStore(s => s.setOtaBranding)
  const otaBranding = useStore(s => s.otaBranding)
  const accentColor = settings.accentColor

  // Window title = brand name. This is what Windows shows in the taskbar,
  // Alt-Tab, and Task Manager — without it the hardcoded <title> from
  // index.html ("BALOK") leaks through on customer builds.
  useEffect(() => {
    const t = settings.launcherName || otaBranding?.brandName
    if (t) document.title = t
  }, [settings.launcherName, otaBranding?.brandName])

  useIdleDetection(20000)

  // Load the per-customer branding baked into the build (ota-config.json):
  // brand name, subtitle, logo. Electron IPC in the packaged app; HTTP fetch
  // as a browser-preview fallback (file:// fetch is blocked by Chromium).
  useEffect(() => {
    let cancelled = false
    const apply = (cfg) => { if (!cancelled && cfg && (cfg.brandName || cfg.subtitle || cfg.logoFile)) setOtaBranding(cfg) }
    if (window.electronAPI?.getOtaConfig) {
      window.electronAPI.getOtaConfig().then(apply).catch(() => {})
    } else {
      fetch('ota-config.json')
        .then(r => (r.ok && (r.headers.get('content-type') || '').includes('json')) ? r.json() : null)
        .then(apply)
        .catch(() => {})
    }
    return () => { cancelled = true }
  }, [setOtaBranding])

  // Apply accent color CSS vars
  useEffect(() => {
    const root = document.documentElement
    const color = accentColor || '#3DFF6E'
    const { r, g, b } = hexToRgb(color)
    root.style.setProperty('--accent', color)
    root.style.setProperty('--accent-rgb', `${r} ${g} ${b}`)
    root.style.setProperty('--accent-dim', `rgb(${Math.round(r*0.7)} ${Math.round(g*0.7)} ${Math.round(b*0.7)})`)
  }, [accentColor])

  // Zoom scaling — default is always 100% (min 100%, max 200%)
  useEffect(() => {
    if (!localStorage.getItem('balok-zoom-100-default')) {
      updateSettings({ uiZoom: 100 })
      localStorage.setItem('balok-zoom-100-default', '1')
      localStorage.setItem('balok-zoom-set', '1')
    }
  }, [])



  // Mark ready
  useEffect(() => {
    const t = setTimeout(() => document.body.classList.add('app-ready'), 100)
    return () => clearTimeout(t)
  }, [])

  // Local IP detection
  useEffect(() => {
    if (window.electronAPI?.getLocalIPs) {
      window.electronAPI.getLocalIPs().then(({ ips, hostname }) => setLocalIP(ips, hostname)).catch(() => {})
    }
  }, [])

  // OTA update — UpdateModal is self-managed and listens to the ota:* events
  // broadcast by electron/updater.js (walok parity).



  // Custom wallpaper from Admin > Appearance. When set, the main surface
  // colors are overridden with translucent versions (children read the CSS
  // vars) so the wallpaper shows through behind the whole launcher.
  // Normalize backslashes: settings saved on Windows before select-image
  // started normalizing paths contain file:///C:\... — and \ is an escape
  // character inside CSS url("...") strings, silently breaking the URL.
  const wallpaper = settings.background ? settings.background.replace(/\\/g, '/') : null

  return (
    <div
      className="flex flex-col w-full h-full overflow-hidden relative"
      style={{
        background: 'var(--bg-base)',
        // When wallpaper is on, only the center content becomes translucent.
        // Sidebars keep their solid colours so the wallpaper shows through
        // the middle only.
        ...(wallpaper ? {
          '--bg-base': 'rgba(10,10,10,0.55)',
        } : {}),
      }}
    >
      {wallpaper && (
        <div
          aria-hidden
          className="absolute inset-0 pointer-events-none"
          style={{
            backgroundImage: `url("${wallpaper}")`,
            backgroundSize: 'cover',
            backgroundPosition: 'center',
          }}
        />
      )}
      {/* Inner shell — zoom no longer scales the whole UI, only game cards */}
      <div style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        position: 'relative',
        zIndex: 1,
      }}>
        {/* Top bar (titlebar + search + category tabs) */}
        <TopBar onSaveLoad={() => setShowSaveLoad(true)} />

        {/* Main 3-column layout */}
        <div className="flex flex-1 overflow-hidden">
          {/* Left sidebar */}
          <LeftSidebar />

          {/* Center content */}
          <MainContent />

          {/* Right panel */}
          <RightPanel />
        </div>
      </div>

      {/* Modals */}
      {isAdminOpen && !isAdminAuthenticated && <AdminLogin />}
      {isAdminOpen && isAdminAuthenticated && <AdminPanel />}
      {showSaveLoad && <SaveLoadModal onClose={() => setShowSaveLoad(false)} />}
      {isIPTVOpen && <IPTVPlayer />}
      <UpdateModal />

      <Toaster
        position="bottom-right"
        toastOptions={{
          duration: 3000,
          className: 'balok-toast',
          style: {
            background: '#1A1A1A',
            color: '#E8E8E8',
            border: '1px solid rgba(255,255,255,0.1)',
          },
        }}
      />
    </div>
  )
}
