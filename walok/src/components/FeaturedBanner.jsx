import React, { useRef, useEffect, useState } from 'react'
import useStore from '../store/useStore'

const SCRAMBLE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#@!$%&'

function useScrambleText(text) {
  const [display, setDisplay] = useState(text)
  const timerRef = useRef(null)

  useEffect(() => {
    if (!text) return

    let iteration = 0
    const totalFrames = text.length * 3

    const animate = () => {
      iteration++
      const result = text.split('').map((char, i) => {
        if (char === ' ') return ' '
        if (i < Math.floor(iteration / 3)) return char
        return SCRAMBLE_CHARS[Math.floor(Math.random() * SCRAMBLE_CHARS.length)]
      }).join('')
      setDisplay(result)
      if (iteration < totalFrames) {
        timerRef.current = setTimeout(animate, 40)
      } else {
        setDisplay(text)
      }
    }

    timerRef.current = setTimeout(animate, 500)
    return () => {
      clearTimeout(timerRef.current)
    }
  }, [text])

  return display
}

function BannerCanvas() {
  return (
    <div className="absolute inset-0 overflow-hidden">
      <div
        className="absolute inset-0"
        style={{
          backgroundImage: `
            linear-gradient(to right, rgb(var(--accent-rgb) / 0.06) 1px, transparent 1px),
            linear-gradient(to bottom, rgb(var(--accent-rgb) / 0.06) 1px, transparent 1px)
          `,
          backgroundSize: '60px 30px',
        }}
      />
      <div
        className="absolute w-40 h-40 rounded-full"
        style={{
          right: '20%',
          top: '20%',
          background: 'radial-gradient(circle, rgb(var(--accent-rgb) / 0.06) 0%, transparent 70%)',
          filter: 'blur(20px)',
        }}
      />
    </div>
  )
}

export default function FeaturedBanner() {
  const settings = useStore(s => s.settings)

  return (
    <div className="relative h-24 md:h-28 lg:h-36 overflow-hidden border-b border-neon-orange/15 flex-shrink-0">
      <div className="absolute inset-0">
        <div
          className="w-full h-full bg-cover bg-center opacity-50"
          style={{
            backgroundImage: settings.background
              ? `url(${settings.background})`
              : 'none'
          }}
        />
      </div>

      <div className="absolute inset-0 bg-dark-500/60" />
      <div className="absolute inset-0 bg-gradient-to-r from-dark-500/60 via-dark-500/20 to-dark-500/50" />
      <div className="absolute inset-0 bg-gradient-to-b from-white/[0.03] via-transparent to-dark-500/80" />

      <BannerCanvas />

      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-neon-orange/40 to-transparent" />
        <div className="absolute bottom-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-neon-orange/20 to-transparent" />
        <div className="absolute top-0 left-0 bottom-0 w-px bg-gradient-to-b from-neon-orange/20 via-transparent to-neon-orange/10" />
        <div className="absolute top-0 right-0 bottom-0 w-px bg-gradient-to-b from-neon-orange/10 via-transparent to-neon-orange/20" />
      </div>

      <div className="relative z-20 h-full flex items-center px-3 md:px-4 lg:px-6">
        <div className="flex items-center gap-2 md:gap-3 lg:gap-5 flex-1 min-w-0">
          <div className="relative flex-shrink-0">
            <div className="w-1 md:w-1.5 h-10 md:h-12 lg:h-16 bg-gradient-to-b from-neon-orange via-neon-orange/60 to-transparent rounded-full" />
            <div className="absolute inset-0 w-1 md:w-1.5 h-10 md:h-12 lg:h-16 bg-gradient-to-b from-neon-orange via-neon-orange/60 to-transparent rounded-full blur-md" />
          </div>

          <BannerTitle settings={settings} />
        </div>

        {settings.bannerImage && (
          <div className="absolute right-3 md:right-4 lg:right-6 bottom-0 h-full flex items-end pointer-events-none">
            <img
              src={settings.bannerImage}
              alt="Banner"
              className="max-h-[80px] md:max-h-[100px] lg:max-h-[140px] w-auto object-contain"
              loading="lazy"
              decoding="async"
              style={{ filter: 'drop-shadow(0 0 20px rgb(var(--accent-rgb) / 0.3))' }}
            />
          </div>
        )}
      </div>

      <div className="absolute top-2 right-3 z-30">
        <div className="w-6 h-6 border-t-2 border-r-2 border-neon-orange/50 rounded-tr-sm" />
      </div>
      <div className="absolute bottom-2 left-3 z-30">
        <div className="w-6 h-6 border-b-2 border-l-2 border-neon-orange/50 rounded-bl-sm" />
      </div>
      <div className="absolute top-2 left-3 z-30">
        <div className="w-3 h-3 border-t border-l border-neon-orange/35" />
      </div>
      <div className="absolute bottom-2 right-3 z-30">
        <div className="w-3 h-3 border-b border-r border-neon-orange/35" />
      </div>
    </div>
  )
}

function BannerTitle({ settings }) {
  const name = (settings.launcherName || 'EXAMPLE CAFE').toUpperCase()
  const scrambled = useScrambleText(name)

  return (
    <div className="min-w-0 flex-1">
      <h1
        className="font-orbitron font-black text-xl md:text-2xl lg:text-4xl leading-none tracking-[0.15em] lg:tracking-[0.2em] whitespace-nowrap overflow-hidden text-ellipsis"
        style={{
          color: 'rgb(var(--accent-rgb))',
          textShadow: '0 0 20px rgb(var(--accent-rgb) / 0.5), 0 0 60px rgb(var(--accent-rgb) / 0.2), 0 2px 4px rgba(0,0,0,0.8)',
          fontVariantNumeric: 'tabular-nums',
          fontFeatureSettings: '"tnum"',
        }}
      >
        <span style={{ display: 'inline-block', minWidth: `${name.length * 0.75}em` }}>{scrambled}</span>
      </h1>

      <p className="font-rajdhani text-white/65 text-[9px] md:text-[10px] lg:text-xs tracking-[0.15em] md:tracking-[0.2em] lg:tracking-[0.3em] uppercase mt-1 lg:mt-1.5 truncate max-w-[200px] md:max-w-[280px] lg:max-w-none">
        {settings.launcherTagline || 'JUST SIT. PLAY. RELAX & ENJOY'}
      </p>

      <div className="flex gap-1.5 md:gap-2 lg:gap-2.5 mt-1.5 md:mt-2 lg:mt-3">
        <div className="flex items-center gap-1 md:gap-1.5 px-1.5 md:px-2 lg:px-3 py-0.5 md:py-1 bg-neon-orange/10 border border-neon-orange/25 rounded-md backdrop-blur-sm">
          <span className="relative flex h-1.5 w-1.5 md:h-2 md:w-2">
            <span className="relative inline-flex rounded-full h-1.5 w-1.5 md:h-2 md:w-2 bg-neon-orange" style={{ boxShadow: '0 0 6px rgb(var(--accent-rgb))' }} />
          </span>
          <span className="text-neon-orange text-[8px] md:text-[9px] lg:text-[10px] font-orbitron font-bold tracking-wider">ONLINE</span>
        </div>

        <div className="relative flex items-center gap-1 md:gap-1.5 lg:gap-2 px-1.5 md:px-2.5 lg:px-3.5 py-0.5 md:py-1 rounded-md overflow-hidden group cursor-default">
          <div className="absolute inset-0 bg-gradient-to-r from-amber-500/20 via-yellow-400/15 to-amber-500/20 border border-amber-400/40 rounded-md" />
          <div className="absolute inset-0 bg-gradient-to-r from-amber-500/10 to-yellow-300/10 opacity-0 group-hover:opacity-100 transition-opacity duration-500 rounded-md" />
          <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-yellow-300/60 to-transparent" />
          <div className="absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-amber-500/30 to-transparent" />
          <span className="relative text-[8px] md:text-[9px]">⭐</span>
          <span className="relative text-[8px] md:text-[9px] lg:text-[10px] font-orbitron font-black tracking-widest"
            style={{ color: '#f59e0b', textShadow: '0 0 10px rgba(245,158,11,0.6), 0 0 20px rgba(245,158,11,0.2)' }}
          >
            PREMIUM
          </span>
          <div className="absolute -inset-1 rounded-md opacity-0 group-hover:opacity-100 transition-opacity duration-500"
            style={{ boxShadow: '0 0 12px rgba(245,158,11,0.15)' }}
          />
        </div>
      </div>
    </div>
  )
}
