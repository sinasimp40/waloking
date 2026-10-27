import React, { useState, useEffect, useMemo, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Play, ChevronLeft, ChevronRight, Star } from 'lucide-react'
import toast from 'react-hot-toast'
import useStore from '../store/useStore'
import { getDefaultAccent } from '../lib/accent'
import { afterGameLaunch } from '../lib/afterLaunch'
import { createGameLaunchPayload } from '../lib/gameLaunchPayload'
import { getGameVariations } from '../lib/gameVariations'
import VariationPicker from './VariationPicker'

export default function FeaturedBanner() {
  const { games, settings, incrementLaunchCount } = useStore()
  const accent = settings.accentColor || getDefaultAccent()

  const topPicks = useMemo(() => {
    // Collect all games that are either explicitly ranked (topPickRank) or featured (isFeatured)
    const featured = games.filter(g => g.topPickRank || g.isFeatured)
    
    // Sort them: explicitly ranked first (1, 2, 3...), then unranked featured games by added date
    return featured.sort((a, b) => {
      if (a.topPickRank && b.topPickRank) return a.topPickRank - b.topPickRank
      if (a.topPickRank) return -1
      if (b.topPickRank) return 1
      return (b.addedAt || 0) - (a.addedAt || 0)
    }).slice(0, 8)
  }, [games])

  const slides = useMemo(
    () => topPicks.map((g, index) => ({ 
      type: 'game', 
      game: g,
      rank: g.topPickRank || (index + 1)
    })),
    [topPicks]
  )

  const [current, setCurrent] = useState(0)
  const [direction, setDirection] = useState(1) // 1=forward, -1=backward
  const [imgError, setImgError] = useState(false)
  const [pickerGame, setPickerGame] = useState(null)
  const launchingRef = useRef(false)

  const go = (next) => {
    setDirection(next > current || (next === 0 && current === slides.length - 1) ? 1 : -1)
    setCurrent(next)
    setImgError(false)
  }

  useEffect(() => {
    if (current >= slides.length) setCurrent(0)
  }, [slides.length, current])

  // One timeout per slide, restarted whenever the slide changes (auto or
  // manual). Using a timeout keyed on `current` guarantees every slide —
  // including the first — gets the full interval set in the control deck,
  // instead of sharing a single interval that keeps running across renders.
  useEffect(() => {
    if (slides.length <= 1 || pickerGame) return
    const seconds = Math.max(1, Number(settings.featuredRotationInterval) || 3)
    const t = setTimeout(() => {
      setDirection(1)
      setCurrent(p => (p + 1) % slides.length)
      setImgError(false)
    }, seconds * 1000)
    return () => clearTimeout(t)
  }, [current, slides.length, settings.featuredRotationInterval, pickerGame])

  useEffect(() => { setImgError(false) }, [current])


  const launchExe = async (game, exePath, label, variation = null) => {
    if (!exePath) { toast.error(`No executable for ${game.name}`); return }
    if (launchingRef.current) return
    launchingRef.current = true
    try {
      if (window.electronAPI) {
        const launchRequest = window.electronAPI.launchGame(
          createGameLaunchPayload(game, exePath, settings, variation)
        )
        afterGameLaunch(settings)
        const result = await launchRequest
        if (result.success) {
          toast.success(`Launching ${label}…`)
          incrementLaunchCount(game.id)
        } else { toast.error(result.error || 'Failed to launch') }
      } else {
        toast.success(`Launching ${label}… (preview mode)`)
        incrementLaunchCount(game.id)
      }
    } catch (error) {
      toast.error(error?.message || 'Failed to launch')
    } finally {
      launchingRef.current = false
      setPickerGame(null)
    }
  }

  const handleLaunch = (game) => {
    if (!game || launchingRef.current) return
    if (getGameVariations(game).length > 0) setPickerGame(game)
    else launchExe(game, game.exePath, game.name)
  }

  if (slides.length === 0) {
    return (
      <div
        className="mx-4 mb-4 rounded-2xl overflow-hidden flex-shrink-0 relative"
        style={{ height: '260px', border: '1px solid rgba(255,255,255,0.07)', background: 'rgba(255,255,255,0.015)' }}
      >
        {/* soft accent wash from one corner only — avoids the flat AI gradient look */}
        <div className="absolute inset-0" style={{
          background: `radial-gradient(120% 90% at 12% 0%, ${accent}1f 0%, transparent 60%)`
        }} />
        {/* fine grid texture */}
        <div className="absolute inset-0" style={{
          backgroundImage: 'linear-gradient(rgba(255,255,255,0.04) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.04) 1px, transparent 1px)',
          backgroundSize: '36px 36px',
          maskImage: 'radial-gradient(80% 70% at 50% 50%, #000 0%, transparent 100%)',
          WebkitMaskImage: 'radial-gradient(80% 70% at 50% 50%, #000 0%, transparent 100%)'
        }} />

        <div className="relative h-full flex items-center gap-6 px-8">
          {/* placeholder art slot */}
          <div
            className="hidden sm:flex items-center justify-center rounded-xl flex-shrink-0"
            style={{
              width: '148px', height: '148px',
              border: `1px dashed ${accent}44`,
              background: 'rgba(255,255,255,0.02)'
            }}
          >
            <Star size={26} style={{ color: accent, opacity: 0.55 }} />
          </div>

          <div className="min-w-0">
            <span
              className="inline-block font-syne font-bold uppercase rounded-full px-2.5 py-1"
              style={{ fontSize: '10px', letterSpacing: '0.18em', color: accent, background: `${accent}1a`, border: `1px solid ${accent}33` }}
            >
              Top Picks
            </span>
            <h3 className="font-syne font-bold mt-3" style={{ fontSize: '22px', color: 'rgba(255,255,255,0.82)', letterSpacing: '-0.01em' }}>
              Your featured shelf is empty
            </h3>
            <p className="mt-1.5" style={{ fontSize: '13px', color: 'rgba(255,255,255,0.38)' }}>
              Pick a few standout titles in the Admin Panel and they’ll headline this space.
            </p>
            {/* faux slide dots for visual rhythm */}
            <div className="flex items-center gap-1.5 mt-4">
              {[0, 1, 2].map((i) => (
                <span key={i} style={{
                  width: i === 0 ? '18px' : '6px', height: '6px', borderRadius: '999px',
                  background: i === 0 ? `${accent}99` : 'rgba(255,255,255,0.12)'
                }} />
              ))}
            </div>
          </div>
        </div>
      </div>
    )
  }


  const slide = slides[current]
  if (!slide) return null

  return (
    <>
    <div className="mx-4 mb-4 rounded-2xl overflow-hidden relative flex-shrink-0" style={{ height: '260px', border: '1px solid rgba(255,255,255,0.06)' }}>

      {/* Ken Burns CSS injection — slow zoom on the bg art */}
      <style>{`
        @keyframes kenburns {
          0%   { transform: scale(1)    translateX(0%)    translateY(0%); }
          50%  { transform: scale(1.06) translateX(-1.5%) translateY(-0.5%); }
          100% { transform: scale(1)    translateX(0%)    translateY(0%); }
        }
        .kb { animation: kenburns 12s ease-in-out infinite; transform-origin: center center; }
      `}</style>

      {/* Slide stack — mode="sync" so old and new crossfade simultaneously
          (no black gap). Entering slide sits above the exiting one. */}
      <AnimatePresence mode="sync" initial={false}>
        {slide.type === 'game' ? (
          <motion.div
            key={slide.game.id}
            className="absolute inset-0"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.7, ease: 'easeInOut' }}
            style={{ zIndex: 1 }}
          >
            {/* Background art with Ken Burns */}
            {(slide.game.wallpaper || slide.game.icon) && !imgError ? (
              <div className="absolute inset-0 overflow-hidden">
                <img
                  src={slide.game.wallpaper || slide.game.icon}
                  alt=""
                  className="kb absolute inset-0 w-full h-full object-cover"
                  style={{
                    filter: 'brightness(0.5)',
                    objectPosition: slide.game.wallpaper ? 'center center' : 'center 15%',
                  }}
                  onError={() => setImgError(true)}
                />
              </div>
            ) : (
              <div className="absolute inset-0" style={{ background: `linear-gradient(135deg, ${accent}20, rgba(10,10,11,0.9))` }} />
            )}

            {/* Gradient overlays */}
            <div className="absolute inset-0" style={{ background: 'linear-gradient(to right, rgba(10,10,11,0.94) 0%, rgba(10,10,11,0.68) 45%, rgba(10,10,11,0.28) 75%, rgba(10,10,11,0.08) 100%)' }} />
            <div className="absolute inset-0" style={{ background: 'linear-gradient(to top, rgba(10,10,11,0.65) 0%, transparent 55%)' }} />

            {/* Content — staggered reveal */}
            <div className="absolute inset-0 flex items-center px-7">
              <div className="min-w-0 max-w-sm">
                <motion.div
                  initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.15, duration: 0.35 }}
                  className="flex items-center gap-2 mb-2"
                >
                  <div
                    className="px-2.5 py-0.5 rounded-full font-jakarta text-[10px] font-semibold uppercase tracking-wider"
                    style={{ background: `${accent}20`, border: `1px solid ${accent}35`, color: accent }}
                  >
                    #{slide.rank} Featured
                  </div>
                </motion.div>
                <motion.h2
                  initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.22, duration: 0.35 }}
                  className="font-syne font-bold text-2xl leading-tight text-white mb-1 truncate"
                  style={{ textShadow: '0 2px 12px rgba(0,0,0,0.8)' }}
                >
                  {getGameVariations(slide.game).length > 0 ? (slide.game.variationTitle?.trim() || slide.game.name) : slide.game.name}
                </motion.h2>
                {slide.game.description && (
                  <motion.p
                    initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.3, duration: 0.35 }}
                    className="font-jakarta text-xs text-muted leading-relaxed line-clamp-2 mb-3 max-w-md"
                  >
                    {slide.game.description}
                  </motion.p>
                )}
                <motion.button
                  initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.38, duration: 0.3 }}
                  onClick={() => handleLaunch(slide.game)}
                  className="flex items-center gap-2 px-5 py-2 rounded-xl font-syne font-bold text-xs uppercase tracking-wider text-white transition-all hover:scale-105 active:scale-95"
                  style={{ background: `linear-gradient(135deg, ${accent}, ${accent}cc)`, boxShadow: `0 4px 20px ${accent}30` }}
                >
                  <Play size={12} fill="white" />
                  Play Now
                </motion.button>
              </div>
            </div>

            {/* Key art — clean: just the cover, fully contained, soft shadow.
                No frame, no glow, no dark blob behind it. */}
            {slide.game.icon && !imgError && (
              <motion.div
                initial={{ opacity: 0, x: 16 }} animate={{ opacity: 1, x: 0 }}
                transition={{ delay: 0.2, duration: 0.5, ease: 'easeOut' }}
                className="absolute hidden sm:flex items-center justify-end pointer-events-none"
                style={{
                  top: '14px',
                  right: '26px',
                  bottom: '34px',
                  width: 'clamp(110px, 20%, 190px)',
                  zIndex: 3,
                }}
              >
                <img
                  src={slide.game.icon}
                  alt={slide.game.name}
                  className="max-w-full max-h-full rounded-lg"
                  style={{ objectFit: 'contain', filter: 'drop-shadow(0 10px 22px rgba(0,0,0,0.55))' }}
                />
              </motion.div>
            )}


          </motion.div>
        ) : (
          <motion.div
            key={slide.src}
            className="absolute inset-0"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.7, ease: 'easeInOut' }}
            style={{ zIndex: 1 }}
          >
            <div className="absolute inset-0 overflow-hidden">
              <img src={slide.src} alt="" className="kb absolute inset-0 w-full h-full object-cover" />
            </div>
            <div className="absolute bottom-0 left-0 right-0 h-16" style={{ background: 'linear-gradient(to top, rgba(10,10,11,0.7), transparent)' }} />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Navigation dots */}
      {slides.length > 1 && (
        <div className="absolute bottom-3 right-4 flex items-center gap-3 z-10">
          <button
            onClick={() => go((current - 1 + slides.length) % slides.length)}
            className="w-6 h-6 rounded-lg flex items-center justify-center transition-all hover:bg-white/10"
            style={{ background: 'rgba(10,10,11,0.6)', border: '1px solid rgba(255,255,255,0.1)' }}
          >
            <ChevronLeft size={12} className="text-white/60" />
          </button>
          <div className="flex gap-1">
            {slides.map((_, i) => (
              <button
                key={i}
                onClick={() => go(i)}
                className="rounded-full transition-all"
                style={{ width: i === current ? '16px' : '5px', height: '5px', background: i === current ? accent : 'rgba(255,255,255,0.25)' }}
              />
            ))}
          </div>
          <button
            onClick={() => go((current + 1) % slides.length)}
            className="w-6 h-6 rounded-lg flex items-center justify-center transition-all hover:bg-white/10"
            style={{ background: 'rgba(10,10,11,0.6)', border: '1px solid rgba(255,255,255,0.1)' }}
          >
            <ChevronRight size={12} className="text-white/60" />
          </button>
        </div>
      )}
    </div>
    {pickerGame && (
      <VariationPicker
        open
        game={pickerGame}
        accent={accent}
        variations={getGameVariations(pickerGame)}
        onLaunch={(exePath, label, variation) => launchExe(pickerGame, exePath, label, variation)}
        onClose={() => setPickerGame(null)}
      />
    )}
    </>
  )
}
