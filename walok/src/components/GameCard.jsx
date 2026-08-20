import React, { useState, memo, useRef, useEffect } from 'react'
import { Play, Zap, Gamepad2, ChevronRight, X } from 'lucide-react'
import toast from 'react-hot-toast'
import useStore from '../store/useStore'
import { getDefaultAccent } from '../lib/accent'

const categoryConfig = {
  online: { accent: '#10b981', text: 'ONLINE', bg: 'from-emerald-500/20 to-emerald-900/40' },
  offline: { accent: '#3b82f6', text: 'OFFLINE', bg: 'from-blue-500/20 to-blue-900/40' },
  apps: { accent: '#a855f7', text: 'APP', bg: 'from-purple-500/20 to-purple-900/40' },
  _default: { accent: null, text: '', bg: 'from-neon-orange/20 to-neon-orange/40' },
}

const GameCard = memo(function GameCard({ game }) {
  const incrementLaunchCount = useStore(s => s.incrementLaunchCount)
  const settings = useStore(s => s.settings)
  const accentColor = settings.accentColor
  const showNames = settings.showGameNames !== false
  const autoCloseOnLaunch = settings.autoCloseOnLaunch || settings.kioskMode
  const [isHovered, setIsHovered] = useState(false)
  const [imgError, setImgError] = useState(false)
  const [isPressed, setIsPressed] = useState(false)
  const [showVariations, setShowVariations] = useState(false)
  const popupRef = useRef(null)
  const defaultAccent = accentColor || getDefaultAccent()
  const cover = game.wallpaper || game.icon

  const validVariations = (game.variations || []).filter(v => v.name && v.exePath)

  useEffect(() => {
    if (!showVariations) return
    const handleClickOutside = (e) => {
      if (popupRef.current && !popupRef.current.contains(e.target)) {
        setShowVariations(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [showVariations])

  const launchExe = async (exePath, label) => {
    if (!exePath) {
      toast.error(`No executable set for ${label}`)
      return
    }
    if (window.electronAPI) {
      const result = await window.electronAPI.launchGame({
        exePath,
        gameName: game.name,
        variation: label !== game.name ? label : null,
        iconPath: game.icon || game.wallpaper || null,
          notificationSettings: {
            notificationEnabled: settings.notificationEnabled,
            notifyGameLaunches: settings.notifyGameLaunches,
            pcName: settings.pcName,
            pcMappings: settings.pcMappings,
            telegramBotToken: settings.telegramBotToken,
            telegramChatId: settings.telegramChatId,
          },
      })
      if (result.success) {
        toast.success(`Launching ${label}...`)
        incrementLaunchCount(game.id)
        if (autoCloseOnLaunch && window.electronAPI.closeWindow) {
          setTimeout(() => window.electronAPI.closeWindow(), 1000)
        }
      } else {
        toast.error(result.error || 'Failed to launch')
      }
    } else {
      toast.success(`Launching ${label}... (preview mode)`)
      incrementLaunchCount(game.id)
    }
    setShowVariations(false)
  }

  const handleCardClick = () => {
    if (validVariations.length > 0) {
      setShowVariations(true)
    } else {
      launchExe(game.exePath, game.name)
    }
  }

  const rawCat = categoryConfig[game.category] || { ...categoryConfig._default, text: game.category?.toUpperCase() || 'OTHER' }
  const cat = { ...rawCat, accent: rawCat.accent || defaultAccent }

  const cardScale = isPressed ? 0.97 : isHovered ? 1.04 : 1
  const cardY = isHovered && !isPressed ? -6 : 0

  return (
    <div className="relative">
      <div
        className="relative cursor-pointer group"
        onPointerEnter={() => setIsHovered(true)}
        onPointerLeave={() => { setIsHovered(false); setIsPressed(false) }}
        onPointerDown={() => setIsPressed(true)}
        onPointerUp={() => setIsPressed(false)}
        onClick={handleCardClick}
        style={{
          transform: `scale(${cardScale}) translateY(${cardY}px)`,
          transition: 'transform 0.25s cubic-bezier(0.22,1,0.36,1)',
          willChange: isHovered ? 'transform' : 'auto',
        }}
      >
        <div
          className="relative w-full aspect-[3/4] rounded-xl overflow-hidden"
          style={{
            boxShadow: isHovered
              ? `0 0 0 1.5px ${cat.accent}90, 0 0 30px ${cat.accent}35, 0 20px 50px rgba(0,0,0,0.8)`
              : '0 0 0 1px rgba(255,255,255,0.06), 0 4px 20px rgba(0,0,0,0.5)',
            transition: 'box-shadow 0.4s ease',
          }}
        >
          {game.icon && !imgError ? (
            <img
              src={game.icon}
              alt={game.name}
              loading="lazy"
              decoding="async"
              className="absolute inset-0 w-full h-full object-cover"
              style={{
                transform: isHovered ? 'scale(1.08)' : 'scale(1)',
                transition: 'transform 0.5s ease-out',
              }}
              onError={() => setImgError(true)}
            />
          ) : (
            <div className="absolute inset-0 bg-dark-500 flex items-center justify-center">
              <Gamepad2 size={40} className="text-white/10" />
            </div>
          )}

          <div
            className="absolute inset-0"
            style={{
              background: `linear-gradient(180deg, transparent 30%, rgba(0,0,0,0.4) 60%, rgba(0,0,0,0.92) 100%)`,
              opacity: isHovered ? 1 : 0.85,
              transition: 'opacity 0.4s ease',
            }}
          />

          <div
            className="absolute inset-0 pointer-events-none"
            style={{
              background: `linear-gradient(180deg, ${cat.accent}12 0%, transparent 40%)`,
              opacity: isHovered ? 1 : 0,
              transition: 'opacity 0.4s ease',
            }}
          />

          <div
            className="absolute inset-0 z-[3] flex items-center justify-center"
            style={{
              opacity: isHovered ? 1 : 0,
              transition: 'opacity 0.25s ease',
              pointerEvents: 'none',
            }}
          >
            <div
              className="absolute inset-0"
              style={{
                background: `radial-gradient(circle at center, ${cat.accent}15 0%, rgba(0,0,0,0.4) 70%)`,
              }}
            />
            <div
              className="relative"
              style={{
                transform: isHovered ? 'scale(1)' : 'scale(0.5)',
                opacity: isHovered ? 1 : 0,
                transition: 'transform 0.3s cubic-bezier(0.22,1,0.36,1), opacity 0.25s ease',
              }}
            >
              <div
                className="w-14 h-14 rounded-full flex items-center justify-center relative z-[1]"
                style={{
                  background: `linear-gradient(135deg, ${cat.accent}, ${cat.accent}cc)`,
                  boxShadow: `0 0 30px ${cat.accent}60, 0 0 60px ${cat.accent}20`,
                }}
              >
                <Play size={22} fill="#000" className="text-black ml-0.5" />
              </div>
              <div
                className="absolute -inset-3 rounded-full"
                style={{
                  border: '1px solid transparent',
                  borderTopColor: `${cat.accent}50`,
                  borderRightColor: `${cat.accent}20`,
                }}
              />
            </div>
          </div>

          {validVariations.length > 0 && (
            <div className="absolute top-2 right-2 z-[5] px-1.5 py-0.5 rounded-md" style={{ background: `${cat.accent}25`, border: `1px solid ${cat.accent}35` }}>
              <span className="font-rajdhani text-[8px] font-bold uppercase tracking-wider" style={{ color: cat.accent }}>{validVariations.length + (game.exePath ? 1 : 0)} ver</span>
            </div>
          )}

          {showNames && (
            <div className="absolute bottom-0 left-0 right-0 p-3 z-[4]">
              <p
                className="font-rajdhani font-bold text-sm leading-tight truncate"
                style={{
                  color: isHovered ? cat.accent : 'rgba(255,255,255,0.95)',
                  textShadow: isHovered ? `0 0 12px ${cat.accent}50` : '0 2px 8px rgba(0,0,0,1)',
                  transition: 'color 0.3s ease, text-shadow 0.3s ease',
                }}
              >
                {game.name}
              </p>
              {(game.launchCount || 0) > 0 && (
                <div className="flex items-center gap-1 mt-0.5">
                  <Zap size={8} style={{ color: `${cat.accent}90` }} />
                  <span className="font-rajdhani text-[8px]" style={{ color: `${cat.accent}60` }}>{game.launchCount} plays</span>
                </div>
              )}
            </div>
          )}

          <div
            className="absolute bottom-0 left-0 right-0 h-[2px] z-[5]"
            style={{
              background: `linear-gradient(90deg, transparent, ${cat.accent}, transparent)`,
              opacity: isHovered ? 1 : 0,
              transform: isHovered ? 'scaleX(1)' : 'scaleX(0)',
              transition: 'opacity 0.4s ease, transform 0.4s ease',
            }}
          />
        </div>
      </div>

      {showVariations && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center p-4"
          style={{
            background: 'radial-gradient(circle at center, rgba(0,0,0,0.52), rgba(0,0,0,0.82))',
            backdropFilter: 'blur(3px)',
          }}
          onMouseDown={() => setShowVariations(false)}
        >
          <div
            ref={popupRef}
            className="relative w-full max-w-[430px] rounded-[18px] overflow-hidden"
            style={{
              background: 'linear-gradient(145deg, rgba(28,28,35,0.98), rgba(10,10,14,0.99))',
              border: `1px solid ${defaultAccent}38`,
              boxShadow: `0 28px 80px rgba(0,0,0,0.82), 0 0 55px ${defaultAccent}14`,
            }}
            onMouseDown={e => e.stopPropagation()}
          >
            <div className="h-[2px]" style={{ background: `linear-gradient(90deg, transparent, ${defaultAccent} 30%, #ffffff 50%, ${defaultAccent} 70%, transparent)` }} />

            <div className="relative h-[112px] overflow-hidden">
              {cover && !imgError ? (
                <img
                  src={cover}
                  alt=""
                  className="absolute inset-0 w-full h-full object-cover"
                  style={{ filter: 'brightness(0.45) saturate(0.8)' }}
                  onError={() => setImgError(true)}
                />
              ) : (
                <div className="absolute inset-0" style={{ background: `linear-gradient(135deg, ${defaultAccent}30, rgba(14,14,15,1))` }} />
              )}
              <div
                className="absolute inset-0"
                style={{ background: 'linear-gradient(to top, rgba(10,10,14,1) 0%, rgba(10,10,14,0.42) 64%, rgba(10,10,14,0.18) 100%)' }}
              />
              <div className="absolute left-[18px] right-14 bottom-4">
                <p className="font-rajdhani text-[10px] font-bold uppercase tracking-[0.15em]" style={{ color: defaultAccent }}>Choose a version</p>
              </div>
              <button
                type="button"
                aria-label="Close edition picker"
                onClick={() => setShowVariations(false)}
                className="absolute top-3 right-3 p-1.5 rounded-lg text-white/60 hover:text-white hover:bg-black/30 transition-colors"
              >
                <X size={16} />
              </button>
            </div>

            <div className="h-px mx-[18px]" style={{ background: `linear-gradient(90deg, ${defaultAccent}40, rgba(255,255,255,0.08), transparent)` }} />

            <div className="p-3 space-y-2">
              {game.exePath && (
                <button
                  onClick={() => launchExe(game.exePath, game.name)}
                  className="w-full flex items-center gap-3 p-3 rounded-xl text-left transition-all duration-200 group/item hover:bg-white/[0.04] hover:translate-x-[3px]"
                  style={{ border: '1px solid transparent' }}
                  onMouseEnter={e => { e.currentTarget.style.borderColor = `${defaultAccent}45` }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = 'transparent' }}
                >
                  <div className="w-8 h-8 rounded-[10px] flex items-center justify-center flex-shrink-0" style={{ background: `${defaultAccent}1f`, color: defaultAccent }}>
                    <Play size={13} fill="currentColor" className="ml-0.5" />
                  </div>
                  <span className="min-w-0 flex-1">
                    <span
                      className="inline-flex mb-1 px-1.5 py-0.5 rounded-[5px] border font-orbitron text-[8px] font-bold tracking-[0.12em] uppercase"
                      style={{ color: defaultAccent, borderColor: `${defaultAccent}45`, background: `${defaultAccent}14` }}
                    >
                      Base game
                    </span>
                    <span className="block font-rajdhani text-[17px] font-semibold leading-none text-white/85 group-hover/item:text-white transition-colors truncate">{game.name}</span>
                    <span className="block mt-1 font-rajdhani text-[11px] tracking-wide text-white/35">Default installation</span>
                  </span>
                  <ChevronRight size={17} className="ml-auto flex-shrink-0 text-white/25 group-hover/item:text-white/55 transition-colors" />
                </button>
              )}

              {validVariations.map((v, i) => (
                <button
                  key={i}
                  onClick={() => launchExe(v.exePath, v.name)}
                  className="w-full flex items-center gap-3 p-3 rounded-xl text-left transition-all duration-200 group/item hover:bg-white/[0.04] hover:translate-x-[3px]"
                  style={{ border: '1px solid transparent' }}
                  onMouseEnter={e => { e.currentTarget.style.borderColor = `${defaultAccent}45` }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = 'transparent' }}
                >
                  <div className="w-8 h-8 rounded-[10px] flex items-center justify-center flex-shrink-0" style={{ background: `${defaultAccent}1f`, color: defaultAccent }}>
                    <Play size={13} fill="currentColor" className="ml-0.5" />
                  </div>
                  <span className="min-w-0 flex-1">
                    <span className="inline-flex mb-1 px-1.5 py-0.5 rounded-[5px] border border-[#8497ff]/25 bg-[#677bff]/10 font-orbitron text-[8px] font-bold tracking-[0.12em] uppercase text-[#a5b8ff]">
                      Variation
                    </span>
                    <span className="block font-rajdhani text-[17px] font-semibold leading-none text-white/85 group-hover/item:text-white transition-colors truncate">{v.name}</span>
                    <span className="block mt-1 font-rajdhani text-[11px] tracking-wide text-white/35">Custom launch setup</span>
                  </span>
                  <ChevronRight size={17} className="ml-auto flex-shrink-0 text-white/25 group-hover/item:text-white/55 transition-colors" />
                </button>
              ))}
            </div>

            <div className="mx-[18px] pt-[13px] pb-[15px] border-t border-white/[0.06] flex items-center justify-between">
              <p className="font-rajdhani text-[11px] text-white/[0.29] tracking-[0.07em] uppercase">{validVariations.length + (game.exePath ? 1 : 0)} editions available</p>
              <p className="font-rajdhani text-[11px] font-bold" style={{ color: defaultAccent }}>Select to play</p>
            </div>
          </div>
        </div>
      )}
    </div>
  )
})

export default GameCard
