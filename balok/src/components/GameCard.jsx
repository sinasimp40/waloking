import React, { useState, memo, useRef, useEffect } from 'react'
import { Play, Zap, Gamepad2 } from 'lucide-react'
import toast from 'react-hot-toast'
import useStore from '../store/useStore'
import { getDefaultAccent } from '../lib/accent'
import { afterGameLaunch } from '../lib/afterLaunch'
import VariationPicker from './VariationPicker'

const categoryConfig = {
  online: { accent: '#10B981', label: 'Online' },
  offline: { accent: '#60A5FA', label: 'Offline' },
  apps: { accent: '#A78BFA', label: 'App' },
  _default: { accent: null, label: '' },
}

const GameCard = memo(function GameCard({ game }) {
  const incrementLaunchCount = useStore(s => s.incrementLaunchCount)
  const accentColor = useStore(s => s.settings.accentColor)
  const showNames = useStore(s => s.settings.showGameNames) !== false
  const autoCloseOnLaunch = useStore(s => s.settings.autoCloseOnLaunch)
  const kioskMode = useStore(s => s.settings.kioskMode)
  const [isHovered, setIsHovered] = useState(false)
  const [imgError, setImgError] = useState(false)
  const [showVariations, setShowVariations] = useState(false)
  const popupRef = useRef(null)
  const defaultAccent = accentColor || getDefaultAccent()
  const validVariations = (game.variations || []).filter(v => v.name && v.exePath)

  const rawCat = categoryConfig[game.category] || { ...categoryConfig._default, label: game.category?.toUpperCase() || '' }
  const cat = { ...rawCat, accent: rawCat.accent || defaultAccent }

  useEffect(() => {
    if (!showVariations) return
    const fn = (e) => { if (popupRef.current && !popupRef.current.contains(e.target)) setShowVariations(false) }
    document.addEventListener('mousedown', fn)
    return () => document.removeEventListener('mousedown', fn)
  }, [showVariations])

  const launchExe = async (exePath, label) => {
    if (!exePath) { toast.error(`No executable set for ${label}`); return }
    if (window.electronAPI) {
      const result = await window.electronAPI.launchGame({
        exePath,
        gameName: game.name,
        variation: label !== game.name ? label : null,
      })
      if (result.success) {
        toast.success(`Launching ${label}…`)
        incrementLaunchCount(game.id)
        afterGameLaunch({ autoCloseOnLaunch, kioskMode })
      } else { toast.error(result.error || 'Failed to launch') }
    } else {
      toast.success(`Launching ${label}… (preview mode)`)
      incrementLaunchCount(game.id)
    }
    setShowVariations(false)
  }

  const handleClick = () => {
    if (validVariations.length > 0) setShowVariations(true)
    else launchExe(game.exePath, game.name)
  }

  return (
    <div className="relative group">
      {/* Wide landscape card — 16:9 */}
      <div
        className="relative w-full overflow-hidden cursor-pointer"
        style={{
          aspectRatio: '16/9',
          borderRadius: '14px',
          transform: isHovered ? 'scale(1.03) translateY(-3px)' : 'scale(1) translateY(0)',
          transition: 'transform 0.3s cubic-bezier(0.22,1,0.36,1)',
          boxShadow: isHovered
            ? `0 0 0 1.5px ${cat.accent}50, 0 16px 40px rgba(0,0,0,0.7), 0 0 30px ${cat.accent}15`
            : '0 0 0 1px rgba(255,255,255,0.05), 0 4px 16px rgba(0,0,0,0.5)',
          willChange: isHovered ? 'transform' : 'auto',
        }}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        onClick={handleClick}
      >
        {/* Game art */}
        {game.icon && !imgError ? (
          <img
            src={game.icon}
            alt={game.name}
            loading="lazy"
            decoding="async"
            className="absolute inset-0 w-full h-full object-cover"
            style={{
              transform: isHovered ? 'scale(1.06)' : 'scale(1)',
              transition: 'transform 0.5s ease-out',
            }}
            onError={() => setImgError(true)}
          />
        ) : (
          <div
            className="absolute inset-0 flex items-center justify-center"
            style={{ background: `linear-gradient(135deg, ${cat.accent}20, rgba(16,16,18,0.9))` }}
          >
            <Gamepad2 size={28} style={{ color: `${cat.accent}40` }} />
          </div>
        )}

        {/* Gradient overlay */}
        <div
          className="absolute inset-0"
          style={{
            background: 'linear-gradient(to top, rgba(10,10,11,0.95) 0%, rgba(10,10,11,0.3) 50%, transparent 100%)',
            opacity: isHovered ? 1 : 0.7,
            transition: 'opacity 0.35s ease',
          }}
        />

        {/* Hover: violet tint wash */}
        <div
          className="absolute inset-0"
          style={{
            background: `linear-gradient(135deg, ${cat.accent}18 0%, transparent 60%)`,
            opacity: isHovered ? 1 : 0,
            transition: 'opacity 0.35s ease',
          }}
        />

        {/* Category badge */}
        <div className="absolute top-2.5 left-2.5 z-10">
          <div
            className="px-2 py-0.5 rounded-full font-jakarta text-[9px] font-semibold backdrop-blur-sm"
            style={{
              background: `${cat.accent}25`,
              border: `1px solid ${cat.accent}35`,
              color: cat.accent,
            }}
          >
            {cat.label}
          </div>
        </div>

        {/* (no version-count badge — variations are shown in the picker) */}


        {/* Play button - center hover */}
        <div
          className="absolute inset-0 z-10 flex items-center justify-center"
          style={{ opacity: isHovered ? 1 : 0, transition: 'opacity 0.25s ease' }}
        >
          <div
            className="w-12 h-12 rounded-full flex items-center justify-center"
            style={{
              background: `linear-gradient(135deg, ${cat.accent}, ${cat.accent}bb)`,
              boxShadow: `0 0 24px ${cat.accent}50`,
              transform: isHovered ? 'scale(1)' : 'scale(0.6)',
              transition: 'transform 0.3s cubic-bezier(0.22,1,0.36,1)',
            }}
          >
            <Play size={18} fill="#fff" className="text-white ml-0.5" />
          </div>
        </div>

        {/* Bottom info */}
        {showNames && (
          <div
            className="absolute bottom-0 left-0 right-0 px-3 pb-2.5 pt-4 z-10"
            style={{
              transform: isHovered ? 'translateY(0)' : 'translateY(4px)',
              transition: 'transform 0.3s ease',
            }}
          >
            <p
              className="font-syne font-bold text-sm leading-tight truncate"
              style={{
                color: isHovered ? 'white' : 'rgba(255,255,255,0.9)',
                textShadow: '0 2px 8px rgba(0,0,0,0.8)',
              }}
            >
              {game.name}
            </p>
            {(game.launchCount || 0) > 0 && (
              <div className="flex items-center gap-1 mt-0.5">
                <Zap size={8} style={{ color: `${cat.accent}80` }} />
                <span className="font-jakarta text-[9px]" style={{ color: `${cat.accent}70` }}>
                  {game.launchCount} plays
                </span>
              </div>
            )}
          </div>
        )}

        {/* Bottom accent line */}
        <div
          className="absolute bottom-0 left-0 right-0 h-[2px] z-20"
          style={{
            background: `linear-gradient(90deg, transparent, ${cat.accent}, transparent)`,
            opacity: isHovered ? 1 : 0,
            transition: 'opacity 0.35s ease',
          }}
        />
      </div>

      <VariationPicker
        open={showVariations}
        game={game}
        accent={defaultAccent}
        variations={validVariations}
        onLaunch={launchExe}
        onClose={() => setShowVariations(false)}
      />
    </div>
  )
})

export default GameCard
