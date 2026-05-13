import React from 'react'
import { Minus, Square, X, HardDrive, User } from 'lucide-react'
import useStore from '../store/useStore'

function SaveLoadTitleButton({ onOpen }) {
  const slUser = typeof sessionStorage !== 'undefined' ? sessionStorage.getItem('example-cafe-sl-user') : null
  const isLoggedIn = !!slUser

  return (
    <button
      onClick={onOpen}
      className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-neon-orange/5 border border-neon-orange/15 hover:border-neon-orange/40 hover:bg-neon-orange/10 transition-all group"
      style={{ WebkitAppRegion: 'no-drag' }}
      title="Save & Load"
    >
      <HardDrive size={10} className="text-neon-orange/70 group-hover:text-neon-orange transition-colors" />
      <span className="font-orbitron text-[8px] text-neon-orange/70 group-hover:text-neon-orange uppercase tracking-[0.1em] font-bold transition-colors">
        Save & Load
      </span>
      {isLoggedIn && (
        <>
          <div className="w-px h-2.5 bg-neon-orange/20" />
          <User size={8} className="text-green-400/70" />
          <span className="font-rajdhani text-[8px] text-green-400/60 tracking-wider">{slUser}</span>
        </>
      )}
    </button>
  )
}

export default function TitleBar({ onOpenSaveLoad }) {
  const { settings, openAdmin } = useStore()
  // Hide minimize / maximize / close while kiosk is active. The admin gear
  // stays visible so the operator can still reach Settings to disable
  // kiosk; close/min/max are also blocked at the IPC level in
  // walok/electron/main.js, but hiding the UI removes the temptation.
  const kioskActive = !!settings.kioskMode

  const isElectron = typeof window !== 'undefined' && window.electronAPI

  const minimize = () => isElectron && window.electronAPI.minimize()
  const maximize = () => isElectron && window.electronAPI.maximize()
  const close = () => isElectron && window.electronAPI.close()

  const now = new Date()
  const time = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })

  const [otaVersion, setOtaVersion] = React.useState(null)
  React.useEffect(() => {
    if (!isElectron || !window.electronAPI.ota) return
    window.electronAPI.ota.getStatus()
      .then(s => { if (s && s.currentVersion) setOtaVersion(s.currentVersion) })
      .catch(() => {})
  }, [isElectron])

  return (
    <div
      className="flex items-center justify-between h-7 md:h-8 lg:h-9 px-2 md:px-3 lg:px-5 bg-dark-400/95 border-b border-neon-orange/15 flex-shrink-0"
      style={{ WebkitAppRegion: 'drag' }}
    >
      <div className="flex items-center gap-1.5 md:gap-2 lg:gap-2.5 min-w-0">
        <div className="w-1.5 h-1.5 rounded-full bg-neon-orange animate-pulse flex-shrink-0" />
        <span className="font-orbitron text-[9px] md:text-[10px] lg:text-[11px] font-black tracking-[0.2em] md:tracking-[0.25em] lg:tracking-[0.35em] uppercase flex-shrink-0"
          style={{ color: 'rgb(var(--accent-rgb))', textShadow: '0 0 8px rgb(var(--accent-rgb) / 0.5)' }}>
          EXAMPLE CAFE
        </span>
        <div className="w-px h-3 bg-neon-orange/20 flex-shrink-0" />
        <span className="font-rajdhani text-[8px] md:text-[9px] lg:text-[10px] text-white/60 uppercase tracking-[0.08em] md:tracking-[0.1em] lg:tracking-[0.15em] truncate">
          Premium Gaming Lounge
        </span>
        {otaVersion && (
          <>
            <div className="w-px h-3 bg-neon-orange/20 flex-shrink-0" />
            <span
              className="font-rajdhani text-[8px] md:text-[9px] lg:text-[10px] text-white/40 tracking-wider flex-shrink-0"
              title={`Launcher version ${otaVersion}`}
            >
              v{otaVersion}
            </span>
          </>
        )}
      </div>

      <div className="flex items-center gap-1.5 md:gap-2 lg:gap-5 flex-shrink-0">
        <SaveLoadTitleButton onOpen={onOpenSaveLoad} />
        <span className="font-rajdhani text-[9px] md:text-[10px] lg:text-[11px] text-white/60 tracking-wider hidden lg:inline">
          Welcome To {settings.launcherName}
        </span>
        <span className="font-orbitron text-[9px] md:text-[10px] lg:text-[11px] text-neon-orange font-bold tracking-wider">
          {time}
        </span>

        <button
          onClick={openAdmin}
          className="font-rajdhani text-[11px] text-white/50 hover:text-neon-orange transition-colors uppercase tracking-widest px-2"
          style={{ WebkitAppRegion: 'no-drag' }}
          title="Admin Panel"
        >
          ⚙
        </button>

        {!kioskActive && (
          <div className="flex items-center gap-0.5" style={{ WebkitAppRegion: 'no-drag' }}>
            <button
              onClick={minimize}
              className="w-7 h-7 flex items-center justify-center text-white/55 hover:text-neon-orange hover:bg-neon-orange/5 rounded transition-all"
            >
              <Minus size={11} />
            </button>
            <button
              onClick={maximize}
              className="w-7 h-7 flex items-center justify-center text-white/55 hover:text-neon-orange hover:bg-neon-orange/5 rounded transition-all"
            >
              <Square size={9} />
            </button>
            <button
              onClick={close}
              className="w-7 h-7 flex items-center justify-center text-white/55 hover:text-red-500 hover:bg-red-500/5 rounded transition-all"
            >
              <X size={11} />
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
