import React, { useState, useMemo, useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Megaphone, Trophy, Calendar, ChevronRight, Tv, Plus, ChevronDown, ChevronUp, Zap, Coins, Gem, Crown } from 'lucide-react'
import toast from 'react-hot-toast'
import VolumePin from './VolumePin'
import LiveTVCard from './LiveTVCard'

import useStore from '../store/useStore'
import { getDefaultAccent } from '../lib/accent'
import { afterGameLaunch } from '../lib/afterLaunch'
import { createGameLaunchPayload } from '../lib/gameLaunchPayload'

// Static gradient per name
const GRADIENTS = [
  ['#1a1a2e','#16213e'],['#2d1515','#5c1a1a'],['#0d2b1a','#1a5c35'],
  ['#2b2400','#5c4a00'],['#1a0d2e','#3d1a6b'],
]
function gameGradient(name = '') {
  let h = 0
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) & 0xffffffff
  const g = GRADIENTS[Math.abs(h) % GRADIENTS.length]
  return `linear-gradient(145deg, ${g[0]}, ${g[1]})`
}

const MAX_ANNOUNCE = 3   // announcements visible before "+N more"
const MAX_EVENTS   = 1   // only NextEventCard shown by default

// Parse "May 25, 2024 • 2:00 PM" → Date object
function parseEventDate(str = '') {
  const cleaned = str.replace(/\s*•\s*/, ' ')
  const d = new Date(cleaned)
  return isNaN(d) ? null : d
}

function useCountdown(dateStr) {
  const target = useMemo(() => parseEventDate(dateStr), [dateStr])
  const calc = () => {
    if (!target) return null
    const diff = target - Date.now()
    if (diff <= 0) return { past: true, d: 0, h: 0, m: 0, s: 0 }
    const d = Math.floor(diff / 86400000)
    const h = Math.floor((diff % 86400000) / 3600000)
    const m = Math.floor((diff % 3600000) / 60000)
    const s = Math.floor((diff % 60000) / 1000)
    return { past: false, d, h, m, s }
  }
  const [remaining, setRemaining] = useState(calc)
  useEffect(() => {
    const id = setInterval(() => setRemaining(calc()), 1000)
    return () => clearInterval(id)
  }, [target])
  return remaining
}

function CountUnit({ value, label }) {
  return (
    <div className="flex flex-col items-center gap-0.5">
      <motion.span
        key={value}
        initial={{ y: -6, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.2 }}
        className="text-[15px] font-black leading-none tabular-nums"
        style={{ fontFamily: 'Rajdhani, Inter, sans-serif' }}
      >
        {String(value).padStart(2, '0')}
      </motion.span>
      <span className="text-[7px] uppercase tracking-widest opacity-50">{label}</span>
    </div>
  )
}

function NextEventCard({ ev, onClick, accent }) {
  const color = ev.color || accent
  const countdown = useCountdown(ev.date)
  const eventName = ev.title || ev.name || 'Untitled Event'
  const eventDateLabel = ev.dateLabel || ev.date || ''

  return (
    <motion.div
      onClick={onClick}
      whileHover={{ scale: 1.01 }}
      whileTap={{ scale: 0.98 }}
      className="relative mx-3 mb-2 rounded-xl overflow-hidden cursor-pointer"
      style={{ border: `1px solid ${color}35` }}
    >
      {/* Pulsing ambient glow behind the card */}
      <motion.div
        className="absolute inset-0 rounded-xl pointer-events-none"
        animate={{ opacity: [0.5, 1, 0.5] }}
        transition={{ duration: 2.4, repeat: Infinity, ease: 'easeInOut' }}
        style={{ boxShadow: `0 0 18px ${color}30, inset 0 0 18px ${color}08` }}
      />

      {/* Background gradient */}
      <div className="absolute inset-0 pointer-events-none"
        style={{ background: `linear-gradient(135deg, ${color}12 0%, transparent 60%, ${color}06 100%)` }} />

      {/* Animated shimmer sweep */}
      <motion.div
        className="absolute top-0 bottom-0 pointer-events-none"
        style={{
          width: '45%',
          background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.07), transparent)',
          transform: 'skewX(-12deg)',
        }}
        animate={{ left: ['-50%', '160%'] }}
        transition={{ duration: 2, repeat: Infinity, repeatDelay: 3.5, ease: 'easeInOut' }}
      />

      <div className="relative z-10 px-3 pt-3 pb-3">
        {/* Live indicator row */}
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-1.5">
            <motion.div
              className="w-1.5 h-1.5 rounded-full flex-shrink-0"
              style={{ background: color }}
              animate={{ opacity: [1, 0.2, 1] }}
              transition={{ duration: 1.2, repeat: Infinity }}
            />
            <span className="text-[8px] font-bold uppercase tracking-[0.12em]"
              style={{ color: `${color}cc` }}>Next Event</span>
          </div>
          <Zap size={11} style={{ color: `${color}80` }} />
        </div>

        {/* Event name */}
        <p className="text-[12px] font-black uppercase tracking-wide leading-snug mb-2"
          style={{ color, textShadow: `0 0 12px ${color}60` }}>
          {eventName}
        </p>

        <div className="flex items-center gap-1.5 mb-1.5">
          <Calendar size={9} style={{ color: `${color}90` }} />
          <span className="text-[9px] font-semibold uppercase tracking-wider"
            style={{ color: 'rgba(255,255,255,0.58)' }}>
            {eventDateLabel}
          </span>
        </div>

        {ev.description && (
          <p className="text-[10px] leading-snug mb-2 line-clamp-2"
            style={{ color: 'rgba(255,255,255,0.48)' }}>
            {ev.description}
          </p>
        )}

        {/* Divider */}
        <div className="mb-2.5" style={{ height: 1, background: `${color}25` }} />

        {/* Countdown or date */}
        {countdown && !countdown.past ? (
          <div className="flex items-start gap-3">
            <CountUnit value={countdown.d} label="days" />
            <span className="text-[13px] font-black opacity-40 mt-0.5">:</span>
            <CountUnit value={countdown.h} label="hrs" />
            <span className="text-[13px] font-black opacity-40 mt-0.5">:</span>
            <CountUnit value={countdown.m} label="min" />
            <span className="text-[13px] font-black opacity-40 mt-0.5">:</span>
            <CountUnit value={countdown.s} label="sec" />
          </div>
        ) : (
          <div className="flex items-center gap-1.5">
            <Calendar size={9} style={{ color: `${color}80` }} />
            <span className="text-[10px] font-semibold" style={{ color: 'rgba(255,255,255,0.5)' }}>
              {ev.date}
            </span>
          </div>
        )}
      </div>
    </motion.div>
  )
}

// Approximate item heights in px
const H = {
  banner: 90, rate: 44, sectionHeader: 42,
  announceItem: 76, nextCard: 166, eventRow: 60,
  liveTV: 70, moreBtn: 28, padding: 16,
}

export default function RightPanel() {
  const { settings, games, openIPTV, incrementLaunchCount } = useStore()
  const accent = settings.accentColor || getDefaultAccent()
  const rates = settings.computerRates || []
  const announcement = settings.announcement || ''
  const announceImgs = settings.announcementImages || []

  const [showAllAnnouncements, setShowAllAnnouncements] = useState(false)
  const [showAllEvents, setShowAllEvents] = useState(false)

  // Dynamic limits computed from measured container height
  const containerRef = useRef(null)
  const [dynAnnounce, setDynAnnounce] = useState(MAX_ANNOUNCE)
  const [dynEvents,   setDynEvents]   = useState(MAX_EVENTS)

  const topPicks = useMemo(() =>
    games.filter(g => g.topPickRank).sort((a, b) => a.topPickRank - b.topPickRank).slice(0, 3),
    [games]
  )

  // Admin-managed announcement posts (Admin Panel → Announce → Posts).
  const postedAnnouncements = settings.announcementsList || []
  const announcements = announcement
    ? [{ id: 'custom', title: 'Announcement', body: announcement, date: 'Now', color: accent }, ...postedAnnouncements]
    : postedAnnouncements

  // Admin-managed events (Admin Panel → Events).
  const upcomingEvents = useMemo(() =>
    [...(settings.upcomingEventsList || [])]
      .filter(Boolean)
      .sort((a, b) => String(a.date || '').localeCompare(String(b.date || ''))),
    [settings.upcomingEventsList]
  )

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const compute = () => {
      const total = el.clientHeight
      // Fixed overhead: banner + rates + 2 section headers + next-event card + live-tv + padding
      const fixed =
        (settings.panelBanner ? H.banner : 0) +
        rates.length * H.rate +
        H.sectionHeader * 2 +
        H.nextCard +
        H.padding

      const free = total - fixed
      if (free <= 0) { setDynAnnounce(MAX_ANNOUNCE); setDynEvents(MAX_EVENTS); return }

      // 60 % to announcements, 40 % to extra event rows
      const forAnnounce = free * 0.60
      const forEvents   = free * 0.40

      const newA = Math.max(MAX_ANNOUNCE, Math.floor(forAnnounce / H.announceItem))
      const newE = Math.max(MAX_EVENTS,   Math.floor(forEvents   / H.eventRow) + 1)

      setDynAnnounce(newA)
      setDynEvents(newE)
    }

    compute()
    const obs = new ResizeObserver(compute)
    obs.observe(el)
    return () => obs.disconnect()
  }, [rates.length, settings.panelBanner])

  const launchGame = async (game) => {
    const exePath = game.exePath || game.variations?.[0]?.exePath || ''
    if (window.electronAPI) {
      if (!exePath) { toast.error(`No exe for ${game.name}`); return }
      const variation = game.exePath ? null : (game.variations?.[0]?.name || null)
      const launchRequest = window.electronAPI.launchGame(
        createGameLaunchPayload(game, exePath, settings, variation)
      )
      afterGameLaunch(settings)
      const r = await launchRequest
      if (r.success) {
        toast.success(`Launching ${game.name}…`); incrementLaunchCount(game.id)
      } else toast.error(r.error || 'Failed')
    } else { toast.success(`Launching ${game.name}… (preview)`); incrementLaunchCount(game.id) }
  }

  return (
    <div className="flex flex-col flex-shrink-0 overflow-hidden"
      style={{ width: 'var(--rightpanel-w)', background: 'var(--bg-panel)', borderLeft: '1px solid var(--border)' }}>
      <div ref={containerRef} className="flex-1 overflow-y-auto flex flex-col" style={{ scrollbarWidth: 'none' }}>

        {/* ── Banner ── */}
        {settings.panelBanner && (
          <div className="flex-shrink-0 border-b" style={{ borderColor: 'var(--border)' }}>
            {/* Image only — natural aspect ratio, no fixed box, no filler */}
            <img src={settings.panelBanner} alt="" className="block w-full h-auto" />
          </div>
        )}


        {/* ── Hero Banner ── */}
        {settings.heroBanner && (
          <div className="flex-shrink-0 border-b" style={{ borderColor: 'var(--border)' }}>
            <img src={settings.heroBanner} alt="" className="block w-full h-auto" />
          </div>
        )}

        {/* ── Coins / Rates ── */}
        {rates.length > 0 && (
          <div className="border-b" style={{ borderColor: 'var(--border)' }}>
            {rates.map((rate, i) => {
              const colors = [accent, '#60A5FA', '#F59E0B']
              const c = colors[i] || accent
              const iconNodes = [<Coins size={12} />, <Gem size={12} />, <Crown size={12} />]
              return (
                <div key={i} className="flex items-center justify-between px-4 py-2.5 border-b hover:bg-white/[0.02] transition-all"
                  style={{ borderColor: i < rates.length - 1 ? 'var(--border)' : 'transparent' }}>
                  <div className="flex items-center gap-2">
                    <div className="w-6 h-6 rounded-lg flex items-center justify-center flex-shrink-0"
                      style={{ background: `${c}15`, border: `1px solid ${c}25` }}>
                      <span style={{ color: c }}>{iconNodes[i] || <Coins size={12} />}</span>
                    </div>
                    <div>
                      <div className="text-[10px] font-semibold uppercase tracking-wider"
                        style={{ color: 'rgba(255,255,255,0.5)' }}>{rate.name}</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-[15px] font-black" style={{ color: c, fontFamily: 'Rajdhani, Inter, sans-serif' }}>
                      {rate.price}
                    </span>
                    <span className="text-[9px]" style={{ color: `${c}70` }}>{rate.unit}</span>
                    <button className="w-5 h-5 rounded flex items-center justify-center ml-1"
                      style={{ background: `${c}20`, border: `1px solid ${c}30` }}>
                      <ChevronRight size={9} style={{ color: c }} />
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {/* ── Announcements ── */}
        <div className="border-b" style={{ borderColor: 'var(--border)' }}>
          <div className="flex items-center justify-between px-4 py-2.5">
            <div className="flex items-center gap-1.5">
              <Megaphone size={11} style={{ color: accent }} />
              <span className="text-[11px] font-bold uppercase tracking-widest"
                style={{ color: 'rgba(255,255,255,0.7)' }}>Announcements</span>
            </div>
            {announcements.length > dynAnnounce && (
              <button
                onClick={() => setShowAllAnnouncements(v => !v)}
                className="flex items-center gap-0.5 text-[9px] font-semibold uppercase tracking-wider transition-opacity hover:opacity-80"
                style={{ color: accent }}
              >
                {showAllAnnouncements ? 'Show Less' : 'View All'}
                {showAllAnnouncements ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
              </button>
            )}
          </div>
          <div className="pb-1">
            {(showAllAnnouncements ? announcements : announcements.slice(0, dynAnnounce)).map(a => (
              <div key={a.id}
                className="flex gap-2.5 px-4 py-2 hover:bg-white/[0.025] transition-all cursor-pointer border-b"
                style={{ borderColor: 'rgba(255,255,255,0.04)' }}>
                <div className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5"
                  style={{ background: `${a.color}18`, border: `1px solid ${a.color}25` }}>
                  <Megaphone size={11} style={{ color: a.color }} />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-[11px] font-bold text-white/85 leading-snug">{a.title}</p>
                  <p className="text-[9px] mt-0.5 leading-relaxed"
                    style={{ color: 'rgba(255,255,255,0.45)' }}>{a.body}</p>
                  <p className="text-[8px] mt-1" style={{ color: 'rgba(255,255,255,0.25)' }}>{a.date}</p>
                </div>
              </div>
            ))}
            {!showAllAnnouncements && announcements.length > dynAnnounce && (
              <button
                onClick={() => setShowAllAnnouncements(true)}
                className="w-full py-1.5 text-[9px] font-semibold uppercase tracking-wider transition-opacity hover:opacity-80 flex items-center justify-center gap-1"
                style={{ color: 'rgba(255,255,255,0.3)' }}
              >
                +{announcements.length - dynAnnounce} more
                <ChevronDown size={9} />
              </button>
            )}
          </div>
        </div>

        {/* ── Upcoming Events ── */}
        <div className="border-b" style={{ borderColor: 'var(--border)' }}>
          <div className="flex items-center justify-between px-4 py-2.5">
            <div className="flex items-center gap-1.5">
              <Calendar size={11} style={{ color: accent }} />
              <span className="text-[11px] font-bold uppercase tracking-widest"
                style={{ color: 'rgba(255,255,255,0.7)' }}>Upcoming Events</span>
            </div>
            {upcomingEvents.length > dynEvents && (
              <button
                onClick={() => setShowAllEvents(v => !v)}
                className="flex items-center gap-0.5 text-[9px] font-semibold uppercase tracking-wider transition-opacity hover:opacity-80"
                style={{ color: accent }}
              >
                {showAllEvents ? 'Show Less' : 'View All'}
                {showAllEvents ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
              </button>
            )}
          </div>
          <div className="pb-1">
            {(showAllEvents ? upcomingEvents : upcomingEvents.slice(0, dynEvents)).map((ev, idx) => {
              if (idx === 0) {
                return (
                  <NextEventCard key={ev.id} ev={ev} accent={accent}
                    onClick={() => ev.game && launchGame(ev.game)} />
                )
              }
              const hasGame = ev.game
              const thumbBg = hasGame ? gameGradient(ev.name) : (ev.color ? `linear-gradient(135deg, ${ev.color}33, ${ev.color}11)` : 'rgba(255,255,255,0.05)')
              const eventName = ev.title || ev.name || 'Untitled Event'
              const eventDateLabel = ev.dateLabel || ev.date || ''
              return (
                <motion.div key={ev.id} whileHover={{ x: 2 }}
                  className="flex gap-2.5 px-3 py-2.5 cursor-pointer border-b transition-all"
                  style={{ borderColor: 'rgba(255,255,255,0.04)' }}
                  onClick={() => hasGame && launchGame(ev.game)}>
                  <div className="w-8 h-8 rounded-lg overflow-hidden flex-shrink-0 flex items-center justify-center"
                    style={{ background: thumbBg, border: '1px solid rgba(255,255,255,0.07)' }}>
                    {hasGame && ev.game.icon
                      ? <img src={ev.game.icon} alt="" className="w-full h-full object-cover" onError={e => e.target.style.display = 'none'} />
                      : <span style={{ fontSize: 14 }}>🎮</span>}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-[10px] font-bold leading-tight uppercase tracking-wide truncate"
                      style={{ color: ev.color || 'rgba(255,255,255,0.75)' }}>{eventName}</p>
                    <p className="text-[9px] mt-0.5" style={{ color: 'rgba(255,255,255,0.42)' }}>{eventDateLabel}</p>
                    {ev.description && (
                      <p className="text-[9px] mt-0.5 leading-tight line-clamp-2"
                        style={{ color: 'rgba(255,255,255,0.3)' }}>{ev.description}</p>
                    )}
                  </div>
                </motion.div>
              )
            })}
            {!showAllEvents && upcomingEvents.length > dynEvents && (
              <button
                onClick={() => setShowAllEvents(true)}
                className="w-full py-1.5 text-[9px] font-semibold uppercase tracking-wider transition-opacity hover:opacity-80 flex items-center justify-center gap-1"
                style={{ color: 'rgba(255,255,255,0.3)' }}
              >
                +{upcomingEvents.length - dynEvents} more
                <ChevronDown size={9} />
              </button>
            )}
          </div>
        </div>

      </div>

      {/* ── Volume — pinned above Live TV ── */}
      <VolumePin accent={accent} />

      {/* ── IPTV — pinned footer, always fully visible ── */}
      {settings.showIPTV && (
        <div className="px-4 py-3 border-t flex-shrink-0" style={{ borderColor: 'var(--border)' }}>
          <LiveTVCard />
        </div>
      )}

    </div>
  )
}
