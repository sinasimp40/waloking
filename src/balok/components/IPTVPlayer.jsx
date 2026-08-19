import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { motion } from 'framer-motion'
import { X, Search, Tv, Signal, Volume2, VolumeX, ChevronLeft, ChevronRight, Loader2, WifiOff, RefreshCw } from 'lucide-react'
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

// A medium, movable, resizable popup window — distinct from a fixed
// full-screen overlay so it can sit alongside the launcher instead of
// blocking it. Geometry lives in plain state; refs mirror it so the
// mousemove handlers (registered once) always read the latest values.
const MIN_W = 640, MIN_H = 420

function ChannelLogo({ src, name, accent, active }) {
  const [err, setErr] = useState(false)
  useEffect(() => setErr(false), [src])
  return (
    <div
      className="w-8 h-8 rounded-xl flex-shrink-0 flex items-center justify-center overflow-hidden transition-colors"
      style={{ background: active ? `${accent}1c` : 'rgba(255,255,255,0.05)', border: `1px solid ${active ? accent + '45' : 'rgba(255,255,255,0.08)'}` }}
    >
      {src && !err
        ? <img src={src} alt="" onError={() => setErr(true)} className="w-full h-full object-contain p-1" />
        : <Signal size={12} style={{ color: active ? accent : 'rgba(255,255,255,0.25)' }} />}
    </div>
  )
}

export default function IPTVPlayer() {
  const { closeIPTV, settings } = useStore()
  const accent = settings.accentColor || getDefaultAccent()

  // ── Window geometry ──────────────────────────────────────────────────────
  const initW = useMemo(() => Math.min(880, Math.max(MIN_W, window.innerWidth - 60)), [])
  const initH = useMemo(() => Math.min(600, Math.max(MIN_H, window.innerHeight - 60)), [])
  const [panelW, setPanelW] = useState(initW)
  const [panelH, setPanelH] = useState(initH)
  const [winX, setWinX] = useState(() => Math.round((window.innerWidth - initW) / 2))
  const [winY, setWinY] = useState(() => Math.round((window.innerHeight - initH) / 2))

  const panelWRef = useRef(panelW); useEffect(() => { panelWRef.current = panelW }, [panelW])
  const panelHRef = useRef(panelH); useEffect(() => { panelHRef.current = panelH }, [panelH])
  const winXRef = useRef(winX); useEffect(() => { winXRef.current = winX }, [winX])
  const winYRef = useRef(winY); useEffect(() => { winYRef.current = winY }, [winY])

  const onTitleDown = useCallback((e) => {
    if (e.button !== 0) return
    e.preventDefault()
    const sx = e.clientX - winXRef.current
    const sy = e.clientY - winYRef.current
    const onMove = (mv) => {
      setWinX(Math.max(8, Math.min(window.innerWidth - panelWRef.current - 8, mv.clientX - sx)))
      setWinY(Math.max(8, Math.min(window.innerHeight - panelHRef.current - 8, mv.clientY - sy)))
    }
    const onUp = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [])

  const onResizeDown = useCallback((e) => {
    if (e.button !== 0) return
    e.preventDefault(); e.stopPropagation()
    const sx = e.clientX, sy = e.clientY
    const sw = panelWRef.current, sh = panelHRef.current
    const onMove = (mv) => {
      setPanelW(Math.max(MIN_W, Math.min(window.innerWidth - winXRef.current - 8, sw + mv.clientX - sx)))
      setPanelH(Math.max(MIN_H, Math.min(window.innerHeight - winYRef.current - 8, sh + mv.clientY - sy)))
    }
    const onUp = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [])

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') closeIPTV() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [closeIPTV])

  const videoRef = useRef(null)
  const hlsRef = useRef(null)
  const dashRef = useRef(null)
  const [channels, setChannels] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [current, setCurrent] = useState(null)
  const [muted, setMuted] = useState(false)
  const [volume, setVolume] = useState(() => {
    const saved = parseFloat(localStorage.getItem('balok-iptv-volume'))
    return Number.isFinite(saved) ? Math.min(1, Math.max(0, saved)) : 1
  })

  // Applied imperatively on every input event so the audio level changes on
  // the exact same frame the slider moves — no re-render round trip, no delay.
  const applyVolume = (v) => {
    const clamped = Math.min(1, Math.max(0, v))
    if (videoRef.current) {
      videoRef.current.volume = clamped
      if (clamped > 0 && videoRef.current.muted) videoRef.current.muted = false
    }
    if (clamped > 0 && muted) setMuted(false)
    setVolume(clamped)
    try { localStorage.setItem('balok-iptv-volume', String(clamped)) } catch {}
  }
  const [search, setSearch] = useState('')
  const [activeGroup, setActiveGroup] = useState('all')
  const [vidStatus, setVidStatus] = useState('idle')
  const [vidError, setVidError] = useState(null)

  useEffect(() => {
    const url = settings.iptvLink
    if (!url) { setError('No IPTV link configured.'); setLoading(false); return }
    setLoading(true); setError(null)
    fetch(url)
      .then(r => r.text())
      .then(text => {
        const parsed = parseM3U(text)
        setChannels(parsed)
        if (parsed.length > 0) {
          // Open on the channel currently previewing in the sidebar tile, if any
          let preferred = null
          try {
            const pinned = localStorage.getItem('balok-preview-channel')
            if (pinned) preferred = parsed.find(c => c.url === pinned) || null
          } catch {}
          setCurrent(preferred || parsed[0])
        }

        setLoading(false)
      })
      .catch(() => { setError('Failed to load playlist.'); setLoading(false) })
  }, [settings.iptvLink])

  // Stream loader — auto-detects DASH (.mpd) vs HLS (.m3u8/everything else),
  // mirroring the walok player so the same playlists work in both launchers.
  useEffect(() => {
    if (!current || !videoRef.current) return
    const destroyPlayers = () => {
      if (hlsRef.current) { try { hlsRef.current.destroy() } catch {} hlsRef.current = null }
      if (dashRef.current) { try { dashRef.current.destroy() } catch {} dashRef.current = null }
    }
    destroyPlayers()
    const video = videoRef.current
    
    // Reset video element state fully
    video.pause()
    video.removeAttribute('src')
    video.load()
    
    video.volume = volume
    video.muted = muted
    setVidStatus('loading'); setVidError(null)
    const url = current.url
    const isDash = /\.mpd(\?|$)/i.test(url)

    const attemptPlay = () => {
      video.play()
        .then(() => setVidStatus('playing'))
        .catch((err) => {
          console.warn('Autoplay failed, trying muted:', err)
          video.muted = true
          video.play()
            .then(() => setVidStatus('playing'))
            .catch((err2) => {
              console.error('Final playback failure:', err2)
              setVidStatus('error')
              setVidError('Playback blocked. Click to retry.')
            })
        })
    }

    if (isDash) {
      // MPEG-DASH stream via dash.js
      try {
        const player = DashMediaPlayer().create()
        player.initialize(video, url, true)
        player.on('playbackPlaying', () => setVidStatus('playing'))
        player.on('playbackError', () => { setVidStatus('error'); setVidError('Stream unavailable or format unsupported') })
        dashRef.current = player
      } catch {
        setVidStatus('error'); setVidError('DASH playback not supported')
      }
    } else if (Hls.isSupported()) {
      const hls = new Hls({ 
        maxBufferLength: 10, 
        maxMaxBufferLength: 20,
        enableWorker: true,
        lowLatencyMode: true
      })
      hlsRef.current = hls
      hls.loadSource(url)
      hls.attachMedia(video)
      hls.on(Hls.Events.MANIFEST_PARSED, attemptPlay)
      hls.on(Hls.Events.ERROR, (_e, data) => { 
        if (data.fatal) { 
          console.error('HLS Fatal Error:', data)
          setVidStatus('error')
          setVidError('Stream unavailable or format unsupported') 
        } 
      })
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = url
      attemptPlay()
    } else {
      setVidStatus('error'); setVidError('This stream format is not supported')
    }
    return destroyPlayers
  }, [current])

  useEffect(() => {
    if (!videoRef.current) return
    videoRef.current.muted = muted
    videoRef.current.volume = volume
  }, [muted, volume])

  const groups = useMemo(() => ['all', ...new Set(channels.map(c => c.group))], [channels])
  const filtered = useMemo(() => channels.filter(c => {
    const matchGroup = activeGroup === 'all' || c.group === activeGroup
    const matchSearch = !search || c.name.toLowerCase().includes(search.toLowerCase())
    return matchGroup && matchSearch
  }), [channels, activeGroup, search])

  const navigate = (dir) => {
    if (!current || filtered.length === 0) return
    const idx = filtered.findIndex(c => c.id === current.id)
    const next = filtered[(idx + dir + filtered.length) % filtered.length]
    if (next) setCurrent(next)
  }

  return (
    <div className="fixed inset-0 z-[80]" style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(18px)' }} onMouseDown={(e) => { if (e.target === e.currentTarget) closeIPTV() }}>
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: 0.18, ease: 'easeOut' }}
        className="absolute flex flex-col overflow-hidden rounded-[26px]"
        style={{
          left: winX, top: winY, width: panelW, height: panelH,
          background: 'linear-gradient(180deg, rgba(20,20,22,0.98), rgba(12,12,13,0.98))',
          border: `1px solid ${accent}2a`,
          boxShadow: `0 30px 80px -20px rgba(0,0,0,0.7), 0 0 0 1px rgba(255,255,255,0.03), 0 0 60px -20px ${accent}30`,
        }}
      >
        {/* Title bar — draggable */}
        <div
          onMouseDown={onTitleDown}
          className="flex items-center gap-2.5 px-4 py-3 flex-shrink-0 select-none cursor-grab active:cursor-grabbing"
          style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}
        >
          <div className="w-7 h-7 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: `${accent}20`, border: `1px solid ${accent}35` }}>
            <Tv size={13} style={{ color: accent }} />
          </div>
          <span className="font-syne font-bold text-[13px] text-white/90">Live TV</span>
          <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-full flex-shrink-0" style={{ background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.25)' }}>
            <div className="w-1.5 h-1.5 rounded-full bg-red-400 animate-pulse" />
            <span className="font-jakarta font-semibold text-[9px] text-red-300 tracking-widest">ON AIR</span>
          </div>
          {!loading && !error && <span className="font-jakarta text-[10px] text-muted">{channels.length} channels</span>}
          <div className="flex-1" />

          {/* Pinned volume control — live, drag-to-adjust */}
          <div
            onMouseDown={e => e.stopPropagation()}
            className="flex items-center gap-2 px-2.5 py-1 rounded-full flex-shrink-0"
            style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.07)' }}
          >
            <button
              onClick={() => {
                const next = !muted
                setMuted(next)
                if (videoRef.current) videoRef.current.muted = next
              }}
              title={muted ? 'Unmute' : 'Mute'}
              className="flex items-center justify-center text-muted hover:text-white transition-colors"
              style={{ width: 16, height: 16 }}
            >
              {muted || volume === 0 ? <VolumeX size={13} /> : <Volume2 size={13} />}
            </button>
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={muted ? 0 : Math.round(volume * 100)}
              onChange={e => applyVolume(Number(e.target.value) / 100)}
              onInput={e => applyVolume(Number(e.target.value) / 100)}
              className="iptv-vol"
              style={{
                width: 96,
                background: `linear-gradient(to right, ${accent} 0%, ${accent} ${muted ? 0 : volume * 100}%, rgba(255,255,255,0.14) ${muted ? 0 : volume * 100}%, rgba(255,255,255,0.14) 100%)`
              }}
            />
            <span className="font-jakarta text-[9px] text-muted tabular-nums" style={{ width: 24, textAlign: 'right' }}>
              {muted ? 0 : Math.round(volume * 100)}
            </span>
          </div>
          <style>{`
            .iptv-vol { -webkit-appearance: none; appearance: none; height: 4px; border-radius: 999px; outline: none; cursor: pointer; }
            .iptv-vol::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: 11px; height: 11px; border-radius: 50%; background: #fff; border: none; box-shadow: 0 1px 4px rgba(0,0,0,0.6); cursor: pointer; }
            .iptv-vol::-moz-range-thumb { width: 11px; height: 11px; border-radius: 50%; background: #fff; border: none; cursor: pointer; }
          `}</style>

          <button onMouseDown={e => e.stopPropagation()} onClick={closeIPTV} className="w-6 h-6 rounded-lg flex items-center justify-center text-muted hover:text-white transition-colors" style={{ background: 'rgba(255,255,255,0.05)' }}>
            <X size={12} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 flex min-h-0">
          {/* Channel rail */}
          <div className="flex flex-col flex-shrink-0 min-h-0" style={{ width: 220, borderRight: '1px solid rgba(255,255,255,0.05)' }}>
            <div className="px-2.5 pt-2.5 pb-1.5 relative flex-shrink-0">
              <Search size={11} className="absolute left-4.5 top-1/2 -translate-y-1/2 text-muted pointer-events-none" style={{ left: 18 }} />
              <input
                type="text"
                value={search}
                onChange={e => setSearch(e.target.value)}
                onMouseDown={e => e.stopPropagation()}
                placeholder="Search channels…"
                className="w-full pl-7 pr-2 py-1.5 rounded-lg font-jakarta text-[11px] text-white/80 placeholder:text-muted focus:outline-none"
                style={{ background: 'rgba(0,0,0,0.25)', border: '1px solid rgba(255,255,255,0.06)' }}
              />
            </div>
            <div className="px-2.5 pb-2 flex gap-1 flex-wrap flex-shrink-0" onMouseDown={e => e.stopPropagation()}>
              {groups.slice(0, 6).map(g => (
                <button
                  key={g}
                  onClick={() => setActiveGroup(g)}
                  className="px-2 py-0.5 rounded-md font-jakarta text-[9px] transition-all"
                  style={activeGroup === g
                    ? { background: `${accent}22`, border: `1px solid ${accent}35`, color: accent }
                    : { background: 'transparent', border: '1px solid transparent', color: 'rgba(255,255,255,0.3)' }}
                >
                  {g === 'all' ? 'All' : g}
                </button>
              ))}
            </div>
            <div className="flex-1 overflow-y-auto scroll-thin" onMouseDown={e => e.stopPropagation()}>
              {loading && <div className="p-4 font-jakarta text-[11px] text-muted text-center">Loading…</div>}
              {error && <div className="p-4 font-jakarta text-[11px] text-red-400 text-center">{error}</div>}
              {!loading && !error && filtered.length === 0 && (
                <div className="p-4 font-jakarta text-[11px] text-muted text-center">No channels found.</div>
              )}
              {filtered.map(ch => (
                <button
                  key={ch.id}
                  onClick={() => setCurrent(ch)}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 transition-all text-left hover:bg-white/[0.03]"
                  style={current?.id === ch.id ? { background: `${accent}12`, borderLeft: `2px solid ${accent}` } : { borderLeft: '2px solid transparent' }}
                >
                  <ChannelLogo src={ch.logo} name={ch.name} accent={accent} active={current?.id === ch.id} />
                  <div className="min-w-0">
                    <p className="font-jakarta font-medium text-[10.5px] text-white/80 truncate leading-tight">{ch.name}</p>
                    <p className="font-jakarta text-[9px] text-muted truncate">{ch.group}</p>
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* Video */}
          <div className="flex-1 flex flex-col min-w-0">
            <div className="flex-1 relative flex items-center justify-center" style={{ background: '#000' }}>
              {!current && !loading && !error && (
                <div className="flex flex-col items-center gap-3 text-center">
                  <Tv size={36} style={{ color: `${accent}35` }} />
                  <p className="font-syne font-bold text-white/25 text-xs uppercase tracking-widest">Select a channel</p>
                </div>
              )}
              {loading && (
                <div className="flex flex-col items-center gap-2.5">
                  <Loader2 size={24} className="animate-spin" style={{ color: `${accent}70` }} />
                  <span className="font-jakarta text-[11px] text-muted">Loading playlist…</span>
                </div>
              )}
              {error && (
                <div className="flex flex-col items-center gap-3 text-center px-8">
                  <WifiOff size={30} style={{ color: 'rgba(239,68,68,0.5)' }} />
                  <div>
                    <p className="font-syne font-bold text-[11px] text-red-300/80 mb-1">Playlist unavailable</p>
                    <p className="font-jakarta text-[10px] text-muted">{error}</p>
                  </div>
                </div>
              )}
              {vidStatus === 'error' && current && !loading && (
                <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3" style={{ background: 'rgba(0,0,0,0.85)' }}>
                  <WifiOff size={28} style={{ color: 'rgba(239,68,68,0.5)' }} />
                  <p className="font-jakarta text-[11px] text-muted">{vidError || 'This channel is currently offline'}</p>
                  <button onClick={() => setCurrent({ ...current })} className="flex items-center gap-1.5 px-3 py-1 rounded-lg font-jakarta text-[10px] bg-black/40 hover:bg-black/60 transition-colors" style={{ color: accent, border: `1px solid ${accent}35` }}>
                    <RefreshCw size={10} />Retry
                  </button>
                </div>
              )}
              <video
                ref={videoRef}
                className="w-full h-full"
                style={{ display: current ? 'block' : 'none' }}
                playsInline
                controls={false}
              />
            </div>

            {/* Now playing footer */}
            <div className="flex items-center gap-2.5 px-3.5 py-2 flex-shrink-0" style={{ borderTop: '1px solid rgba(255,255,255,0.05)', background: 'rgba(0,0,0,0.2)' }}>
              {current ? (
                <>
                  <ChannelLogo src={current.logo} name={current.name} accent={accent} active />
                  <div className="min-w-0 flex-1">
                    <p className="font-syne font-bold text-[11px] text-white/90 truncate leading-tight">{current.name}</p>
                    <p className="font-jakarta text-[9px] text-muted truncate">{current.group}</p>
                  </div>
                </>
              ) : (
                <span className="font-jakarta text-[10px] text-muted italic flex-1">No channel selected</span>
              )}
              <button onClick={() => navigate(-1)} className="w-6.5 h-6.5 rounded-lg flex items-center justify-center text-muted hover:text-white transition-colors" style={{ background: 'rgba(255,255,255,0.05)', width: 26, height: 26 }}>
                <ChevronLeft size={12} />
              </button>
              <button onClick={() => navigate(1)} className="rounded-lg flex items-center justify-center text-muted hover:text-white transition-colors" style={{ background: 'rgba(255,255,255,0.05)', width: 26, height: 26 }}>
                <ChevronRight size={12} />
              </button>
              <button onClick={() => setMuted(v => !v)} className="rounded-lg flex items-center justify-center text-muted hover:text-white transition-colors" style={{ background: 'rgba(255,255,255,0.05)', width: 26, height: 26 }}>
                {muted ? <VolumeX size={12} /> : <Volume2 size={12} />}
              </button>
            </div>
          </div>
        </div>

        {/* Resize handle */}
        <div
          onMouseDown={onResizeDown}
          title="Drag to resize"
          className="absolute bottom-0 right-0 flex items-end justify-end"
          style={{ width: 22, height: 22, cursor: 'se-resize', padding: 5 }}
        >
          <svg width="11" height="11" viewBox="0 0 11 11">
            {[[8, 2], [8, 6], [4, 8]].map(([cx, cy], i) => (
              <circle key={i} cx={cx} cy={cy} r={1.3} fill={accent} opacity={0.4} />
            ))}
          </svg>
        </div>
      </motion.div>
    </div>
  )
}
