import React, { useEffect, useMemo, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Calendar, Clock3, Gamepad2, Play, Sparkles, X } from 'lucide-react'

function parseEventDate(value = '') {
  const cleaned = String(value).replace(/\s*•\s*/, ' ')
  const date = new Date(cleaned)
  return Number.isNaN(date.getTime()) ? null : date
}

function useCountdown(dateValue) {
  const target = useMemo(() => parseEventDate(dateValue), [dateValue])
  const calculate = () => {
    if (!target) return null
    const diff = target.getTime() - Date.now()
    if (diff <= 0) return { past: true, d: 0, h: 0, m: 0, s: 0 }
    return {
      past: false,
      d: Math.floor(diff / 86400000),
      h: Math.floor((diff % 86400000) / 3600000),
      m: Math.floor((diff % 3600000) / 60000),
      s: Math.floor((diff % 60000) / 1000),
    }
  }

  const [remaining, setRemaining] = useState(calculate)
  useEffect(() => {
    setRemaining(calculate())
    const timer = setInterval(() => setRemaining(calculate()), 1000)
    return () => clearInterval(timer)
  }, [target])
  return remaining
}

function CountdownBlock({ countdown, color }) {
  if (!countdown || countdown.past) {
    return (
      <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.14em]" style={{ color: 'rgba(255,255,255,0.45)' }}>
        <Clock3 size={13} style={{ color: `${color}b0` }} />
        Event date reached
      </div>
    )
  }

  const units = [
    ['d', 'Days'],
    ['h', 'Hours'],
    ['m', 'Minutes'],
    ['s', 'Seconds'],
  ]
  return (
    <div className="grid grid-cols-4 gap-2">
      {units.map(([key, label]) => (
        <div key={key} className="rounded-xl px-2 py-2.5 text-center" style={{ background: `${color}12`, border: `1px solid ${color}25` }}>
          <div className="text-lg font-black leading-none tabular-nums" style={{ color, fontFamily: 'Rajdhani, Inter, sans-serif' }}>
            {String(countdown[key]).padStart(2, '0')}
          </div>
          <div className="mt-1 text-[7px] font-bold uppercase tracking-[0.14em]" style={{ color: 'rgba(255,255,255,0.38)' }}>
            {label}
          </div>
        </div>
      ))}
    </div>
  )
}

export default function EventDetailModal({ event, game, accent, onClose, onLaunch }) {
  const color = event?.color || accent
  const eventName = event?.title || event?.name || 'Untitled Event'
  const dateLabel = event?.dateLabel || event?.date || 'Date to be announced'
  const countdown = useCountdown(event?.date)

  useEffect(() => {
    if (!event) return undefined
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [event, onClose])

  const closeModal = (e) => {
    e?.preventDefault()
    e?.stopPropagation()
    onClose()
  }

  return (
    <AnimatePresence>
      {event && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[200] flex items-center justify-center p-4"
          style={{ background: 'rgba(0,0,0,0.78)', backdropFilter: 'blur(10px)' }}
          onMouseDown={(e) => { if (e.target === e.currentTarget) closeModal(e) }}
          onClick={(e) => { if (e.target === e.currentTarget) closeModal(e) }}
        >
          <motion.div
            initial={{ opacity: 0, y: 18, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.98 }}
            transition={{ duration: 0.22, ease: 'easeOut' }}
            role="dialog"
            aria-modal="true"
            aria-labelledby="event-detail-title"
            aria-describedby="event-detail-description"
            className="relative w-full max-w-lg max-h-[calc(100vh-32px)] overflow-y-auto rounded-2xl"
            style={{
              background: '#0d0d0e',
              border: `1px solid ${color}50`,
              boxShadow: `0 24px 80px rgba(0,0,0,0.65), 0 0 38px ${color}18`,
            }}
          >
            <div
              className="relative min-h-[190px] overflow-hidden"
              style={{
                backgroundImage: game?.wallpaper
                  ? `linear-gradient(90deg, rgba(13,13,14,0.96) 0%, rgba(13,13,14,0.74) 52%, rgba(13,13,14,0.34) 100%), linear-gradient(0deg, rgba(13,13,14,0.92) 0%, transparent 62%), url("${game.wallpaper}")`
                  : `radial-gradient(ellipse at 88% 18%, ${color}30 0%, transparent 54%), linear-gradient(145deg, ${color}18, #0d0d0e 68%)`,
                backgroundSize: 'cover',
                backgroundPosition: 'center',
              }}
            >
              <div className="absolute inset-0 pointer-events-none" style={{ background: `linear-gradient(135deg, ${color}18, transparent 45%)` }} />
              <button
                type="button"
                onClick={closeModal}
                aria-label="Close event details"
                className="absolute top-3 right-3 z-10 w-8 h-8 rounded-lg flex items-center justify-center transition-colors hover:bg-white/10"
                style={{ background: 'rgba(0,0,0,0.42)', border: '1px solid rgba(255,255,255,0.16)', color: 'rgba(255,255,255,0.75)' }}
              >
                <X size={15} />
              </button>

              <div className="relative z-10 flex items-end gap-4 p-5 pt-12">
                <div
                  className="w-20 h-20 rounded-2xl overflow-hidden flex items-center justify-center flex-shrink-0"
                  style={{ background: `${color}20`, border: `1px solid ${color}55`, boxShadow: `0 10px 24px rgba(0,0,0,0.35)` }}
                >
                  {game?.icon
                    ? <img src={game.icon} alt="" className="w-full h-full object-cover" onError={(e) => { e.currentTarget.style.display = 'none' }} />
                    : <Gamepad2 size={28} style={{ color: `${color}c0` }} />}
                </div>
                <div className="min-w-0 pb-0.5">
                  <div className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-[8px] font-bold uppercase tracking-[0.16em]" style={{ color, background: `${color}20`, border: `1px solid ${color}40` }}>
                    <Sparkles size={10} />
                    Event details
                  </div>
                  <h2 id="event-detail-title" className="mt-2 text-xl font-black uppercase leading-tight text-white break-words">
                    {eventName}
                  </h2>
                  {game && (
                    <p className="mt-1 text-[9px] font-semibold uppercase tracking-[0.14em]" style={{ color: 'rgba(255,255,255,0.5)' }}>
                      Featuring {game.name}
                    </p>
                  )}
                </div>
              </div>
            </div>

            <div className="space-y-5 p-5">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="flex items-start gap-2.5 rounded-xl p-3" style={{ background: 'rgba(255,255,255,0.035)', border: '1px solid rgba(255,255,255,0.07)' }}>
                  <Calendar size={14} className="mt-0.5 flex-shrink-0" style={{ color }} />
                  <div className="min-w-0">
                    <div className="text-[8px] font-bold uppercase tracking-[0.16em]" style={{ color: 'rgba(255,255,255,0.35)' }}>Scheduled</div>
                    <div className="mt-1 text-[10px] font-semibold leading-relaxed text-white/75 break-words">{dateLabel}</div>
                  </div>
                </div>
                <div className="rounded-xl p-3" style={{ background: `${color}0d`, border: `1px solid ${color}25` }}>
                  <div className="mb-2 text-[8px] font-bold uppercase tracking-[0.16em]" style={{ color: `${color}aa` }}>Countdown</div>
                  <CountdownBlock countdown={countdown} color={color} />
                </div>
              </div>

              <div>
                <div className="mb-2 text-[8px] font-bold uppercase tracking-[0.18em]" style={{ color: 'rgba(255,255,255,0.35)' }}>About this event</div>
                <p id="event-detail-description" className="text-sm leading-relaxed whitespace-pre-wrap break-words" style={{ color: event.description ? 'rgba(255,255,255,0.72)' : 'rgba(255,255,255,0.35)' }}>
                  {event.description || 'More information about this event will be announced soon.'}
                </p>
              </div>

              <div className="flex items-center justify-between gap-3 pt-1">
                <div className="flex items-center gap-2 min-w-0">
                  <div className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: `${color}15`, border: `1px solid ${color}30` }}>
                    {game ? <Gamepad2 size={13} style={{ color }} /> : <Calendar size={13} style={{ color }} />}
                  </div>
                  <span className="text-[9px] font-semibold uppercase tracking-[0.12em] truncate" style={{ color: 'rgba(255,255,255,0.42)' }}>
                    {game ? `Ready to play · ${game.name}` : 'Event information only'}
                  </span>
                </div>
                {game && (
                  <button
                    type="button"
                    onClick={() => onLaunch?.(game)}
                    className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-[9px] font-black uppercase tracking-[0.14em] transition-all hover:brightness-110 active:scale-[0.98] flex-shrink-0"
                    style={{ background: color, color: '#080808', boxShadow: `0 0 18px ${color}35` }}
                  >
                    <Play size={11} fill="currentColor" />
                    Launch game
                  </button>
                )}
                <button
                  type="button"
                  onClick={closeModal}
                  className="px-3 py-2.5 rounded-xl text-[9px] font-black uppercase tracking-[0.14em] transition-colors hover:bg-white/10 flex-shrink-0"
                  style={{ color: 'rgba(255,255,255,0.65)', border: '1px solid rgba(255,255,255,0.13)' }}
                >
                  Close
                </button>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}