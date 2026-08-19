import React, { useState, useCallback } from 'react'
import { motion } from 'framer-motion'
import { Search, Settings, ZoomIn, ZoomOut, Gamepad2, Save } from 'lucide-react'
import useStore from '../store/useStore'
import { getDefaultAccent } from '../lib/accent'

export default function TopNav({ onSaveLoad }) {
  const { settings, games, activeCategory, setActiveCategory, searchQuery, setSearchQuery, openAdmin, localIPs, updateSettings } = useStore()
  const ota = useStore(s => s.otaBranding)
  const accent = settings.accentColor || getDefaultAccent()

  const visibleGames = React.useMemo(() => {
    const pcGroups = settings.pcGroups || []
    const hasIPDetection = localIPs.length > 0
    const myGroupIds = hasIPDetection
      ? pcGroups.filter(g => (g.ips || []).some(ip => localIPs.includes(ip))).map(g => g.id)
      : []
    const pcIsInAGroup = myGroupIds.length > 0
    return games.filter(game => {
      if (pcIsInAGroup) return (game.pcGroups || []).some(gId => myGroupIds.includes(gId))
      return true
    })
  }, [games, settings.pcGroups, localIPs])

  const usedCategories = new Set(visibleGames.map(g => g.category))

  const defaultCats = [
    { id: 'all', label: 'All Games', alwaysShow: true },
    { id: 'online', label: 'Online' },
    { id: 'offline', label: 'Offline' },
    { id: 'apps', label: 'Apps' },
  ].filter(c => c.alwaysShow || usedCategories.has(c.id))

  const customCats = [...new Set(
    visibleGames.map(g => g.category).filter(c => c && !['online', 'offline', 'apps'].includes(c))
  )].map(c => ({ id: c, label: c.charAt(0).toUpperCase() + c.slice(1) }))

  const categories = [...defaultCats, ...customCats]

  const zoom = settings.uiZoom || 100
  const handleZoom = (delta) => updateSettings({ uiZoom: Math.max(100, Math.min(200, zoom + delta)) })

  const [searchFocused, setSearchFocused] = useState(false)

  // Secret key tap counter to open admin
  const tapRef = React.useRef({ count: 0, timer: null })
  const handleLogoBadgeClick = useCallback(() => {
    const t = tapRef.current
    t.count++
    if (t.timer) clearTimeout(t.timer)
    if (t.count >= 5) { t.count = 0; openAdmin() }
    else { t.timer = setTimeout(() => { t.count = 0 }, 2000) }
  }, [openAdmin])

  return (
    <div
      className="flex items-center gap-3 px-4 flex-shrink-0 relative z-20"
      style={{
        height: '54px',
        background: 'rgba(10,10,11,0.7)',
        backdropFilter: 'blur(24px)',
        borderBottom: '1px solid rgba(255,255,255,0.07)',
      }}
    >
      {/* Logo */}
      <button
        onClick={handleLogoBadgeClick}
        className="flex items-center gap-2.5 flex-shrink-0 group"
        style={{ WebkitAppRegion: 'no-drag' }}
      >
        {(settings.logo || ota?.logoFile) ? (
          <img src={settings.logo || ota?.logoFile} alt="Logo" className="w-8 h-8 rounded-lg object-contain" />
        ) : (
          <div
            className="w-8 h-8 rounded-xl flex items-center justify-center flex-shrink-0 transition-all group-hover:scale-105"
            style={{
              background: `linear-gradient(135deg, ${accent}30, ${accent}10)`,
              border: `1px solid ${accent}30`,
            }}
          >
            <Gamepad2 size={14} style={{ color: accent }} />
          </div>
        )}
        <div className="hidden sm:block">
          <div className="font-syne font-bold text-sm leading-tight text-white/90 tracking-wide">
            {settings.launcherName || ota?.brandName || 'BALOK LOUNGE'}
          </div>
          {(settings.launcherTagline || ota?.subtitle) && (
            <div className="font-jakarta text-[9px] text-muted uppercase tracking-widest leading-tight">
              {settings.launcherTagline || ota?.subtitle}
            </div>
          )}
        </div>
      </button>

      {/* Divider */}
      <div className="w-px h-6 bg-white/[0.07] flex-shrink-0" />

      {/* Category tabs */}
      <div className="flex items-center gap-0.5 flex-1 min-w-0 overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
        {categories.map((cat) => {
          const isActive = activeCategory === cat.id
          return (
            <motion.button
              key={cat.id}
              onClick={() => setActiveCategory(cat.id)}
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.97 }}
              className="relative px-3 py-1.5 rounded-lg text-xs font-jakarta font-semibold whitespace-nowrap transition-colors flex-shrink-0"
              style={isActive ? {
                color: accent,
                background: `${accent}15`,
              } : {
                color: 'rgba(255,255,255,0.45)',
              }}
            >
              {isActive && (
                <motion.div
                  layoutId="balok-active-tab"
                  className="absolute inset-0 rounded-lg"
                  style={{ background: `${accent}12`, border: `1px solid ${accent}25` }}
                  transition={{ type: 'spring', bounce: 0.25, duration: 0.4 }}
                />
              )}
              <span className="relative z-10">{cat.label}</span>
            </motion.button>
          )
        })}
      </div>

      {/* Right actions */}
      <div className="flex items-center gap-2 flex-shrink-0">
        {/* Search */}
        <div
          className="relative flex items-center transition-all"
          style={{ width: searchFocused ? '180px' : '140px' }}
        >
          <Search size={12} className="absolute left-3 text-muted pointer-events-none" />
          <input
            type="text"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            onFocus={() => setSearchFocused(true)}
            onBlur={() => setSearchFocused(false)}
            placeholder="Search…"
            className="w-full pl-8 pr-3 py-1.5 rounded-xl text-xs font-jakarta text-white/80 placeholder:text-white/25 focus:outline-none transition-all"
            style={{
              background: searchFocused ? 'rgba(16,16,18,0.9)' : 'rgba(16,16,18,0.6)',
              border: `1px solid ${searchFocused ? accent + '40' : 'rgba(255,255,255,0.07)'}`,
            }}
          />
        </div>

        {/* Zoom */}
        <div className="flex items-center gap-1">
          <button
            onClick={() => handleZoom(-10)}
            className="w-6 h-6 rounded-lg flex items-center justify-center text-muted hover:text-white transition-colors"
            style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)' }}
          >
            <ZoomOut size={10} />
          </button>
          <span className="font-jakarta text-[10px] text-muted w-9 text-center">{zoom}%</span>
          <button
            onClick={() => handleZoom(10)}
            className="w-6 h-6 rounded-lg flex items-center justify-center text-muted hover:text-white transition-colors"
            style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)' }}
          >
            <ZoomIn size={10} />
          </button>
        </div>

        {/* Save/Load */}
        {settings.saveLoadServerUrl && (
          <button
            onClick={onSaveLoad}
            className="w-7 h-7 rounded-xl flex items-center justify-center transition-all hover:scale-105 active:scale-95"
            style={{ background: `${accent}15`, border: `1px solid ${accent}25` }}
            title="Save & Load"
          >
            <Save size={12} style={{ color: accent }} />
          </button>
        )}

        {/* Admin */}
        <button
          onClick={openAdmin}
          className="w-7 h-7 rounded-xl flex items-center justify-center transition-all hover:scale-105 active:scale-95"
          style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)' }}
          title="Admin Panel"
        >
          <Settings size={12} className="text-muted" />
        </button>
      </div>
    </div>
  )
}
