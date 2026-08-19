import React, { useState } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { Play, ChevronRight, X } from 'lucide-react'


/* A single launch option row. */
function VariationRow({ accent, label, hint, onClick }) {
  const [hover, setHover] = useState(false)
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="w-full flex items-center gap-3 px-3 py-3 rounded-2xl text-left transition-all"
      style={{
        background: hover ? `${accent}12` : 'rgba(255,255,255,0.03)',
        border: `1px solid ${hover ? accent + '45' : 'rgba(255,255,255,0.06)'}`,
        transform: hover ? 'translateX(2px)' : 'none',
      }}
    >
      <span
        className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0"
        style={{ background: hover ? accent : `${accent}1a`, transition: 'background 0.2s' }}
      >
        <Play size={13} fill={hover ? '#fff' : accent} style={{ color: hover ? '#fff' : accent }} className="ml-0.5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-jakarta text-sm font-semibold text-white/90 truncate">{label}</span>
        <span className="block font-jakarta text-[10px] text-muted truncate">{hint}</span>
      </span>
      <ChevronRight size={13} className="text-muted flex-shrink-0" />
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
  // Rendered into <body> via a portal: shelf/grid ancestors use transforms and
  // overflow:hidden, which would otherwise clip this fixed overlay (the modal
  // appeared cut off inside the Favorite Games row).
  const overlay = (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[70] flex items-center justify-center p-6"
          style={{ background: 'rgba(0,0,0,0.62)', backdropFilter: 'blur(18px)' }}
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          onMouseDown={onClose}
        >
          <motion.div
            className="relative w-[380px] max-w-full rounded-3xl overflow-hidden"
            style={{
              background: 'rgba(14,14,15,0.98)',
              border: '1px solid rgba(255,255,255,0.08)',
              boxShadow: `0 0 60px ${accent}18, 0 30px 80px rgba(0,0,0,0.85)`,
            }}
            initial={{ scale: 0.94, y: 10 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.94, y: 10 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
            onMouseDown={e => e.stopPropagation()}
          >
            {/* Cover-art header */}
            <div className="relative" style={{ height: 116 }}>
              {cover ? (
                <img src={cover} alt="" className="absolute inset-0 w-full h-full object-cover" style={{ filter: 'brightness(0.55)' }} />
              ) : (
                <div className="absolute inset-0" style={{ background: `linear-gradient(135deg, ${accent}30, rgba(14,14,15,1))` }} />
              )}
              <div className="absolute inset-0" style={{ background: 'linear-gradient(to top, rgba(14,14,15,1) 0%, rgba(14,14,15,0.35) 60%, rgba(14,14,15,0.15) 100%)' }} />
              <button
                onClick={onClose}
                className="absolute top-3 right-3 w-7 h-7 rounded-xl flex items-center justify-center transition-colors hover:bg-white/15"
                style={{ background: 'rgba(0,0,0,0.45)', border: '1px solid rgba(255,255,255,0.12)' }}
              >
                <X size={13} className="text-white/70" />
              </button>
              <div className="absolute left-4 right-4 bottom-3">
                <p className="font-syne font-bold text-white text-base leading-tight truncate" style={{ textShadow: '0 2px 10px rgba(0,0,0,0.8)' }}>
                  Launch Options
                </p>
              </div>
            </div>

            {/* Launch options */}
            <div className="p-3 space-y-2 max-h-[46vh] overflow-y-auto scroll-thin">
              {game.exePath && (
                <VariationRow accent={accent} label={game.name} hint="" onClick={() => onLaunch(game.exePath, game.name)} />
              )}
              {(variations || []).map((v, i) => (
                <VariationRow
                  key={i}
                  accent={accent}
                  label={v.label || v.name}
                  hint=""
                  onClick={() => onLaunch(v.path || v.exePath, v.label || v.name)}
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
