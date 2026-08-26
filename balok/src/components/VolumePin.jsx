import React, { useState, useEffect, useRef, useCallback } from 'react'

import { Volume2, Volume1, VolumeX } from 'lucide-react'

/* ── VolumePin ─────────────────────────────────────────────────────────────
   Pinned real-time volume control. In the packaged Electron app it drives the
   actual Windows master volume through the sysVolume bridge (applied on every
   drag tick, no debounce → instant). In the browser it falls back to setting
   the volume of every <video>/<audio> element on the page.                   */
export default function VolumePin({ accent = '#7c5cff', compact = false }) {
  const [volume, setVolume] = useState(() => {
    const v = parseInt(localStorage.getItem('balok-sys-volume') || '', 10)
    return isNaN(v) ? 60 : Math.max(0, Math.min(100, v))
  })
  const [muted, setMuted] = useState(() => localStorage.getItem('balok-sys-muted') === '1')
  const [dragging, setDragging] = useState(false)
  const lastSent = useRef(0)
  const api = typeof window !== 'undefined' ? window.electronAPI?.sysVolume : null

  // Apply to whatever audio sink is available — imperative, zero delay.
  const apply = useCallback((vol, isMuted) => {
    if (api) {
      api.set(isMuted ? 0 : vol)
      api.setMute?.(!!isMuted)
    }
    document.querySelectorAll('video, audio').forEach(el => {
      el.volume = Math.max(0, Math.min(1, vol / 100))
      el.muted = !!isMuted
    })
  }, [api])

  // Read the real OS level once on mount so the slider reflects the machine.
  useEffect(() => {
    let alive = true
    if (api?.get) {
      api.get().then(res => {
        if (!alive || !res) return
        setVolume(res.volume)
        setMuted(res.muted)
      }).catch(() => {})
    } else {
      apply(volume, muted)
    }
    return () => { alive = false }
  }, [])

  const onInput = e => {
    const v = Number(e.target.value)
    setVolume(v)
    if (muted && v > 0) setMuted(false)
    const now = performance.now()
    // Throttle the IPC to one call per animation frame-ish; the last value
    // always lands because of the trailing apply on change end.
    if (now - lastSent.current > 30) {
      lastSent.current = now
      apply(v, false)
    }
    localStorage.setItem('balok-sys-volume', String(v))
    localStorage.setItem('balok-sys-muted', '0')
  }

  const commit = () => {
    setDragging(false)
    apply(volume, muted)
  }

  const toggleMute = () => {
    const next = !muted
    setMuted(next)
    localStorage.setItem('balok-sys-muted', next ? '1' : '0')
    apply(volume, next)
  }

  const shown = muted ? 0 : volume
  const Icon = muted || volume === 0 ? VolumeX : volume < 50 ? Volume1 : Volume2

  return (
    <div className={compact ? 'flex-shrink-0' : 'px-4 pt-3 pb-1 flex-shrink-0'}>
      <div
        className={`rounded-lg flex items-center ${compact ? 'w-[132px] px-1.5 py-1 gap-1.5' : 'px-2.5 py-1.5 gap-2.5'}`}
        style={{
          background: 'rgba(24,24,27,0.8)',
          border: '1px solid rgba(255,255,255,0.05)',
          backdropFilter: 'blur(6px)',
          boxShadow: dragging
            ? `0 0 0 1px ${accent}33, 0 18px 30px -20px #000`
            : '0 18px 30px -22px #000',
          transition: 'box-shadow .18s ease',
        }}
      >
        <button
          onClick={toggleMute}
          title={muted ? 'Unmute' : 'Mute'}
          className="flex-shrink-0 w-6 h-6 rounded-md flex items-center justify-center transition-all active:scale-95"
          style={{
            background: 'transparent',
            color: muted ? accent : 'rgba(161,161,170,1)',
          }}
          onMouseEnter={e => { e.currentTarget.style.background = 'rgba(39,39,42,0.8)' }}
          onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
        >
          <Icon size={15} />
        </button>

        <div className="relative flex-grow h-5 flex items-center">
          {/* track */}
          <div
            className="absolute left-0 right-0 h-1 rounded-full pointer-events-none"
            style={{ background: 'rgb(39,39,42)' }}
          />
          {/* active track */}
          <div
            className="absolute left-0 h-1 rounded-full pointer-events-none"
            style={{
              width: `${shown}%`,
              background: muted ? 'rgba(255,255,255,0.15)' : accent,
              boxShadow: muted ? 'none' : `0 0 10px ${accent}4d`,
              transition: dragging ? 'none' : 'width .12s linear',
            }}
          />
          {/* thumb */}
          <div
            className="absolute pointer-events-none rounded-full"
            style={{
              left: `${shown}%`,
              width: 11, height: 11,
              marginLeft: -5.5,
              background: '#fff',
              border: `2px solid ${muted ? 'rgba(255,255,255,0.25)' : accent}`,
              boxShadow: '0 3px 6px -2px rgba(0,0,0,0.6)',
              transform: dragging ? 'scale(1.15)' : 'scale(1)',
              transition: 'transform .12s ease',
            }}
          />
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={shown}
            onInput={onInput}
            onChange={onInput}
            onMouseDown={() => setDragging(true)}
            onMouseUp={commit}
            onTouchStart={() => setDragging(true)}
            onTouchEnd={commit}
            aria-label="System volume"
            className="relative w-full h-5 opacity-0 cursor-pointer"
            style={{ WebkitAppearance: 'none', appearance: 'none', margin: 0 }}
          />
        </div>
      </div>
    </div>
  )
}
