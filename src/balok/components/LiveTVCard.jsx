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
      whileHover={{ scale: 1.015 }}
      onClick={openIPTV}
      className="w-full rounded-xl overflow-hidden cursor-pointer relative"
      style={{ background: '#000', border: `1px solid ${accent}25` }}
    >
      <div className="relative w-full" style={{ height: 92, background: '#0a0a0b' }}>
        <video ref={videoRef} muted playsInline className="w-full h-full object-cover" style={{ opacity: live ? 1 : 0, transition: 'opacity .3s' }} />
        {!live && (
          <div className="absolute inset-0 flex items-center justify-center">
            <Tv size={20} style={{ color: `${accent}45` }} />
          </div>
        )}
        <div className="absolute top-1.5 left-1.5 flex items-center gap-1 px-1.5 py-0.5 rounded-full"
          style={{ background: 'rgba(0,0,0,0.55)', border: '1px solid rgba(239,68,68,0.3)' }}>
          <div className="w-1.5 h-1.5 rounded-full bg-red-400 animate-pulse" />
          <span className="text-[7.5px] font-bold uppercase tracking-widest text-red-300">Live</span>
        </div>
        <button
          onClick={(e) => { e.stopPropagation(); shuffle() }}
          title="Shuffle channel"
          className="absolute top-1.5 right-1.5 w-5 h-5 rounded-md flex items-center justify-center transition-colors"
          style={{ background: 'rgba(0,0,0,0.55)', border: '1px solid rgba(255,255,255,0.12)', color: 'rgba(255,255,255,0.7)' }}
        >
          <Shuffle size={9} />
        </button>
      </div>
      <div className="flex items-center gap-2 px-2.5 py-2" style={{ background: `${accent}10` }}>
        <Tv size={13} style={{ color: accent }} />
        <div className="min-w-0 flex-1 text-left">
          <div className="text-[10px] font-bold uppercase tracking-wider truncate" style={{ color: accent }}>LIVE TV</div>
          <div className="text-[8px] uppercase tracking-widest truncate" style={{ color: 'rgba(255,255,255,0.4)' }}>
            {channel ? channel.name : 'Connecting…'}
          </div>
        </div>
        <ChevronRight size={12} style={{ color: `${accent}60` }} />
      </div>
    </motion.div>
  )
}
