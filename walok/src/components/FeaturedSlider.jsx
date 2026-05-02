import React, { useEffect, useMemo, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { ChevronLeft, ChevronRight, Play } from 'lucide-react'
import toast from 'react-hot-toast'
import useStore from '../store/useStore'

const ROTATE_MS = 6000

function NetflixSlide({ svc, onLaunch }) {
  return (
    <div className="absolute inset-0 cursor-pointer" onClick={() => onLaunch(svc)}>
      <div className="absolute inset-0" style={{ background: 'linear-gradient(110deg, #0a0103 0%, #1a0306 35%, #4a0810 70%, #e50914 100%)' }} />
      <div className="absolute inset-0" style={{ background: 'radial-gradient(ellipse at 80% 50%, rgba(229,9,20,0.45) 0%, transparent 60%)' }} />
      <div
        className="absolute inset-0 opacity-15 pointer-events-none"
        style={{
          backgroundImage: 'repeating-linear-gradient(0deg, rgba(0,0,0,0.6) 0px, rgba(0,0,0,0.6) 1px, transparent 1px, transparent 3px)',
        }}
      />

      <div className="relative h-full flex items-center px-4 md:px-6 lg:px-10 gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1.5">
            <span className="text-[8px] md:text-[9px] tracking-[0.3em] px-1.5 md:px-2 py-0.5 rounded font-orbitron font-bold"
              style={{ background: 'rgba(229,9,20,0.25)', color: '#ff5560', border: '1px solid #e50914' }}>
              STREAMING
            </span>
            <span className="text-[8px] md:text-[9px] tracking-[0.25em] text-white/55 font-orbitron uppercase">Auto signed in</span>
          </div>
          <h2 className="font-orbitron font-black text-lg md:text-2xl lg:text-3xl leading-tight text-white tracking-wide truncate">
            Movies, shows & more.
          </h2>
          <p className="text-[10px] md:text-xs lg:text-sm text-white/75 mt-1 font-rajdhani truncate">
            Pick up where you left off — right inside the launcher.
          </p>
          <div className="flex items-center gap-2 mt-2 md:mt-3">
            <button
              onClick={(e) => { e.stopPropagation(); onLaunch(svc) }}
              className="flex items-center gap-1.5 px-3 md:px-4 h-7 md:h-8 lg:h-9 rounded-md text-[10px] md:text-xs font-bold tracking-wide bg-white text-[#e50914] hover:bg-white/95 transition"
            >
              <Play size={10} fill="#e50914" />
              <span>Open Netflix</span>
            </button>
          </div>
        </div>

        <div className="relative flex-shrink-0 hidden md:flex items-center justify-center"
          style={{ width: 96, height: 96 }}>
          <div className="absolute inset-0 rounded-full" style={{ background: 'radial-gradient(circle, rgba(229,9,20,0.55) 0%, transparent 70%)', filter: 'blur(18px)' }} />
          <span
            className="relative font-black select-none"
            style={{
              color: '#fff',
              fontFamily: 'Impact, "Arial Black", "Helvetica Neue", sans-serif',
              fontSize: '34px',
              letterSpacing: '0.04em',
              textShadow: '0 0 14px rgba(229,9,20,0.9), 0 0 28px rgba(229,9,20,0.6)',
            }}
          >
            N
          </span>
        </div>
      </div>
    </div>
  )
}

function GameSlide({ game, onLaunch }) {
  const accent = 'rgb(var(--accent-rgb))'
  return (
    <div className="absolute inset-0 cursor-pointer" onClick={() => onLaunch(game)}>
      <div className="absolute inset-0" style={{ background: 'linear-gradient(110deg, #0a0a0e 0%, #14141c 40%, #1a1a24 100%)' }} />
      {game.icon && (
        <div
          className="absolute inset-0 opacity-30"
          style={{
            backgroundImage: `url(${game.icon})`,
            backgroundSize: 'cover',
            backgroundPosition: 'center',
            filter: 'blur(20px)',
          }}
        />
      )}
      <div className="absolute inset-0" style={{ background: 'linear-gradient(90deg, rgba(0,0,0,0.85) 0%, rgba(0,0,0,0.55) 50%, rgba(0,0,0,0.3) 100%)' }} />

      <div className="relative h-full flex items-center px-4 md:px-6 lg:px-10 gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1.5">
            <span className="text-[8px] md:text-[9px] tracking-[0.3em] px-1.5 md:px-2 py-0.5 rounded font-orbitron font-bold uppercase"
              style={{ background: 'rgb(var(--accent-rgb) / 0.18)', color: accent, border: '1px solid rgb(var(--accent-rgb) / 0.5)' }}>
              Featured
            </span>
            {game.category && (
              <span className="text-[8px] md:text-[9px] tracking-[0.25em] text-white/55 font-orbitron uppercase">{game.category}</span>
            )}
          </div>
          <h2 className="font-orbitron font-black text-lg md:text-2xl lg:text-3xl leading-tight text-white tracking-wide truncate">
            {game.name}
          </h2>
          <p className="text-[10px] md:text-xs lg:text-sm text-white/70 mt-1 font-rajdhani truncate">
            {game.description || 'Jump right back in.'}
          </p>
          <div className="flex items-center gap-2 mt-2 md:mt-3">
            <button
              onClick={(e) => { e.stopPropagation(); onLaunch(game) }}
              className="flex items-center gap-1.5 px-3 md:px-4 h-7 md:h-8 lg:h-9 rounded-md text-[10px] md:text-xs font-bold tracking-wide transition"
              style={{ background: accent, color: '#0a0a0e' }}
            >
              <Play size={10} fill="#0a0a0e" />
              <span>Play Now</span>
            </button>
          </div>
        </div>

        {game.icon && (
          <div className="relative flex-shrink-0 hidden md:block"
            style={{ width: 96, height: 96 }}>
            <img
              src={game.icon}
              alt={game.name}
              className="w-full h-full object-cover rounded-lg"
              style={{ boxShadow: '0 8px 24px rgba(0,0,0,0.6), 0 0 0 1px rgb(var(--accent-rgb) / 0.4)' }}
            />
          </div>
        )}
      </div>
    </div>
  )
}

export default function FeaturedSlider() {
  const { settings, games, incrementLaunchCount, localIPs } = useStore()

  const featuredGames = useMemo(() => {
    const pcGroups = settings.pcGroups || []
    const hasIPDetection = localIPs.length > 0
    const myGroupIds = hasIPDetection
      ? pcGroups.filter(g => (g.ips || []).some(ip => localIPs.includes(ip))).map(g => g.id)
      : []
    const pcIsInAGroup = myGroupIds.length > 0
    const topPicks = games.filter(g => {
      if (!g.topPickRank) return false
      if (pcIsInAGroup) {
        return (g.pcGroups || []).some(gId => myGroupIds.includes(gId))
      }
      return true
    })
    topPicks.sort((a, b) => a.topPickRank - b.topPickRank)
    return topPicks.slice(0, 3)
  }, [games, settings.pcGroups, localIPs])

  const netflix = useMemo(() => {
    const svcs = settings.streamingServices || []
    return svcs.find(s => /^netflix$/i.test((s.name || '').trim()))
  }, [settings.streamingServices])

  const slides = useMemo(() => {
    const list = []
    if (netflix) list.push({ kind: 'netflix', svc: netflix, key: `nf-${netflix.id}` })
    featuredGames.forEach(g => list.push({ kind: 'game', game: g, key: `g-${g.id}` }))
    return list
  }, [netflix, featuredGames])

  const [index, setIndex] = useState(0)
  const [paused, setPaused] = useState(false)
  const timerRef = useRef(null)

  useEffect(() => {
    if (index >= slides.length && slides.length > 0) setIndex(0)
  }, [slides.length, index])

  useEffect(() => {
    if (paused || slides.length <= 1) return
    timerRef.current = setTimeout(() => {
      setIndex(i => (i + 1) % slides.length)
    }, ROTATE_MS)
    return () => { if (timerRef.current) clearTimeout(timerRef.current) }
  }, [index, paused, slides.length])

  const launchGame = async (game) => {
    const exePath = game.exePath || (game.variations?.length > 0 ? game.variations[0].exePath : '')
    const label = game.exePath ? game.name : (game.variations?.length > 0 ? game.variations[0].name : game.name)
    if (window.electronAPI) {
      if (!exePath) { toast.error(`No executable set for ${game.name}`); return }
      const result = await window.electronAPI.launchGame(exePath)
      if (result.success) {
        toast.success(`Launching ${label}...`)
        incrementLaunchCount(game.id)
      } else {
        toast.error(result.error || 'Failed to launch game')
      }
    } else {
      toast.success(`Launching ${label}... (preview mode)`)
      incrementLaunchCount(game.id)
    }
  }

  const launchStreaming = async (svc) => {
    if (!svc.url) { toast.error(`No URL set for ${svc.name}`); return }
    try {
      const p = new URL(svc.url)
      if (!['http:', 'https:'].includes(p.protocol)) {
        toast.error(`${svc.name}: only http(s) URLs are allowed`); return
      }
    } catch { toast.error(`${svc.name}: invalid URL`); return }
    if (window.electronAPI?.openStreaming) {
      const result = await window.electronAPI.openStreaming({ url: svc.url, name: svc.name })
      if (result?.success) toast.success(`Opening ${svc.name}...`)
      else toast.error(result?.error || `Could not open ${svc.name}`)
    } else {
      const w = 1400, h = 900
      const left = Math.max(0, (window.screen.availWidth - w) / 2)
      const top = Math.max(0, (window.screen.availHeight - h) / 2)
      const popup = window.open(svc.url, `streaming-${svc.id}-${Date.now()}`, `popup=yes,width=${w},height=${h},left=${left},top=${top},noopener`)
      if (!popup || popup.closed) toast.error('Popup blocked — allow popups in your browser')
      else toast.success(`Opening ${svc.name}... (preview mode)`)
    }
  }

  if (slides.length === 0) return null

  const current = slides[Math.min(index, slides.length - 1)]

  return (
    <div
      className="relative h-32 md:h-40 lg:h-44 overflow-hidden border-b border-neon-orange/15 flex-shrink-0 group"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={current.key}
          initial={{ opacity: 0, x: 30 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -30 }}
          transition={{ duration: 0.45, ease: 'easeOut' }}
          className="absolute inset-0"
        >
          {current.kind === 'netflix'
            ? <NetflixSlide svc={current.svc} onLaunch={launchStreaming} />
            : <GameSlide game={current.game} onLaunch={launchGame} />}
        </motion.div>
      </AnimatePresence>

      {slides.length > 1 && (
        <>
          <button
            onClick={() => setIndex(i => (i - 1 + slides.length) % slides.length)}
            className="absolute left-2 top-1/2 -translate-y-1/2 w-7 h-7 md:w-8 md:h-8 rounded-full flex items-center justify-center bg-black/40 backdrop-blur-sm hover:bg-black/60 transition opacity-0 group-hover:opacity-100"
            aria-label="Previous slide"
          >
            <ChevronLeft size={14} className="text-white" />
          </button>
          <button
            onClick={() => setIndex(i => (i + 1) % slides.length)}
            className="absolute right-2 top-1/2 -translate-y-1/2 w-7 h-7 md:w-8 md:h-8 rounded-full flex items-center justify-center bg-black/40 backdrop-blur-sm hover:bg-black/60 transition opacity-0 group-hover:opacity-100"
            aria-label="Next slide"
          >
            <ChevronRight size={14} className="text-white" />
          </button>

          <div className="absolute bottom-2 left-1/2 -translate-x-1/2 flex items-center gap-1.5 z-10">
            {slides.map((s, i) => (
              <button
                key={s.key}
                onClick={() => setIndex(i)}
                className="rounded-full transition-all"
                style={{
                  width: i === index ? 18 : 5,
                  height: 5,
                  background: i === index ? '#fff' : 'rgba(255,255,255,0.4)',
                }}
                aria-label={`Go to slide ${i + 1}`}
              />
            ))}
          </div>

          <div className="absolute top-2 right-2 z-10 text-[9px] tracking-wider px-2 py-0.5 rounded font-orbitron font-bold bg-black/45 backdrop-blur-sm text-white/85">
            <span className="text-neon-orange">{index + 1}</span>
            <span className="opacity-60"> / {slides.length}</span>
          </div>
        </>
      )}
    </div>
  )
}
