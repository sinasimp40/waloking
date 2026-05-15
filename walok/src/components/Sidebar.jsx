import React from 'react'
import { motion } from 'framer-motion'
import { Crown, Gamepad2, Clock, BarChart3, ZoomIn, ZoomOut, Megaphone, ChevronLeft, ChevronRight } from 'lucide-react'
import toast from 'react-hot-toast'
import useStore from '../store/useStore'
import { getDefaultAccent } from '../lib/accent'

export default function Sidebar() {
  const { settings, games, localIPs } = useStore()
  const featuredGames = React.useMemo(() => {
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

  return (
    <div className="w-[150px] md:w-[170px] lg:w-[200px] flex flex-col flex-shrink-0 relative overflow-hidden">
      {settings.background && (
        <div
          className="absolute inset-0 bg-cover bg-center opacity-15"
          style={{ backgroundImage: `url(${settings.background})` }}
        />
      )}
      <div className="absolute inset-0 bg-gradient-to-b from-dark-500/95 via-dark-500/98 to-dark-500" />
      <div className="absolute top-0 right-0 bottom-0 w-px bg-gradient-to-b from-neon-orange/30 via-neon-orange/10 to-neon-orange/30" />

      <div className="relative z-10 flex flex-col h-full min-h-0">
        <LogoSection settings={settings} />
        <div className="flex-1 min-h-0 overflow-y-auto sidebar-scroll flex flex-col">
          <TopPicks featuredGames={featuredGames} />
          <ComputerRates />
          <SocialMedia />
          <OfficeApps />
          <Announcement />
          <ZoomControl />
        </div>
      </div>

      <style>{`
        .sidebar-scroll::-webkit-scrollbar {
          width: 3px;
        }
        .sidebar-scroll::-webkit-scrollbar-track {
          background: transparent;
        }
        .sidebar-scroll::-webkit-scrollbar-thumb {
          background: rgb(var(--accent-rgb) / 0.15);
          border-radius: 3px;
        }
        .sidebar-scroll::-webkit-scrollbar-thumb:hover {
          background: rgb(var(--accent-rgb) / 0.3);
        }
        .sidebar-scroll {
          scrollbar-width: thin;
          scrollbar-color: rgb(var(--accent-rgb) / 0.15) transparent;
        }
      `}</style>
    </div>
  )
}

function LogoSection({ settings }) {
  return (
    <div className="px-3 pt-3 pb-2 border-b border-neon-orange/10 flex-shrink-0">
      <div className="flex flex-col items-center">
        {settings.logo ? (
          <img src={settings.logo} alt="Logo" className="w-20 h-20 object-contain" style={{ filter: 'drop-shadow(0 0 15px rgb(var(--accent-rgb) / 0.3))' }} />
        ) : (
          <motion.div
            animate={{ rotate: [0, 2, -2, 0] }}
            transition={{ duration: 8, repeat: Infinity, ease: 'easeInOut' }}
            className="relative"
          >
            <div className="w-16 h-16 md:w-20 md:h-20 lg:w-24 lg:h-24 hex-clip flex items-center justify-center relative">
              <div className="absolute inset-0 hex-clip bg-gradient-to-br from-neon-orange/20 via-neon-orange/10 to-transparent" />
              <div className="absolute inset-0 hex-clip border-2 border-neon-orange/40" />
              <div className="absolute inset-[3px] hex-clip border border-neon-orange/15" />
              <div className="text-center z-10">
                <Gamepad2 size={28} className="text-neon-orange mx-auto" style={{ filter: 'drop-shadow(0 0 8px rgb(var(--accent-rgb) / 0.5))' }} />
              </div>
            </div>
            <div className="absolute -inset-1 hex-clip border border-neon-orange/10 animate-pulse" style={{ animationDuration: '3s' }} />
          </motion.div>
        )}
      </div>
    </div>
  )
}

function TopPicks({ featuredGames }) {
  const { incrementLaunchCount, settings } = useStore()

  const handleLaunch = async (game) => {
    const exePath = game.exePath || (game.variations?.length > 0 ? game.variations[0].exePath : '')
    const label = game.exePath ? game.name : (game.variations?.length > 0 ? game.variations[0].name : game.name)
    if (window.electronAPI) {
      if (!exePath) {
        toast.error(`No executable set for ${game.name}`)
        return
      }
      const result = await window.electronAPI.launchGame(exePath)
      if (result.success) {
        toast.success(`Launching ${label}...`)
        incrementLaunchCount(game.id)
        if ((settings.autoCloseOnLaunch || settings.kioskMode) && window.electronAPI.closeWindow) {
          setTimeout(() => window.electronAPI.closeWindow(), 1000)
        }
      } else {
        toast.error(result.error || 'Failed to launch game')
      }
    } else {
      toast.success(`Launching ${label}... (preview mode)`)
      incrementLaunchCount(game.id)
    }
  }

  const categoryAccents = {
    online: '#10b981',
    offline: '#3b82f6',
    apps: '#a855f7',
  }

  return (
    <div className="px-3 py-2 border-b border-neon-orange/10">
      <div className="flex items-center gap-1.5 mb-2">
        <Crown size={11} className="text-neon-orange" style={{ filter: 'drop-shadow(0 0 4px rgb(var(--accent-rgb) / 0.5))' }} />
        <span className="font-orbitron text-[9px] text-neon-orange/90 uppercase tracking-[0.15em] font-bold">Top Picks</span>
      </div>

      {featuredGames.length === 0 && (
        <div className="text-white/45 text-[9px] text-center py-2 font-rajdhani italic">No featured games</div>
      )}

      <div className="space-y-1.5">
        {featuredGames.slice(0, 3).map((game, i) => {
          const defaultAccent = settings.accentColor || getDefaultAccent()
          const accent = categoryAccents[game.category] || defaultAccent
          const rankColors = [defaultAccent, '#94a3b8', '#b45309']
          const rankLabels = ['1ST', '2ND', '3RD']
          return (
            <motion.div
              key={game.id}
              whileHover={{ x: 4, scale: 1.03 }}
              whileTap={{ scale: 0.97 }}
              onClick={() => handleLaunch(game)}
              className="relative flex items-center gap-2.5 p-2 rounded-xl cursor-pointer transition-all group overflow-hidden"
              style={{ background: `linear-gradient(135deg, ${accent}08, transparent)` }}
            >
              <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-300"
                style={{ background: `linear-gradient(135deg, ${accent}15, transparent)` }}
              />
              <div className="absolute left-0 top-0 bottom-0 w-0.5 rounded-full transition-all duration-300 group-hover:w-1"
                style={{ background: rankColors[i] }}
              />
              <div className="relative flex-shrink-0">
                <div
                  className="w-11 h-14 rounded-lg overflow-hidden border border-white/10 group-hover:border-neon-orange/40 transition-all flex items-center justify-center shadow-lg"
                  style={{ background: `linear-gradient(145deg, ${accent}25, ${accent}08)` }}
                >
                  {game.icon ? (
                    <img src={game.icon} alt={game.name} className="w-full h-full object-cover" />
                  ) : (
                    <span className="text-neon-orange/50 text-lg font-bold font-orbitron">{game.name[0]}</span>
                  )}
                </div>
                <div
                  className="absolute -top-1 -left-1 px-1 py-0.5 rounded-md flex items-center justify-center text-[6px] font-black font-orbitron text-black shadow-lg"
                  style={{ background: rankColors[i] }}
                >
                  {rankLabels[i]}
                </div>
              </div>
              <div className="min-w-0 flex-1 relative z-10">
                <p className="text-[11px] font-rajdhani font-bold text-white/90 truncate group-hover:text-neon-orange transition-colors leading-tight">
                  {game.name}
                </p>
                <p className="text-[9px] font-rajdhani text-white/60 truncate leading-tight mt-0.5">
                  {game.description || game.category}
                </p>
              </div>
            </motion.div>
          )
        })}
      </div>
    </div>
  )
}

function ComputerRates() {
  const { settings } = useStore()
  const rates = settings.computerRates || []

  if (rates.length === 0) return null

  const tierStyles = [
    { barColor: 'rgb(var(--accent-rgb))', glow: 'rgb(var(--accent-rgb) / 0.35)', borderColor: 'rgb(var(--accent-rgb) / 0.45)', bg: 'rgb(var(--accent-rgb) / 0.08)', label: 'rgb(var(--accent-rgb))', shimmer: 'rgb(var(--accent-rgb) / 0.12)' },
    { barColor: '#f59e0b',                glow: 'rgba(245,158,11,0.3)',           borderColor: 'rgba(245,158,11,0.4)',         bg: 'rgba(245,158,11,0.07)',  label: '#fbbf24',              shimmer: 'rgba(245,158,11,0.1)' },
    { barColor: '#facc15',                glow: 'rgba(250,204,21,0.25)',          borderColor: 'rgba(250,204,21,0.35)',        bg: 'rgba(250,204,21,0.06)',  label: '#fde68a',              shimmer: 'rgba(250,204,21,0.08)' },
  ]

  const maxPrice = Math.max(...rates.map(r => parseFloat(r.price) || 0), 1)

  return (
    <div className="px-3 py-2 border-b border-neon-orange/10">
      <div className="flex items-center gap-1.5 mb-2">
        <BarChart3 size={10} className="text-neon-orange/80" />
        <span className="font-orbitron text-[8px] text-neon-orange/80 uppercase tracking-[0.12em] font-bold">Rates</span>
      </div>
      <div className="space-y-1.5">
        {rates.map((rate, i) => {
          const s = tierStyles[i] || tierStyles[0]
          const pct = Math.round(((parseFloat(rate.price) || 0) / maxPrice) * 100)
          const isTop = i === rates.length - 1
          return (
            <motion.div
              key={i}
              whileHover={{ scale: 1.02, x: 2 }}
              className="relative rounded-lg overflow-hidden cursor-default"
              style={{
                background: s.bg,
                border: `1px solid ${s.borderColor}`,
                boxShadow: isTop ? `0 0 10px ${s.glow}, inset 0 0 10px ${s.shimmer}` : `inset 0 0 8px ${s.shimmer}`,
              }}
            >
              {/* Animated shimmer sweep */}
              <div className="absolute inset-0 pointer-events-none" style={{ animation: `rateShimmer ${4 + i}s ease-in-out infinite` }}>
                <div style={{
                  position: 'absolute', top: 0, bottom: 0, width: '40%',
                  background: `linear-gradient(90deg, transparent, ${s.shimmer}, transparent)`,
                  animation: `rateShimmerSlide ${4 + i * 1.5}s ease-in-out ${i * 0.8}s infinite`,
                }} />
              </div>

              {/* Top row: name + price */}
              <div className="relative flex items-center justify-between px-2.5 pt-2 pb-1">
                <div className="flex items-center gap-1.5">
                  <div className="w-0.5 h-3.5 rounded-full" style={{ background: `linear-gradient(to bottom, ${s.barColor}, transparent)` }} />
                  <span className="text-[9px] font-orbitron font-bold uppercase tracking-wider" style={{ color: 'rgba(255,255,255,0.8)' }}>{rate.name}</span>
                </div>
                <div className="flex items-baseline gap-0.5">
                  <span className="text-[9px] font-rajdhani opacity-60" style={{ color: s.label }}>₱</span>
                  <span className="text-sm font-orbitron font-black leading-none" style={{ color: s.label, textShadow: `0 0 8px ${s.glow}` }}>{rate.price}</span>
                  <span className="text-[7px] text-white/45 font-rajdhani ml-0.5">{rate.unit}</span>
                </div>
              </div>

              {/* Range bar */}
              <div className="px-2.5 pb-2">
                <div className="h-0.5 w-full rounded-full" style={{ background: 'rgba(255,255,255,0.06)' }}>
                  <motion.div
                    initial={{ width: 0 }}
                    animate={{ width: `${pct}%` }}
                    transition={{ duration: 1.2, delay: i * 0.15, ease: 'easeOut' }}
                    className="h-full rounded-full"
                    style={{
                      background: `linear-gradient(90deg, ${s.barColor}99, ${s.barColor})`,
                      boxShadow: `0 0 4px ${s.glow}`,
                    }}
                  />
                </div>
              </div>

              {/* Top tier crown indicator */}
              {isTop && (
                <div className="absolute top-1.5 right-8 pointer-events-none">
                  <motion.div
                    animate={{ opacity: [0.4, 0.9, 0.4] }}
                    transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
                    className="text-[7px]"
                    style={{ color: s.label }}
                  >★</motion.div>
                </div>
              )}
            </motion.div>
          )
        })}
      </div>

      <style>{`
        @keyframes rateShimmerSlide {
          0%   { left: -40%; }
          50%  { left: 140%; }
          100% { left: 140%; }
        }
      `}</style>
    </div>
  )
}

function SocialMedia() {
  const { settings } = useStore()
  const socials = settings.socialLinks || []

  const handleClick = (url) => {
    if (!url || url === '#') return
    if (window.electronAPI?.openExternal) {
      // Pass the admin-configured custom browser path (if any) so the
      // main process spawns that browser instead of the OS default.
      const browserPath = settings.customBrowserEnabled ? (settings.customBrowserPath || '') : ''
      window.electronAPI.openExternal(url, browserPath)
    } else {
      window.open(url, '_blank', 'noopener')
    }
    // Mirror the auto-close behavior used by Top Picks / GameCard so the
    // launcher gets out of the way after the user opens an external link.
    if ((settings.autoCloseOnLaunch || settings.kioskMode) && window.electronAPI?.closeWindow) {
      setTimeout(() => window.electronAPI.closeWindow(), 1000)
    }
  }

  if (socials.length === 0) return null

  return (
    <div className="px-3 py-2 border-b border-neon-orange/10">
      <span className="font-orbitron text-[8px] text-neon-orange/80 uppercase tracking-[0.12em] font-bold block mb-1.5">Social Media</span>
      <div className="flex gap-1.5 justify-center flex-wrap">
        {socials.map((s) => (
          <motion.button
            key={s.id}
            whileHover={{ scale: 1.15, y: -2 }}
            whileTap={{ scale: 0.9 }}
            onClick={() => handleClick(s.url)}
            title={s.name}
            className={`w-8 h-8 rounded-full bg-gradient-to-br ${s.color || 'from-gray-500 to-gray-600'} flex items-center justify-center text-white text-xs shadow-lg cursor-pointer overflow-hidden`}
          >
            {s.image ? <img src={s.image} alt={s.name} className="w-full h-full object-cover" /> : s.icon}
          </motion.button>
        ))}
      </div>
    </div>
  )
}

function OfficeApps() {
  const { settings } = useStore()
  const apps = settings.officeApps || []

  const handleClick = async (app) => {
    if (!app.exePath) {
      toast.error(`No executable set for ${app.name}`)
      return
    }
    if (window.electronAPI) {
      const result = await window.electronAPI.launchGame(app.exePath)
      if (result.success) {
        toast.success(`Opening ${app.name}...`)
        // Honor the same auto-close setting Top Picks / GameCard use so the
        // launcher closes after launching a top-app shortcut.
        if ((settings.autoCloseOnLaunch || settings.kioskMode) && window.electronAPI.closeWindow) {
          setTimeout(() => window.electronAPI.closeWindow(), 1000)
        }
      } else {
        toast.error(result.error || `Could not open ${app.name}`)
      }
    } else {
      toast.success(`Opening ${app.name}... (preview mode)`)
    }
  }

  if (apps.length === 0) return null

  return (
    <div className="px-3 py-2 border-b border-neon-orange/10">
      <span className="font-orbitron text-[8px] text-neon-orange/80 uppercase tracking-[0.12em] font-bold block mb-1.5">Top Apps</span>
      <div className="flex gap-1.5 justify-center flex-wrap">
        {apps.map((app) => (
          <motion.button
            key={app.id}
            whileHover={{ scale: 1.15, y: -2 }}
            whileTap={{ scale: 0.9 }}
            onClick={() => handleClick(app)}
            title={app.name}
            className={`w-8 h-8 rounded-full bg-gradient-to-br ${app.color || 'from-gray-500 to-gray-600'} flex items-center justify-center text-white text-[10px] font-bold shadow-lg cursor-pointer overflow-hidden`}
          >
            {app.image ? <img src={app.image} alt={app.name} className="w-full h-full object-cover" /> : app.icon}
          </motion.button>
        ))}
      </div>
    </div>
  )
}

function escAttr(s) {
  return s.replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}
function safeUrl(u) {
  try { const p = new URL(u); return ['http:', 'https:', 'file:'].includes(p.protocol) ? escAttr(u) : '' } catch { return '' }
}
function safeColor(c) {
  return /^(#[0-9a-fA-F]{3,8}|[a-zA-Z]+|rgba?\([^)]+\))$/.test(c) ? escAttr(c) : ''
}
function safeSize(s) {
  const n = parseInt(s, 10); return (n > 0 && n <= 72) ? n : ''
}

function SidebarBBCode({ text }) {
  if (!text) return null
  let html = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\[b\](.*?)\[\/b\]/gs, '<strong>$1</strong>')
    .replace(/\[i\](.*?)\[\/i\]/gs, '<em>$1</em>')
    .replace(/\[u\](.*?)\[\/u\]/gs, '<u>$1</u>')
    .replace(/\[s\](.*?)\[\/s\]/gs, '<span style="text-decoration:line-through">$1</span>')
    .replace(/\[color=([^\]]+)\](.*?)\[\/color\]/gs, (_, c, t) => { const sc = safeColor(c); return sc ? `<span style="color:${sc}">${t}</span>` : t })
    .replace(/\[size=([^\]]+)\](.*?)\[\/size\]/gs, (_, s, t) => { const ss = safeSize(s); return ss ? `<span style="font-size:${ss}px">${t}</span>` : t })
    .replace(/\[center\](.*?)\[\/center\]/gs, '<div style="text-align:center">$1</div>')
    .replace(/\[url=([^\]]+)\](.*?)\[\/url\]/gs, (_, u, t) => { const su = safeUrl(u); return su ? `<span style="color:rgb(var(--accent-rgb));text-decoration:underline;cursor:pointer" title="${su}">${t}</span>` : t })
    .replace(/\[img\](.*?)\[\/img\]/gs, (_, u) => { const su = safeUrl(u); return su ? `<img src="${su}" style="max-width:100%;border-radius:3px;margin:3px 0" />` : '' })
    .replace(/\[quote\](.*?)\[\/quote\]/gs, '<div style="border-left:2px solid rgb(var(--accent-rgb) / 0.19);padding:3px 6px;margin:3px 0;background:rgb(var(--accent-rgb) / 0.05);border-radius:3px;font-style:italic">$1</div>')
    .replace(/\[hr\]/g, '<hr style="border:none;border-top:1px solid rgb(var(--accent-rgb) / 0.15);margin:4px 0" />')
    .replace(/\[list\](.*?)\[\/list\]/gs, (_, content) => {
      const items = content.split('[*]').filter(s => s.trim()).map(s => `<li>${s.trim()}</li>`).join('')
      return `<ul style="list-style:disc;padding-left:12px">${items}</ul>`
    })
    .replace(/\n/g, '<br/>')
  return <div dangerouslySetInnerHTML={{ __html: html }} />
}

function AnnouncementSlideshow() {
  const { settings } = useStore()
  const images = settings.announcementImages || []
  const interval = (settings.announcementSlideInterval || 5) * 1000
  const [current, setCurrent] = React.useState(0)

  React.useEffect(() => {
    if (images.length <= 1) return
    const timer = window.setInterval(() => {
      setCurrent(prev => (prev + 1) % images.length)
    }, interval)
    return () => window.clearInterval(timer)
  }, [images.length, interval])

  React.useEffect(() => {
    if (current >= images.length) setCurrent(0)
  }, [images.length, current])

  if (images.length === 0) return null

  return (
    <div className="mt-2 relative group">
      <div
        className="rounded-lg overflow-hidden border border-neon-orange/10 bg-dark-500/50 relative w-full"
        style={{ aspectRatio: '16 / 9' }}
      >
        {images.map((img, i) => (
          <img
            key={i}
            src={img}
            alt={`Slide ${i + 1}`}
            className="absolute inset-0 w-full h-full object-cover rounded-lg transition-opacity duration-700"
            style={{ opacity: i === current ? 1 : 0 }}
          />
        ))}
        {images.length > 1 && (
          <>
            <button
              onClick={() => setCurrent((current - 1 + images.length) % images.length)}
              className="absolute left-1 top-1/2 -translate-y-1/2 w-5 h-5 flex items-center justify-center bg-black/60 rounded-full text-white/60 hover:text-neon-orange opacity-0 group-hover:opacity-100 transition-opacity"
            >
              <ChevronLeft size={10} />
            </button>
            <button
              onClick={() => setCurrent((current + 1) % images.length)}
              className="absolute right-1 top-1/2 -translate-y-1/2 w-5 h-5 flex items-center justify-center bg-black/60 rounded-full text-white/60 hover:text-neon-orange opacity-0 group-hover:opacity-100 transition-opacity"
            >
              <ChevronRight size={10} />
            </button>
            <div className="absolute bottom-1.5 left-1/2 -translate-x-1/2 flex gap-1">
              {images.map((_, i) => (
                <button
                  key={i}
                  onClick={() => setCurrent(i)}
                  className={`w-1.5 h-1.5 rounded-full transition-all ${i === current ? 'bg-neon-orange w-3' : 'bg-white/30 hover:bg-white/50'}`}
                />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function Announcement() {
  const { settings } = useStore()
  const announcement = settings.announcement
  const hasImages = (settings.announcementImages || []).length > 0

  if (!announcement && !hasImages) return null

  return (
    <div className="px-3 py-2 border-b border-neon-orange/10">
      <div className="flex items-center gap-1.5 mb-1.5">
        <Megaphone size={10} className="text-neon-orange/80" />
        <span className="font-orbitron text-[8px] text-neon-orange/80 uppercase tracking-[0.12em] font-bold">Announcement</span>
      </div>
      {announcement && (
        <div className="bg-dark-400/50 border border-neon-orange/10 rounded-lg p-2.5">
          <div className="text-[11px] font-rajdhani text-white/90 leading-relaxed break-words">
            <SidebarBBCode text={announcement} />
          </div>
        </div>
      )}
      <AnnouncementSlideshow />
    </div>
  )
}

function ZoomControl() {
  const { settings, updateSettings } = useStore()
  const zoom = settings.uiZoom || 100

  const handleZoom = (delta) => {
    const newZoom = Math.max(100, Math.min(200, zoom + delta))
    updateSettings({ uiZoom: newZoom })
  }

  return (
    <div className="mt-auto px-3 py-2 border-t border-neon-orange/10">
      <div className="flex items-center gap-2">
        <motion.button
          whileHover={{ scale: 1.1 }}
          whileTap={{ scale: 0.9 }}
          onClick={() => handleZoom(-10)}
          className="w-7 h-7 rounded-lg bg-dark-400/60 border border-white/[0.15] flex items-center justify-center text-white/65 hover:text-neon-orange hover:border-neon-orange/40 transition-all"
        >
          <ZoomOut size={12} />
        </motion.button>
        <div className="flex-1 flex items-center justify-center gap-1">
          <ZoomIn size={10} className="text-neon-orange/70" />
          <span className="font-orbitron text-[9px] text-neon-orange/80 font-bold">{zoom}%</span>
        </div>
        <motion.button
          whileHover={{ scale: 1.1 }}
          whileTap={{ scale: 0.9 }}
          onClick={() => handleZoom(10)}
          className="w-7 h-7 rounded-lg bg-dark-400/60 border border-white/[0.15] flex items-center justify-center text-white/65 hover:text-neon-orange hover:border-neon-orange/40 transition-all"
        >
          <ZoomIn size={12} />
        </motion.button>
      </div>
    </div>
  )
}

