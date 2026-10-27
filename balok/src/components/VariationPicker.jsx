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
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="w-full flex items-center gap-3 p-3 rounded-xl text-left transition-all duration-200"
      style={{
        background: hover ? 'rgba(255,255,255,0.04)' : 'transparent',
        border: `1px solid ${hover ? accent + '45' : 'transparent'}`,
        transform: hover ? 'translateX(3px)' : 'none',
      }}
    >
      <span
        className="w-10 h-10 rounded-[10px] flex items-center justify-center flex-shrink-0 overflow-hidden text-sm font-bold"
        style={{ background: `${accent}1f`, color: accent }}
      >
        {icon && !iconError
          ? <img src={icon} alt="" className="w-full h-full object-cover" onError={() => setIconError(true)} />
          : <span aria-hidden="true">{label?.trim()?.[0]?.toUpperCase() || 'G'}</span>}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-jakarta text-[15px] font-semibold text-white/85 truncate">{label}</span>
      </span>
      <ChevronRight size={17} className="text-white/25 flex-shrink-0" />
    </button>
  )
}

/**
 * Shared "choose how to play" modal used by every game tile.
 * Shows the game's cover art as the header and one tall row per launch
 * option (main executable + each variation).
 */
export default function VariationPicker({ open, game, accent, variations, onLaunch, onClose }) {
  const optionCount = (game.exePath ? 1 : 0) + (variations || []).length
  const cover = game.wallpaper || game.icon
  // Rendered into <body> via a portal: shelf/grid ancestors use transforms and
  // overflow:hidden, which would otherwise clip this fixed overlay (the modal
  // appeared cut off inside the Favorite Games row).
  const overlay = (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[70] flex items-center justify-center p-4"
          style={{
            background: 'radial-gradient(circle at center, rgba(0,0,0,0.52), rgba(0,0,0,0.82))',
            backdropFilter: 'blur(3px)',
          }}
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          onMouseDown={onClose}
        >
          <motion.div
            className="relative w-full max-w-[430px] rounded-[18px] overflow-hidden"
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

            <div className="relative h-[112px] overflow-hidden">
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
              <div className="absolute left-[18px] right-14 bottom-4">
                <p className="font-jakarta text-[10px] font-bold uppercase tracking-[0.15em]" style={{ color: accent }}>Choose a version</p>
                <p className="font-syne font-bold text-[15px] leading-tight text-white truncate mt-1" style={{ textShadow: '0 2px 10px rgba(0,0,0,0.8)' }}>{game.variationTitle?.trim() || game.name}</p>
              </div>
              <button
                type="button"
                aria-label="Close edition picker"
                onClick={onClose}
                className="absolute top-3 right-3 p-1.5 rounded-lg text-white/60 hover:text-white hover:bg-black/30 transition-colors"
              >
                <X size={16} />
              </button>
            </div>

            <div className="h-px mx-[18px]" style={{ background: `linear-gradient(90deg, ${accent}40, rgba(255,255,255,0.08), transparent)` }} />

            <div className="p-3 space-y-2 max-h-[46vh] overflow-y-auto scroll-thin">
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

            <div className="mx-[18px] pt-[13px] pb-[15px] border-t border-white/[0.06] flex items-center justify-between">
              <p className="font-jakarta text-[11px] text-white/[0.29] tracking-[0.07em] uppercase">{optionCount} editions available</p>
              <p className="font-jakarta text-[11px] font-bold" style={{ color: accent }}>Select to play</p>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
  if (typeof document === 'undefined') return overlay
  return createPortal(overlay, document.body)
}
