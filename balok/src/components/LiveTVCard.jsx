import React, { useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { Tv, ChevronRight, Shuffle } from 'lucide-react'
import Hls from 'hls.js'
import { MediaPlayer as DashMediaPlayer } from 'dashjs'
import useStore from '../store/useStore'
import { getDefaultAccent } from '../lib/accent'

function parseM3U(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
  const channels = []
  let current = {}
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.startsWith('#EXTINF')) {
      const nameMatch = line.match(/,(.+)$/)
      const groupMatch = line.match(/group-title="([^"]*)"/)
      const logoMatch = line.match(/tvg-logo="([^"]*)"/)
      current = {
        name: nameMatch ? nameMatch[1].trim() : 'Unknown',
        group: groupMatch ? groupMatch[1] : 'General',
        logo: logoMatch ? logoMatch[1] : '',
      }
    } else if (line.startsWith('http') || line.startsWith('rtmp')) {
      if (current.name) {
        channels.push({ ...current, url: line, id: `${current.name}-${i}` })
        current = {}
      }
    }
  }
  return channels
}

// Always-on mini preview: as soon as the launcher is running, this tile pulls the
// playlist, picks a random channel and plays it muted in the sidebar.
export default function LiveTVCard() {
  const { settings, openIPTV } = useStore()
  const accent = settings.accentColor || getDefaultAccent()

  const videoRef = useRef(null)
  const hlsRef = useRef(null)
  const dashRef = useRef(null)
  const [channels, setChannels] = useState([])
  const [channel, setChannel] = useState(null)
  const [live, setLive] = useState(false)

  useEffect(() => {
    const url = settings.iptvLink
    if (!url) return
    let cancelled = false
    fetch(url)
      .then(r => r.text())
      .then(text => {
        if (cancelled) return
        const parsed = parseM3U(text)
        setChannels(parsed)
        if (parsed.length) setChannel(parsed[Math.floor(Math.random() * parsed.length)])
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [settings.iptvLink])

  useEffect(() => {
    const video = videoRef.current
    if (!channel || !video) return
    const destroy = () => {
      if (hlsRef.current) { try { hlsRef.current.destroy() } catch {} hlsRef.current = null }
      if (dashRef.current) { try { dashRef.current.destroy() } catch {} dashRef.current = null }
    }
    destroy()
    setLive(false)
    try { localStorage.setItem('balok-preview-channel', channel.url) } catch {}
    video.muted = true
    const url = channel.url

    if (/\.mpd(\?|$)/i.test(url)) {
      try {
        const player = DashMediaPlayer().create()
        player.initialize(video, url, true)
        player.on('playbackPlaying', () => setLive(true))
        dashRef.current = player
      } catch {}
    } else if (Hls.isSupported()) {
      const hls = new Hls({ maxBufferLength: 6, maxMaxBufferLength: 12 })
      hlsRef.current = hls
      hls.loadSource(url)
      hls.attachMedia(video)
      hls.on(Hls.Events.MANIFEST_PARSED, () => video.play().then(() => setLive(true)).catch(() => {}))
      hls.on(Hls.Events.ERROR, (_e, data) => { if (data.fatal) shuffle() })
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = url
      video.play().then(() => setLive(true)).catch(() => {})
    }
    return destroy
  }, [channel])

  const shuffle = () => {
    if (channels.length < 2) return
    let next = channel
    while (next?.id === channel?.id) next = channels[Math.floor(Math.random() * channels.length)]
    setChannel(next)
  }

  return (
    <motion.div
      whileHover={{ scale: 1.015, y: -1 }}
      onClick={openIPTV}
      className="group w-full rounded-xl overflow-hidden cursor-pointer relative"
      style={{
        background: '#080808',
        border: `1px solid ${accent}35`,
        boxShadow: `0 8px 24px rgba(0,0,0,0.24), inset 0 1px 0 ${accent}18`,
      }}
      aria-label="Open Live TV"
    >
      <div
        className="relative w-full overflow-hidden"
        style={{
          height: 104,
          background: `radial-gradient(ellipse at 50% 110%, ${accent}18 0%, transparent 58%), linear-gradient(145deg, #151515, #070707 72%)`,
        }}
      >
        <video ref={videoRef} muted playsInline className="w-full h-full object-cover" style={{ opacity: live ? 1 : 0, transition: 'opacity .3s' }} />
        {!live && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5">
            <div
              className="w-9 h-9 rounded-xl flex items-center justify-center"
              style={{
                background: `${accent}12`,
                border: `1px solid ${accent}35`,
                boxShadow: `0 0 18px ${accent}18`,
              }}
            >
              <Tv size={18} style={{ color: `${accent}9a` }} />
            </div>
            <span className="text-[7px] font-semibold uppercase tracking-[0.2em]" style={{ color: 'rgba(255,255,255,0.3)' }}>
              Preview
            </span>
          </div>
        )}
        <div className="absolute inset-0 pointer-events-none" style={{ background: 'linear-gradient(to top, rgba(0,0,0,0.58), transparent 55%)' }} />
        <div
          className="absolute top-2 left-2 flex items-center gap-1.5 px-2 py-1 rounded-full"
          style={{
            background: 'rgba(0,0,0,0.62)',
            border: `1px solid ${live ? 'rgba(239,68,68,0.42)' : `${accent}35`}`,
            backdropFilter: 'blur(5px)',
          }}
        >
          <div
            className={`w-1.5 h-1.5 rounded-full ${live ? 'animate-pulse' : ''}`}
            style={{ background: live ? '#f87171' : accent, boxShadow: `0 0 6px ${live ? '#f87171' : accent}` }}
          />
          <span className="text-[7.5px] font-bold uppercase tracking-[0.16em]" style={{ color: live ? '#fca5a5' : `${accent}cc` }}>
            {live ? 'Live' : 'Preview'}
          </span>
        </div>
        <button
          onClick={(e) => { e.stopPropagation(); shuffle() }}
          title="Shuffle channel"
          className="absolute top-2 right-2 w-6 h-6 rounded-lg flex items-center justify-center transition-all group-hover:bg-white/10"
          style={{ background: 'rgba(0,0,0,0.62)', border: '1px solid rgba(255,255,255,0.16)', color: 'rgba(255,255,255,0.72)', backdropFilter: 'blur(5px)' }}
        >
          <Shuffle size={10} />
        </button>
      </div>
      <div
        className="flex items-center gap-2.5 px-3 py-2.5"
        style={{
          background: `linear-gradient(90deg, ${accent}14, ${accent}08 58%, rgba(0,0,0,0.18))`,
          borderTop: `1px solid ${accent}20`,
        }}
      >
        <div
          className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0"
          style={{ background: `${accent}18`, border: `1px solid ${accent}35` }}
        >
          <Tv size={13} style={{ color: accent }} />
        </div>
        <div className="min-w-0 flex-1 text-left">
          <div className="text-[9px] font-bold uppercase tracking-[0.16em]" style={{ color: accent }}>Live TV</div>
          <div
            className="mt-0.5 text-[8px] leading-[1.2] uppercase tracking-[0.08em] line-clamp-2"
            title={channel?.name || 'Connecting…'}
            style={{ color: 'rgba(255,255,255,0.48)' }}
          >
            {channel ? channel.name : 'Connecting…'}
          </div>
        </div>
        <div
          className="w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 transition-transform group-hover:translate-x-0.5"
          style={{ background: `${accent}14`, border: `1px solid ${accent}25` }}
        >
          <ChevronRight size={12} style={{ color: `${accent}b0` }} />
        </div>
      </div>
    </motion.div>
  )
}
