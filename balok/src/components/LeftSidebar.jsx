import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import {
  Home, LayoutGrid, Zap, Cpu, Monitor, HardDrive, MemoryStick, Globe, Gamepad2
} from 'lucide-react'
import useStore from '../store/useStore'
import { getDefaultAccent } from '../lib/accent'
import { afterGameLaunch } from '../lib/afterLaunch'
import { createGameLaunchPayload, createLaunchAlertPayload } from '../lib/gameLaunchPayload'

/* A game counts as "new" if it was added within this window, so category
   nav items can show a NEW dot when they contain fresh additions. */
const NEW_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

const CATEGORY_META = {
  online:  { label: 'ONLINE',  Icon: Globe },
  offline: { label: 'OFFLINE', Icon: HardDrive },
  apps:    { label: 'APPS',    Icon: LayoutGrid },
}

// Notched "console" corner, matching the Control Deck admin panel's button
// language, so the brand mark and the admin surface feel like one product.
const CLIP_SM = 'polygon(6px 0, 100% 0, 100% calc(100% - 6px), calc(100% - 6px) 100%, 0 100%, 0 6px)'

/* Live "My Rig" telemetry. In the packaged desktop app, electronAPI.getSystemStats()
   reads real CPU/RAM/disk/GPU usage from the PC. Browsers can't read hardware
   stats for security reasons, so outside Electron we just show that clearly
   instead of faking numbers. */
function useRigStats() {
  const [stats, setStats] = useState(null)
  const [supported, setSupported] = useState(!!window.electronAPI?.getSystemStats)
  const timerRef = useRef(null)

  useEffect(() => {
    if (!window.electronAPI?.getSystemStats) { setSupported(false); return }
    setSupported(true)
    let cancelled = false
    const poll = async () => {
      try {
        const s = await window.electronAPI.getSystemStats()
        if (!cancelled) setStats(s)
      } catch { /* keep last known value */ }
    }
    poll()
    timerRef.current = setInterval(poll, 3000)
    return () => { cancelled = true; clearInterval(timerRef.current) }
  }, [])

  return { stats, supported }
}

// Maps Tailwind gradient classes → a single brand hex for the accent strip
const BRAND_COLOR = {
  'from-blue-500':    '#3B82F6',
  'from-gray-500':    '#6B7280',
  'from-red-500':     '#EF4444',
  'from-indigo-500':  '#6366F1',
  'from-orange-500':  '#F97316',
  'from-emerald-500': '#10B981',
  'from-purple-500':  '#A855F7',
  'from-pink-500':    '#EC4899',
  'from-yellow-500':  '#EAB308',
  'from-teal-500':    '#14B8A6',
}
function brandColor(colorClass = '') {
  const key = colorClass.split(' ').find(c => BRAND_COLOR[c])
  return key ? BRAND_COLOR[key] : '#6B7280'
}

function QuickLaunchBtn({ item, onClick }) {
  const [hovered, setHovered] = useState(false)
  const color = brandColor(item.color)

  return (
    <div className="relative" style={{ width: 52 }}>
      <motion.button
        onClick={onClick}
        onHoverStart={() => setHovered(true)}
        onHoverEnd={() => setHovered(false)}
        whileHover={{ y: -2 }}
        whileTap={{ scale: 0.93 }}
        transition={{ type: 'spring', stiffness: 400, damping: 24 }}
        title={item.name}
        className="w-full flex flex-col items-center justify-center gap-0 overflow-hidden relative"
        style={{
          height: 42,
          borderRadius: 8,
          background: hovered ? 'rgba(255,255,255,0.07)' : 'rgba(255,255,255,0.04)',
          border: `1px solid ${hovered ? `${color}40` : 'rgba(255,255,255,0.07)'}`,
          transition: 'background 0.18s, border-color 0.18s',
        }}
      >
        {/* Faint brand-color ambient wash on hover */}
        {hovered && (
          <div
            className="absolute inset-0 pointer-events-none"
            style={{ background: `radial-gradient(ellipse at 50% 100%, ${color}18, transparent 70%)` }}
          />
        )}

        {/* Icon */}
        <div className="relative z-10 flex items-center justify-center" style={{ height: 26 }}>
          {item.iconUrl ? (
            <img src={item.iconUrl} alt={item.name} className="w-5 h-5 object-contain rounded" />
          ) : item.image ? (
            <img src={item.image} alt={item.name} className="w-5 h-5 object-contain rounded" />
          ) : (
            <span
              className="font-bold select-none leading-none"
              style={{
                fontSize: 16,
                color: hovered ? '#fff' : 'rgba(255,255,255,0.65)',
                transition: 'color 0.18s',
                filter: hovered ? `drop-shadow(0 0 6px ${color}99)` : 'none',
              }}
            >
              {item.name?.charAt(0) || '?'}
            </span>
          )}
        </div>

        {/* Thin brand-color strip at bottom */}
        <div
          className="absolute bottom-0 inset-x-0"
          style={{
            height: 2,
            background: color,
            opacity: hovered ? 0.9 : 0.35,
            transition: 'opacity 0.18s',
          }}
        />
      </motion.button>

      {/* Tooltip */}
      <motion.div
        initial={false}
        animate={{ opacity: hovered ? 1 : 0, y: hovered ? 0 : 4 }}
        transition={{ duration: 0.13 }}
        className="absolute pointer-events-none whitespace-nowrap rounded px-2 py-0.5 font-semibold text-white"
        style={{
          bottom: 'calc(100% + 6px)',
          left: '50%',
          transform: 'translateX(-50%)',
          fontSize: 9.5,
          letterSpacing: '0.05em',
          background: 'rgba(10,10,10,0.88)',
          border: '1px solid rgba(255,255,255,0.09)',
          backdropFilter: 'blur(8px)',
          zIndex: 50,
        }}
      >
        {item.name}
      </motion.div>
    </div>
  )
}

/* Compact hero slideshow for the sidebar — reuses the Hero Banner and
   announcement images configured in the Control Deck, crossfading on the
   same interval as the featured banner. */
function SidebarSlideshow({ accent }) {
  const settings = useStore(s => s.settings)
  const images = useMemo(
    () => [settings.bannerImage, ...(settings.announcementImages || [])].filter(Boolean),
    [settings.bannerImage, settings.announcementImages]
  )
  const [idx, setIdx] = useState(0)

  useEffect(() => { if (idx >= images.length) setIdx(0) }, [images.length, idx])
  useEffect(() => {
    if (images.length <= 1) return
    const ms = (settings.announcementSlideInterval || 6) * 1000
    const t = setInterval(() => setIdx(p => (p + 1) % images.length), ms)
    return () => clearInterval(t)
  }, [images.length, settings.announcementSlideInterval])

  if (images.length === 0) return null
  const src = images[Math.min(idx, images.length - 1)]

  return (
    <div className="flex-shrink-0 px-3 pt-3 pb-3 border-t" style={{ borderColor: 'var(--border)' }}>

      {/* Just the image — no frame, no background box, height follows the
          image's own aspect ratio so there is never empty space. */}
      <div className="relative w-full">
        <motion.img
          key={src}
          src={src}
          alt=""
          className="block w-full h-auto"
          style={{ borderRadius: 8 }}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.6 }}
        />
        {images.length > 1 && (
          <div className="absolute bottom-1.5 left-0 right-0 flex justify-center gap-1">
            {images.map((_, i) => (
              <button
                key={i}
                onClick={() => setIdx(i)}
                className="rounded-full transition-all"
                style={{
                  width: i === idx ? 10 : 4, height: 4,
                  background: i === idx ? accent : 'rgba(255,255,255,0.35)',
                }}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )

}

export default function LeftSidebar() {
  const { games, settings, activeCategory, setActiveCategory, localIPs, openAdmin } = useStore()
  const ota = useStore(s => s.otaBranding)
  // Admin-panel values win; per-customer build branding is the default.
  const brandLogo = settings.logo || ota?.logoFile || null
  const brandName = settings.launcherName || ota?.brandName || 'BALOK LOUNGE'
  const brandTagline = settings.launcherTagline || ota?.subtitle || 'COMPUTER SHOP'
  const accent = settings.accentColor || getDefaultAccent()
  const socials = settings.socialLinks || []
  const apps = settings.officeApps || []
  const { stats: rigStats, supported: rigSupported } = useRigStats()

  const RIG_STATS = [
    { label: 'CPU',     pct: rigStats?.cpu },
    { label: 'GPU',     pct: rigStats?.gpu },
    { label: 'RAM',     pct: rigStats?.ram },
    { label: 'STORAGE', pct: rigStats?.storage },
  ]

  /* Real categories present in the library (online/offline/apps + any custom
     ones from the Admin Panel), each flagged NEW when it has a game added
     in the last 7 days — mirrors the tab logic in TopBar.jsx. */
  const visibleGames = useMemo(() => {
    const pcGroups = settings.pcGroups || []
    const hasIP = localIPs.length > 0
    const myGroupIds = hasIP
      ? pcGroups.filter(g => (g.ips || []).some(ip => localIPs.includes(ip))).map(g => g.id)
      : []
    const inGroup = myGroupIds.length > 0
    return games.filter(g => inGroup ? (g.pcGroups || []).some(id => myGroupIds.includes(id)) : true)
  }, [games, settings.pcGroups, localIPs])

  const categoryItems = useMemo(() => {
    const usedCats = [...new Set(visibleGames.map(g => g.category).filter(Boolean))]
    const now = Date.now()
    return usedCats.map(cat => {
      const catGames = visibleGames.filter(g => g.category === cat)
      const meta = CATEGORY_META[cat] || { label: cat.toUpperCase(), Icon: Gamepad2 }
      const isNew = catGames.some(g => g.addedAt && now - g.addedAt < NEW_WINDOW_MS)
      return { id: cat, label: meta.label, Icon: meta.Icon, isNew }
    })
  }, [visibleGames])

  const NAV_ITEMS = [
    { id: 'home', label: 'HOME',      Icon: Home },
    { id: 'all',  label: 'ALL GAMES', Icon: LayoutGrid },
    ...categoryItems,
  ]

  /* secret 5-tap on logo → admin */
  const tapRef = React.useRef({ count: 0, timer: null })
  const handleLogoTap = useCallback(() => {
    const t = tapRef.current
    t.count++
    if (t.timer) clearTimeout(t.timer)
    if (t.count >= 5) { t.count = 0; openAdmin() }
    else t.timer = setTimeout(() => { t.count = 0 }, 2000)
  }, [openAdmin])

  const isActive = (id) => {
    if (id === 'home') return activeCategory === 'all'
    return activeCategory === id
  }

  const handleNav = (id) => {
    setActiveCategory(id === 'home' ? 'all' : id)
  }

  /* combine socials + apps for one quick launch grid */
  const quickLaunch = [
    ...socials.map(s => ({ ...s, _key: `s-${s.id}`, _type: 'social' })),
    ...apps.map(a => ({ ...a, _key: `a-${a.id}`, _type: 'app' })),
  ].slice(0, 30)

  const handleQuickLaunch = async (item) => {
    if (item._type === 'social') {
      if (!item.url || item.url === '#') return
      if (window.electronAPI?.openExternal) {
        window.electronAPI.reportLaunch?.(createLaunchAlertPayload(item, settings))
        window.electronAPI.openExternal(item.url, '')
      }
      else window.open(item.url, '_blank', 'noopener')
      // Same post-launch rule as every other launch path (auto-close/minimize).
      afterGameLaunch(settings)
    } else {
      if (!item.exePath) return
      if (window.electronAPI) {
        const launchRequest = window.electronAPI.launchGame(
          createGameLaunchPayload(item, item.exePath, settings, null, 'Top App')
        )
        afterGameLaunch(settings)
        const res = await launchRequest
        if (!res?.success) toast.error(res?.error || `Could not open ${item.name}`)
      }
    }
  }

  return (
    <div
      className="flex flex-col flex-shrink-0 overflow-hidden"
      style={{ width: 'var(--sidebar-w)', background: 'var(--bg-sidebar)', borderRight: '1px solid var(--border)' }}
    >
      {/* ── Logo / branding — big centered mark, name and tagline stacked below ── */}
      <button
        onClick={handleLogoTap}
        className="group relative flex flex-col items-center gap-2.5 px-4 pt-6 pb-5 border-b flex-shrink-0 overflow-hidden transition-colors"
        style={{ borderColor: 'var(--border)' }}
      >
        {/* Ambient accent wash on hover — the only hint this is interactive */}
        <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none" style={{ background: `radial-gradient(120px 90px at 50% 0%, ${accent}14, transparent 70%)` }} />

        {brandLogo ? (
          <div className="relative w-24 h-24 flex-shrink-0" style={{ perspective: '400px' }}>
            <motion.img
              src={brandLogo}
              alt="Logo"
              className="balok-glitch-logo-base w-full h-full object-contain"
              style={{ transformStyle: 'preserve-3d', position: 'relative', zIndex: 1 }}
              animate={{ rotateY: [20, -20] }}
              transition={{ duration: 2, ease: 'easeInOut', repeat: Infinity, repeatType: 'mirror' }}
            />
            <img
              src={brandLogo}
              alt=""
              aria-hidden="true"
              className="balok-glitch-logo-layer balok-glitch-logo-cyan"
            />
            <img
              src={brandLogo}
              alt=""
              aria-hidden="true"
              className="balok-glitch-logo-layer balok-glitch-logo-magenta"
            />
          </div>
        ) : (
          <div
            className="balok-glitch-mark relative w-24 h-24 flex items-center justify-center flex-shrink-0 text-black text-3xl font-black"
            data-glitch="B"
            style={{ background: `linear-gradient(145deg, ${accent}, ${accent}bb)`, clipPath: CLIP_SM, boxShadow: `0 0 28px ${accent}55` }}
          >
            <span className="absolute inset-x-0 top-0 h-px" style={{ background: 'rgba(255,255,255,0.6)' }} />
            <span className="relative z-[1]">B</span>
          </div>
        )}

        <div className="relative text-center min-w-0 w-full">
          <div className="text-[15px] font-extrabold leading-tight text-white truncate" style={{ letterSpacing: '0.03em' }}>
            {brandName}
          </div>
          <div className="flex items-start justify-center gap-1.5 mt-1.5 px-1">
            <span className="h-px w-2.5 flex-shrink-0 mt-[3px]" style={{ background: `${accent}90` }} />
            <span className="text-[8.5px] leading-[1.35] uppercase tracking-[0.05em]" style={{ color: 'rgba(255,255,255,0.42)' }}>
              {brandTagline}
            </span>
            <span className="h-px w-2.5 flex-shrink-0 mt-[3px]" style={{ background: `${accent}90` }} />
          </div>
        </div>
      </button>

      {/* ── Scrollable body ── */}
      <div className="flex-1 overflow-y-auto" style={{ scrollbarWidth: 'none' }}>

        {/* Navigation */}
        <div className="px-2 pt-2 pb-1">
          {NAV_ITEMS.map(({ id, label, Icon, isNew }) => {
            const active = isActive(id)
            return (
              <button
                key={id}
                onClick={() => handleNav(id)}
                className={`nav-item${active ? ' active' : ''}`}
              >
                <Icon size={13} strokeWidth={active ? 2.2 : 1.7} />
                <span style={{ fontSize: 11 }}>{label}</span>
                {isNew && !active && (
                  <span
                    className="ml-auto px-1.5 py-[1px] rounded text-[8px] font-bold uppercase tracking-wider flex-shrink-0"
                    style={{ background: `${accent}20`, color: accent, border: `1px solid ${accent}40` }}
                  >
                    New
                  </span>
                )}
                {active && (
                  <ChevronRight size={12} className="ml-auto" style={{ color: accent, opacity: 0.7 }} />
                )}
              </button>
            )
          })}
        </div>

        {/* Divider */}
        <div className="mx-3 my-2" style={{ height: 1, background: 'var(--border)' }} />

        {/* My Rig — live hardware telemetry (desktop app only) */}
        <div className="px-3 pb-3">
          <div className="flex items-center justify-between mb-2.5">
            <span className="text-[10px] font-bold uppercase tracking-widest" style={{ color: 'rgba(255,255,255,0.35)' }}>
              My Rig
            </span>
            <div
              className="w-1.5 h-1.5 rounded-full flex-shrink-0"
              title={rigSupported ? 'Live from this PC' : 'Live stats require the desktop app'}
              style={{ background: rigSupported ? '#3DFF6E' : 'rgba(255,255,255,0.25)', boxShadow: rigSupported ? '0 0 6px #3DFF6E' : 'none' }}
            />
          </div>
          <div className="space-y-2.5">
            {RIG_STATS.map(({ label, pct }) => (
              <div key={label}>
                <div className="flex justify-between mb-1">
                  <span className="text-[10px]" style={{ color: 'rgba(255,255,255,0.5)' }}>{label}</span>
                  <span className="text-[10px] font-bold" style={{ color: rigSupported && pct != null ? accent : 'rgba(255,255,255,0.3)' }}>
                    {rigSupported && pct != null ? `${pct}%` : '—'}
                  </span>
                </div>
                <div className="h-[3px] w-full rounded-full" style={{ background: 'rgba(255,255,255,0.07)' }}>
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${rigSupported && pct != null ? pct : 0}%`,
                      background: `linear-gradient(90deg, ${accent}bb, ${accent})`,
                      boxShadow: `0 0 6px ${accent}60`,
                      transition: 'width 0.4s ease',
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Divider */}
        {quickLaunch.length > 0 && (
          <div className="mx-3 my-1" style={{ height: 1, background: 'var(--border)' }} />
        )}

        {/* Quick Launch — icon-only pills, auto-centered for any count */}
        {quickLaunch.length > 0 && (
          <div className="px-3 pt-2 pb-3">
            <div className="text-[10px] font-bold uppercase tracking-widest mb-2.5" style={{ color: 'rgba(255,255,255,0.35)' }}>
              Quick Launch
            </div>
            <div className="flex flex-wrap gap-2 justify-center">
              {quickLaunch.map(item => (
                <QuickLaunchBtn key={item._key} item={item} onClick={() => handleQuickLaunch(item)} />
              ))}
            </div>
          </div>
        )}

      </div>

      {/* Hero slideshow — pinned above the footer so it never scrolls away. */}
      <SidebarSlideshow accent={accent} />

      {/* ── Powered by footer ── */}
      <div
        className="relative px-3 py-2.5 flex-shrink-0 border-t overflow-hidden"
        style={{
          borderColor: 'var(--border)',
          background: `linear-gradient(180deg, ${accent}08 0%, rgba(0,0,0,0.34) 72%)`,
        }}
      >
        <div
          className="absolute inset-x-0 top-0 h-px"
          style={{ background: `linear-gradient(90deg, transparent, ${accent}aa 35%, ${accent}aa 65%, transparent)` }}
        />
        <div
          className="absolute -top-8 left-1/2 w-32 h-16 -translate-x-1/2 rounded-full pointer-events-none"
          style={{ background: `radial-gradient(ellipse, ${accent}18 0%, transparent 70%)` }}
        />

        <div
          className="relative flex items-center gap-2.5 rounded-xl px-2.5 py-2"
          style={{
            background: 'rgba(255,255,255,0.035)',
            border: `1px solid ${accent}22`,
            boxShadow: `inset 0 1px 0 rgba(255,255,255,0.05), 0 6px 16px rgba(0,0,0,0.18)`,
          }}
        >
          <div
            className="w-7 h-7 flex items-center justify-center rounded-lg flex-shrink-0"
            style={{
              background: `${accent}18`,
              border: `1px solid ${accent}45`,
              boxShadow: `0 0 12px ${accent}20`,
              clipPath: CLIP_SM,
            }}
          >
            <Zap size={13} fill={accent} style={{ color: accent, filter: `drop-shadow(0 0 4px ${accent}90)` }} />
          </div>

          <div className="min-w-0 leading-none">
            <div className="text-[7px] font-bold uppercase tracking-[0.22em]" style={{ color: 'rgba(255,255,255,0.36)' }}>
              Powered by
            </div>
            <div className="mt-1 text-[13px] font-black uppercase tracking-[0.12em] truncate" style={{ color: accent, textShadow: `0 0 10px ${accent}50` }}>
              {settings.poweredBy || 'BALOK'}
            </div>
          </div>

          <div className="ml-auto flex flex-col items-end gap-1.5 flex-shrink-0" aria-hidden="true">
            <span className="w-5 h-px" style={{ background: `${accent}80` }} />
            <span className="w-3 h-px" style={{ background: `${accent}45` }} />
          </div>
        </div>
      </div>
    </div>
  )
}

// ChevronRight imported inline to avoid circular
function ChevronRight({ size, className, style }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} style={style}>
      <polyline points="9 18 15 12 9 6" />
    </svg>
  )
}
