import React from 'react'

export default function TitleBar() {
  const handleMinimize = () => window.electronAPI?.minimizeWindow?.()
  const handleMaximize = () => window.electronAPI?.toggleMaximize?.()
  const handleClose = () => window.electronAPI?.closeWindow?.()

  return (
    <div
      className="flex items-center justify-end flex-shrink-0 select-none relative z-50"
      style={{
        height: '28px',
        background: 'rgba(10,10,11,0.8)',
        backdropFilter: 'blur(20px)',
        WebkitAppRegion: 'drag',
        borderBottom: '1px solid rgba(139,92,246,0.08)',
      }}
    >
      <div
        className="flex items-center gap-1 px-3"
        style={{ WebkitAppRegion: 'no-drag' }}
      >
        <button
          onClick={handleMinimize}
          className="w-5 h-5 rounded-full flex items-center justify-center transition-all hover:opacity-80 active:scale-90"
          style={{ background: 'rgba(255,255,255,0.08)' }}
          title="Minimize"
        >
          <svg width="8" height="1" viewBox="0 0 8 1" fill="none">
            <rect width="8" height="1" rx="0.5" fill="rgba(255,255,255,0.5)" />
          </svg>
        </button>
        <button
          onClick={handleMaximize}
          className="w-5 h-5 rounded-full flex items-center justify-center transition-all hover:opacity-80 active:scale-90"
          style={{ background: 'rgba(255,255,255,0.08)' }}
          title="Maximize"
        >
          <svg width="7" height="7" viewBox="0 0 7 7" fill="none">
            <rect x="0.5" y="0.5" width="6" height="6" rx="1" stroke="rgba(255,255,255,0.5)" />
          </svg>
        </button>
        <button
          onClick={handleClose}
          className="w-5 h-5 rounded-full flex items-center justify-center transition-all hover:bg-red-500/70 active:scale-90"
          style={{ background: 'rgba(255,255,255,0.08)' }}
          title="Close"
        >
          <svg width="7" height="7" viewBox="0 0 7 7" fill="none">
            <line x1="1" y1="1" x2="6" y2="6" stroke="rgba(255,255,255,0.5)" strokeWidth="1.2" strokeLinecap="round" />
            <line x1="6" y1="1" x2="1" y2="6" stroke="rgba(255,255,255,0.5)" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
        </button>
      </div>
    </div>
  )
}
