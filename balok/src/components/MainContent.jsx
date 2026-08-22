import React, { useMemo, useState, useRef, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Play, ChevronLeft, ChevronRight, Gamepad2, Star } from 'lucide-react'
import toast from 'react-hot-toast'
import useStore from '../store/useStore'
import { getDefaultAccent } from '../lib/accent'
import { afterGameLaunch } from '../lib/afterLaunch'
import { createGameLaunchPayload } from '../lib/gameLaunchPayload'
import FeaturedBanner from './FeaturedBanner'
import VariationPicker from './VariationPicker'

function shuffleGames(games) {
  const shuffled = [...games]
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }
  return shuffled
}

/* ─────────────────────────────────────────────
   Utility: deterministic gradient for a game
───────────────────────────────────────────── */
const GRADIENTS = [
  ['#1a1a2e','#16213e','#0f3460'],
  ['#1a0a0a','#3d0000','#6b0000'],
  ['#0a1a0a','#0a3d0a','#0a6b0a'],
  ['#1a1a0a','#3d3d00','#6b5200'],
  ['#0a0a1a','#120a3d','#1e0a6b'],
  ['#1a0a1a','#3d003d','#6b006b'],
  ['#0a1a1a','#003d3d','#006b6b'],
  ['#1a0f0a','#3d2000','#6b3800'],
]
function gameGradient(name = '') {
  let h = 0; for (const c of name) h = (h * 31 + c.charCodeAt(0)) & 0xffffffff
  const g = GRADIENTS[Math.abs(h) % GRADIENTS.length]
  return `linear-gradient(145deg, ${g[0]}, ${g[1]}, ${g[2]})`
}

/* ─────────────────────────────────────────────
   Small portrait card for shelves
───────────────────────────────────────────── */
function ShelfCard({ game, fill }) {
  const accent = useStore(s => s.settings.accentColor) || getDefaultAccent()
  const incrementLaunchCount = useStore(s => s.incrementLaunchCount)
  const settings = useStore(s => s.settings)
  const [imgErr, setImgErr] = useState(false)
  const [hovered, setHovered] = useState(false)
  const [isLaunching, setIsLaunching] = useState(false)
  const [showVars, setShowVars] = useState(false)
  const isLaunchingRef = useRef(false)
  const validVars = (game.variations || []).filter(v => v.label && (v.path || v.exePath))

  const launch = async (exePath, label) => {
    if (!exePath) { toast.error(`No exe set for ${label}`); return }
    if (isLaunchingRef.current) return
    isLaunchingRef.current = true
    setIsLaunching(true)
    try {
      if (window.electronAPI) {
        const launchRequest = window.electronAPI.launchGame(
          createGameLaunchPayload(game, exePath, settings, label !== game.name ? label : null)
        )
        afterGameLaunch(settings)
        const r = await launchRequest
        if (r.success) {
          toast.success(`Launching ${label}…`)
          incrementLaunchCount(game.id)
        } else toast.error(r.error || 'Failed')
      } else {
        toast.success(`Launching ${label}… (preview)`)
        incrementLaunchCount(game.id)
      }
    } finally {
      isLaunchingRef.current = false
      setIsLaunching(false)
      setShowVars(false)
    }
  }

  const handleClick = () => {
    if (validVars.length > 0) setShowVars(true)
    else launch(game.exePath, game.name)
  }

  return (
    <>
      <div
        className={fill ? 'relative rounded-xl overflow-hidden cursor-pointer' : 'relative flex-shrink-0 rounded-xl overflow-hidden cursor-pointer'}
        style={{
          width: fill ? '100%' : 150,
          aspectRatio: '3/4',
          background: gameGradient(game.name),
          border: hovered ? `1px solid ${accent}60` : '1px solid rgba(255,255,255,0.05)',
          boxShadow: hovered ? `0 8px 24px rgba(0,0,0,0.6), 0 0 16px ${accent}25` : '0 4px 12px rgba(0,0,0,0.4)',
          transform: hovered ? 'scale(1.04) translateY(-3px)' : 'scale(1)',
          transition: 'all 0.25s ease',
        }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onClick={() => { if (!isLaunchingRef.current) handleClick() }}
      >
        {game.icon && !imgErr && (
          <img src={game.icon} alt={game.name} className="absolute inset-0 w-full h-full object-cover"
            onError={() => setImgErr(true)}
          />
        )}

        {/* Bottom gradient */}
        <div className="absolute inset-x-0 bottom-0" style={{ height: '55%', background: 'linear-gradient(to top, rgba(0,0,0,0.9) 0%, transparent 100%)' }} />

        {/* Play overlay */}
        <div className="absolute inset-0 flex items-center justify-center"
          style={{ opacity: hovered ? 1 : 0, transition: 'opacity 0.2s', background: 'rgba(0,0,0,0.25)' }}
        >
          <div className="w-10 h-10 rounded-full flex items-center justify-center"
            style={{ background: accent, boxShadow: `0 0 20px ${accent}70`, transform: hovered ? 'scale(1)' : 'scale(0.5)', transition: 'transform 0.25s' }}
          >
            <Play size={16} fill="#000" style={{ color: '#000', marginLeft: 2 }} />
          </div>
        </div>

        {/* Name */}
        {settings.showGameNames !== false && (
          <div className="absolute bottom-0 left-0 right-0 px-2 pb-2">
            <p className="text-white text-[11px] font-semibold leading-tight truncate"
              style={{ textShadow: '0 1px 4px rgba(0,0,0,0.9)' }}>
              {game.name}
            </p>
            {game.launchCount > 0 && (
              <p className="text-[9px] mt-0.5" style={{ color: 'rgba(255,255,255,0.45)' }}>
                {game.launchCount >= 60 ? `${Math.round(game.launchCount/60)}h played` : `${game.launchCount} plays`}
              </p>
            )}
          </div>
        )}

      </div>

      <VariationPicker
        open={showVars}
        game={game}
        accent={accent}
        variations={validVars}
        onLaunch={launch}
        onClose={() => setShowVars(false)}
      />
    </>
  )
}

/* ─────────────────────────────────────────────
   Horizontal Shelf
───────────────────────────────────────────── */
const SHELF_CARD = 150
const SHELF_GAP = 12
const SHELF_STEP = SHELF_CARD + SHELF_GAP

const SHELF_SPEED_PX_PER_SEC = 45

function Shelf({ title, games, viewAll, loop }) {
  const accent = useStore(s => s.settings.accentColor) || getDefaultAccent()
  const ref = useRef(null)
  const viewportRef = useRef(null)
  const [visibleCount, setVisibleCount] = useState(1)
  const [paused, setPaused] = useState(false)

  const scroll = (dir) => {
    const el = ref.current
    if (!el) return
    el.scrollBy({ left: dir * 300, behavior: 'smooth' })
  }

  // Measure the viewport so the track is always repeated enough times to
  // stay full-bleed edge to edge while it glides, whatever the viewport
  // width or list length.
  useEffect(() => {
    if (!loop) return
    const el = viewportRef.current
    if (!el) return
    const measure = () => {
      const count = Math.max(1, Math.floor((el.clientWidth + SHELF_GAP) / SHELF_STEP))
      setVisibleCount(count)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [loop])

  // Always keep looping shelves in continuous ambient motion — even when
  // every card already fits on screen — rather than only animating when the
  // list overflows.
  const needsLoop = loop && games.length > 1
  // Repeat the list enough times that the viewport is always full, plus one
  // extra full copy so the CSS animation can glide continuously and reset
  // seamlessly (every visible position matches its pre-loop counterpart).
  const repeats = needsLoop ? Math.max(3, Math.ceil(visibleCount / games.length) + 2) : 1
  const trackGames = needsLoop
    ? Array.from({ length: repeats }, () => games).flat()
    : games

  // One continuous, constant-speed CSS animation — no discrete stepping —
  // that slides by exactly one full copy of the list, then loops. Because
  // every copy is identical, the loop point is invisible.
  const distance = games.length * SHELF_STEP
  const duration = needsLoop ? Math.max(distance / SHELF_SPEED_PX_PER_SEC, 4) : 0

  if (games.length === 0) return null

  return (
    <div className="mb-5 flex-shrink-0">
      <div className="shelf-header px-4">
        <div className="shelf-title" style={{ '--accent': accent }}>
          {title}
        </div>
        {!loop && (
          <div className="flex items-center gap-2">
            {viewAll && (
              <button className="text-[10px] font-semibold uppercase tracking-wider transition-all hover:opacity-80"
                style={{ color: accent }}>View All</button>
            )}
            <button onClick={() => scroll(-1)}
              className="w-6 h-6 rounded-md flex items-center justify-center transition-all hover:bg-white/10"
              style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.08)' }}>
              <ChevronLeft size={12} style={{ color: 'rgba(255,255,255,0.6)' }} />
            </button>
            <button onClick={() => scroll(1)}
              className="w-6 h-6 rounded-md flex items-center justify-center transition-all hover:bg-white/10"
              style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.08)' }}>
              <ChevronRight size={12} style={{ color: 'rgba(255,255,255,0.6)' }} />
            </button>
          </div>
        )}
      </div>
      {loop ? (
        <div
          ref={viewportRef}
          className="shelf-marquee-viewport px-4"
          onMouseEnter={() => setPaused(true)}
          onMouseLeave={() => setPaused(false)}
        >
          <div
            className={`shelf-marquee-track${needsLoop ? ' is-looping' : ''}`}
            style={needsLoop ? {
              '--shelf-distance': `-${distance}px`,
              animationDuration: `${duration}s`,
              animationPlayState: paused ? 'paused' : 'running',
            } : undefined}
          >
            {trackGames.map((g, i) => <ShelfCard key={`${g.id}-${i}`} game={g} />)}
          </div>
        </div>
      ) : (
        <div ref={ref} className="shelf-scroll px-4">
          {trackGames.map(g => <ShelfCard key={g.id} game={g} />)}
        </div>
      )}
    </div>
  )
}

function GameList({ title, games }) {
  const accent = useStore(s => s.settings.accentColor) || getDefaultAccent()
  const baseCardSize = useStore(s => s.settings.cardSize) || 150
  const zoom = useStore(s => s.settings.uiZoom) || 100
  const cardSize = Math.round(baseCardSize * (zoom / 100))
  if (games.length === 0) return null

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="flex items-center justify-between mb-3 flex-shrink-0 gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-[3px] h-[16px] rounded-sm flex-shrink-0"
            style={{ background: accent, boxShadow: `0 0 8px ${accent}` }} />
          <span className="text-[13px] font-bold uppercase tracking-[0.08em] text-white truncate">{title}</span>
          <span className="text-[10px] font-normal flex-shrink-0" style={{ color: 'rgba(255,255,255,0.3)' }}>{games.length}</span>
        </div>
      </div>
      <div className="overflow-y-auto flex-1 min-h-0">
        <div
          className="grid gap-3.5 pb-2"
          style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${cardSize}px, 1fr))` }}
        >
          {games.map(g => <ShelfCard key={g.id} game={g} fill />)}
        </div>
      </div>
    </div>
  )
}


/* ─────────────────────────────────────────────
   Featured Banner
───────────────────────────────────────────── */
/* ─────────────────────────────────────────────
   Main Content
───────────────────────────────────────────── */
export default function MainContent() {
  const { games, activeCategory, searchQuery, settings, localIPs } = useStore()
  const accent = settings.accentColor || getDefaultAccent()

  const filteredGames = useMemo(() => {
    const pcGroups = settings.pcGroups || []
    const hasIP = localIPs.length > 0
    const myGroupIds = hasIP
      ? pcGroups.filter(g => (g.ips || []).some(ip => localIPs.includes(ip))).map(g => g.id)
      : []
    const inGroup = myGroupIds.length > 0
    return games.filter(game => {
      const matchesCat = activeCategory === 'all' || game.category === activeCategory
      const matchesSearch = !searchQuery ||
        game.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (game.description || '').toLowerCase().includes(searchQuery.toLowerCase())
      // Unassigned games are global; only group-restricted ones are filtered.
      const assigned = game.pcGroups || []
      const matchesPC = !inGroup || assigned.length === 0 || assigned.some(gId => myGroupIds.includes(gId))
      return matchesCat && matchesSearch && matchesPC
    }).sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || a.name.localeCompare(b.name))
  }, [games, activeCategory, searchQuery, settings.pcGroups, localIPs])

  const favoriteGames = useMemo(() =>
    [...filteredGames].filter(g => g.isFavorite),
    [filteredGames]
  )
  const displayGames = useMemo(() =>
    settings.shuffleGameCards ? shuffleGames(filteredGames) : filteredGames,
    [filteredGames, settings.shuffleGameCards]
  )

  // Search results view
  if (searchQuery) {
    return (
      <div className="flex-1 overflow-y-auto pt-4" style={{ background: 'var(--bg-base)' }}>
        <div className="px-4 mb-4">
          <div className="shelf-title text-sm">
            Search: "{searchQuery}"
            <span className="ml-2 text-[10px] font-normal" style={{ color: 'rgba(255,255,255,0.35)' }}>
              {filteredGames.length} result{filteredGames.length !== 1 ? 's' : ''}
            </span>
          </div>
        </div>
        {filteredGames.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 gap-3">
            <Gamepad2 size={40} style={{ color: 'rgba(255,255,255,0.12)' }} />
            <p className="text-xs font-semibold uppercase tracking-widest" style={{ color: 'rgba(255,255,255,0.2)' }}>No results found</p>
          </div>
        ) : (
          <div className="shelf-scroll px-4 pb-4" style={{ display: 'flex', flexWrap: 'wrap', gap: 12, overflowX: 'unset', overflowY: 'unset' }}>
            {displayGames.map(g => <ShelfCard key={g.id} game={g} />)}
          </div>
        )}
      </div>
    )
  }

  // Home / category view
  return (
    <div className="flex-1 flex flex-col overflow-hidden" style={{ background: 'var(--bg-base)' }}>
      {/* Non-scrolling top section */}
      <div className="flex-shrink-0 pt-4">
        {/* Featured banner (Top Picks slider) */}
        <FeaturedBanner />

        {/* Favorite Games (admin-curated) */}
        {favoriteGames.length > 0 && (
          <Shelf title="Favorite Games" games={favoriteGames} loop />
        )}
      </div>

      {/* Game List — fills remaining space down to the bottom of the screen */}
      <div className="flex-1 min-h-0 flex flex-col px-4 pb-4">
        {filteredGames.length === 0 ? (
          <div className="relative flex-1 min-h-0 rounded-2xl overflow-hidden"
               style={{ border: '1px solid rgba(255,255,255,0.05)', background: 'rgba(255,255,255,0.012)' }}>
            {/* ghost card grid hinting at the real layout */}
            <div className="absolute inset-0 p-6 grid gap-4"
                 style={{
                   gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))',
                   gridAutoRows: '96px',
                   maskImage: 'linear-gradient(180deg, #000 0%, transparent 78%)',
                   WebkitMaskImage: 'linear-gradient(180deg, #000 0%, transparent 78%)'
                 }}>
              {Array.from({ length: 18 }).map((_, i) => (
                <div key={i} className="rounded-xl"
                     style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.035)' }} />
              ))}
            </div>

            <div className="relative h-full flex flex-col items-center justify-center text-center px-6">
              <div className="flex items-center justify-center rounded-2xl mb-4"
                   style={{ width: 56, height: 56, background: `${accent}14`, border: `1px solid ${accent}30` }}>
                <Gamepad2 size={24} style={{ color: accent, opacity: 0.8 }} />
              </div>
              <h3 className="font-syne font-bold" style={{ fontSize: '19px', color: 'rgba(255,255,255,0.8)' }}>
                Nothing here yet
              </h3>
              <p className="mt-1.5" style={{ fontSize: '13px', color: 'rgba(255,255,255,0.36)', maxWidth: 340 }}>
                {activeCategory === 'all'
                  ? 'Add your first titles from the Admin Panel to build the library.'
                  : 'No titles assigned to this category yet — add some in the Admin Panel.'}
              </p>
            </div>
          </div>
        ) : (

          <GameList
            title={activeCategory === 'all' ? 'Game List' : `${activeCategory.charAt(0).toUpperCase() + activeCategory.slice(1)} Games`}
            games={displayGames}
          />
        )}
      </div>
    </div>
  )
}
