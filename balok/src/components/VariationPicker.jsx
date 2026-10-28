import React, { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { ChevronRight, X } from 'lucide-react'


function VariationRow({ accent, label, icon, onClick }) {
  const [hover, setHover] = useState(false)
  const [iconError, setIconError] = useState(false)
  useEffect(() => setIconError(false), [icon])
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="group w-full flex items-center gap-3 rounded-[13px] px-3 py-2.5 text-left transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/75"
      style={{
        background: hover ? `${accent}12` : 'rgba(255,255,255,0.018)',
        border: `1px solid ${hover ? accent + '70' : 'rgba(255,255,255,0.065)'}`,
        transform: hover ? 'translateX(2px)' : 'none',
      }}
    >
      <span
        className="w-[58px] h-[58px] rounded-[11px] flex items-center justify-center flex-shrink-0 overflow-hidden text-sm font-bold transition-colors duration-200"
        style={{ background: `${accent}20`, color: accent, border: `1px solid ${accent}30` }}
      >
        {icon && !iconError
          ? <img src={icon} alt="" className="w-full h-full object-contain p-1" onError={() => setIconError(true)} />
          : <span aria-hidden="true">{label?.trim()?.[0]?.toUpperCase() || 'G'}</span>}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-jakarta text-[14px] leading-[1.35] font-semibold text-white/85 break-words">{label}</span>
      </span>
      <ChevronRight size={17} className="text-white/25 flex-shrink-0 transition-colors duration-200 group-hover:text-white/75" />
    </button>
  )
}

/**
 * Shared "choose how to play" modal used by every game tile.
 * Shows the game's cover art as the header and one tall row per launch
 * option (main executable + each variation).
 */
export default function VariationPicker({ open, game, accent, variations, onLaunch, onClose }) {
  const cover = game.wallpaper || game.icon
  useEffect(() => {
    if (!open) return undefined
    const handleKeyDown = event => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose])
  // Rendered into <body> via a portal: shelf/grid ancestors use transforms and
  // overflow:hidden, which would otherwise clip this fixed overlay (the modal
  // appeared cut off inside the Favorite Games row).
  const overlay = (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[70] flex items-center justify-center p-3 sm:p-4"
          style={{
            background: 'radial-gradient(circle at center, rgba(0,0,0,0.52), rgba(0,0,0,0.82))',
            backdropFilter: 'blur(3px)',
          }}
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          onMouseDown={onClose}
        >
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-labelledby="variation-picker-title"
            className="relative flex w-full max-w-[380px] max-h-[calc(100dvh-24px)] flex-col rounded-[17px] overflow-hidden"
            style={{
              background: 'linear-gradient(145deg, rgba(28,28,35,0.98), rgba(10,10,14,0.99))',
              border: `1px solid ${accent}38`,
              boxShadow: `0 28px 80px rgba(0,0,0,0.82), 0 0 55px ${accent}14`,
            }}
            initial={{ scale: 0.94, y: 10 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.94, y: 10 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
            onMouseDown={e => e.stopPropagation()}
          >
            <div className="h-[2px]" style={{ background: `linear-gradient(90deg, transparent, ${accent} 30%, #ffffff 50%, ${accent} 70%, transparent)` }} />

            <div className="relative min-h-[98px] shrink-0 overflow-hidden">
              {cover ? (
                <img
                  src={cover}
                  alt=""
                  className="absolute inset-0 w-full h-full object-cover"
                  style={{ filter: 'brightness(0.45) saturate(0.8)' }}
                />
              ) : (
                <div className="absolute inset-0" style={{ background: `linear-gradient(135deg, ${accent}30, rgba(14,14,15,1))` }} />
              )}
              <div
                className="absolute inset-0"
                style={{ background: 'linear-gradient(to top, rgba(10,10,14,1) 0%, rgba(10,10,14,0.42) 64%, rgba(10,10,14,0.18) 100%)' }}
              />
              <div className="relative px-[18px] pt-7 pb-3 pr-14">
                <p className="font-jakarta text-[10px] font-bold uppercase tracking-[0.15em]" style={{ color: accent }}>Choose a version</p>
                <h2 id="variation-picker-title" className="font-syne font-bold text-[16px] leading-[1.2] text-white break-words mt-1" style={{ textShadow: '0 2px 10px rgba(0,0,0,0.8)' }}>{game.variationTitle?.trim() || game.name}</h2>
              </div>
              <button
                type="button"
                aria-label="Close edition picker"
                onClick={onClose}
                className="absolute top-3 right-3 p-1.5 rounded-lg text-white/65 hover:text-white hover:bg-black/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/75 transition-colors"
              >
                <X size={16} />
              </button>
            </div>

            <div className="h-px mx-[18px] shrink-0" style={{ background: `linear-gradient(90deg, ${accent}55, rgba(255,255,255,0.08), transparent)` }} />

            <div className="min-h-0 overflow-y-auto overscroll-contain p-2.5 space-y-1.5 scroll-thin" style={{ maxHeight: 'min(58vh, 420px)' }}>
              {game.exePath && (
                <VariationRow
                  accent={accent}
                  label={game.name}
                  icon={game.iconUrl || game.icon}
                  onClick={() => onLaunch(game.exePath, game.name, null)}
                />
              )}
              {(variations || []).map((v, i) => (
                <VariationRow
                  key={i}
                  accent={accent}
                  label={v.label || v.name}
                  icon={v.icon || v.iconUrl}
                  onClick={() => onLaunch(v.path || v.exePath, v.label || v.name, v.label || v.name)}
                />
              ))}
            </div>

          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
  if (typeof document === 'undefined') return overlay
  return createPortal(overlay, document.body)
}
