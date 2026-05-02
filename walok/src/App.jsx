import React, { useEffect, useState } from 'react'
import { Toaster } from 'react-hot-toast'
import useStore from './store/useStore'
import TitleBar from './components/TitleBar'
import Sidebar from './components/Sidebar'
import Header from './components/Header'
import FeaturedBanner from './components/FeaturedBanner'
import FeaturedSlider from './components/FeaturedSlider'
import GameGrid from './components/GameGrid'
import AdminPanel from './components/AdminPanel'
import AdminLogin from './components/AdminLogin'
import ParticleBackground from './components/ParticleBackground'
import SaveLoadModal from './components/SaveLoadModal'
import UpdateModal from './components/UpdateModal'

function hexToRgb(hex) {
  const h = hex.replace('#', '')
  const num = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16)
  return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 }
}

function darkenHex(hex, amount = 0.2) {
  const { r, g, b } = hexToRgb(hex)
  return `${Math.round(r * (1 - amount))} ${Math.round(g * (1 - amount))} ${Math.round(b * (1 - amount))}`
}

function lightenHex(hex, amount = 0.2) {
  const { r, g, b } = hexToRgb(hex)
  return `${Math.min(255, Math.round(r + (255 - r) * amount))} ${Math.min(255, Math.round(g + (255 - g) * amount))} ${Math.min(255, Math.round(b + (255 - b) * amount))}`
}

function useIdleDetection(timeoutMs = 30000) {
  const [isIdle, setIsIdle] = useState(false)

  useEffect(() => {
    let timer = null

    const goIdle = () => {
      setIsIdle(true)
      document.documentElement.classList.add('app-idle')
    }

    const resetTimer = () => {
      if (timer) clearTimeout(timer)
      if (document.documentElement.classList.contains('app-idle')) {
        setIsIdle(false)
        document.documentElement.classList.remove('app-idle')
      }
      timer = setTimeout(goIdle, timeoutMs)
    }

    const events = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll', 'wheel']
    events.forEach(e => window.addEventListener(e, resetTimer, { passive: true }))

    timer = setTimeout(goIdle, timeoutMs)

    return () => {
      if (timer) clearTimeout(timer)
      events.forEach(e => window.removeEventListener(e, resetTimer))
      document.documentElement.classList.remove('app-idle')
    }
  }, [timeoutMs])

  return isIdle
}

export default function App() {
  const { isAdminOpen, isAdminAuthenticated, settings, updateSettings } = useStore()
  const [showSaveLoad, setShowSaveLoad] = React.useState(false)

  const setLocalIP = useStore(s => s.setLocalIP)
  const accentColor = settings.accentColor

  useIdleDetection(10000)

  useEffect(() => {
    const root = document.documentElement
    if (!accentColor) {
      root.style.removeProperty('--accent')
      root.style.removeProperty('--accent-rgb')
      root.style.removeProperty('--accent-dark-rgb')
      root.style.removeProperty('--accent-light-rgb')
      return
    }
    const { r, g, b } = hexToRgb(accentColor)
    root.style.setProperty('--accent', accentColor)
    root.style.setProperty('--accent-rgb', `${r} ${g} ${b}`)
    root.style.setProperty('--accent-dark-rgb', darkenHex(accentColor, 0.2))
    root.style.setProperty('--accent-light-rgb', lightenHex(accentColor, 0.2))
  }, [accentColor])

  useEffect(() => {
    const screenW = window.screen.width
    let autoZoom = 100
    if (screenW >= 2560) autoZoom = 120
    else if (screenW >= 1920) autoZoom = 110

    autoZoom = Math.max(100, Math.min(200, autoZoom))

    if (!localStorage.getItem('example-cafe-zoom-set')) {
      updateSettings({ uiZoom: autoZoom })
      localStorage.setItem('example-cafe-zoom-set', '1')
    }
  }, [])

  useEffect(() => {
    async function detectIP() {
      if (window.electronAPI?.getLocalIP) {
        try {
          const result = await window.electronAPI.getLocalIP()
          if (result.success) {
            setLocalIP(result.ips, result.hostname)
          }
        } catch (e) {}
      }
    }
    detectIP()
  }, [setLocalIP])

  return (
    <div className="relative w-screen h-screen overflow-hidden">
      {settings.background && (
        <div
          className="absolute inset-0 bg-cover bg-center"
          style={{ backgroundImage: `url("${settings.background.replace(/\\/g, '/').replace(/"/g, '\\"')}")` }}
        />
      )}

      <div className="absolute inset-0 bg-dark-500/75" />

      <ParticleBackground />

      <div className="absolute inset-0 grid-bg pointer-events-none" />

      <div className="relative z-10 flex flex-col h-full">
        <TitleBar onOpenSaveLoad={() => setShowSaveLoad(true)} />

        <div className="flex flex-1 overflow-hidden">
          <Sidebar />

          <div className="flex-1 flex flex-col overflow-hidden">
            <Header />
            <FeaturedBanner />
            <FeaturedSlider />
            <GameGrid />
          </div>
        </div>

        <BottomBar />
      </div>

      {isAdminOpen && !isAdminAuthenticated && <AdminLogin />}
      {isAdminOpen && isAdminAuthenticated && <AdminPanel />}
      {showSaveLoad && <SaveLoadModal onClose={() => setShowSaveLoad(false)} />}

      <UpdateModal />

      <Toaster
        position="top-right"
        toastOptions={{
          style: {
            background: '#0a0806',
            color: `rgb(var(--accent-rgb))`,
            border: '1px solid rgb(var(--accent-rgb) / 0.3)',
            fontFamily: 'Rajdhani, sans-serif',
            fontSize: '14px',
          },
          success: { iconTheme: { primary: accentColor, secondary: '#050403' } },
          error: { iconTheme: { primary: '#ff4444', secondary: '#050403' } },
        }}
      />
    </div>
  )
}

function BottomBar() {
  const brands = [
    'APEX LEGENDS', 'PUBG', 'LEAGUE OF LEGENDS', 'VALORANT', 'DOTA 2',
    'ROBLOX', 'WARZONE', 'OVERWATCH 2', 'CS2', 'ROCKET LEAGUE',
    'FORTNITE', 'GTA V', 'MINECRAFT', 'FIFA', 'GENSHIN IMPACT',
    'CALL OF DUTY', 'TEKKEN 8', 'STREET FIGHTER 6'
  ]

  const allBrands = [...brands, ...brands, ...brands]

  return (
    <div className="relative h-7 bg-dark-400/95 border-t border-neon-orange/20 flex items-center overflow-hidden flex-shrink-0">
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-neon-orange/30 to-transparent" />
      <div className="marquee-container">
        <div className="marquee-content">
          {allBrands.map((name, i) => (
            <span key={i} className="flex items-center gap-3 whitespace-nowrap">
              <span className="text-[9px] font-orbitron font-bold tracking-[0.2em] text-neon-orange/70 uppercase">
                {name}
              </span>
              <span className="text-neon-orange/30 text-[8px]">◆</span>
            </span>
          ))}
        </div>
      </div>
      <style>{`
        .marquee-container {
          width: 100%;
          overflow: hidden;
        }
        .marquee-content {
          display: flex;
          gap: 3rem;
          width: max-content;
          animation: smoothMarquee 90s linear infinite;
          will-change: transform;
        }
        @keyframes smoothMarquee {
          0% { transform: translateX(0); }
          100% { transform: translateX(-33.333%); }
        }
      `}</style>
    </div>
  )
}
