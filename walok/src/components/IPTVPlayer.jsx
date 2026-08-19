import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, Tv, Search, Loader2, AlertTriangle, WifiOff, RefreshCw, GripHorizontal } from 'lucide-react'
import Hls from 'hls.js'
import { MediaPlayer as DashMediaPlayer } from 'dashjs'
import useStore from '../store/useStore'
import { getDefaultAccent } from '../lib/accent'

// ── M3U Parser ────────────────────────────────────────────────────────────────
function parseM3U(text) {
  const lines = text.split('\n').map(l => l.trim())
  const channels = []; let current = null; let uid = 0
  for (const line of lines) {
    if (line.startsWith('#EXTINF:')) {
      const attr = (k) => { const m = line.match(new RegExp(`${k}="([^"]*)"`, 'i')); return m ? m[1].trim() : '' }
      const afterComma = line.includes(',') ? line.slice(line.lastIndexOf(',') + 1).trim() : ''
      current = { uid: ++uid, name: attr('tvg-name') || afterComma || 'Unknown', logo: attr('tvg-logo'), group: attr('group-title') || 'General', url: '' }
    } else if (!line.startsWith('#') && line && current) {
      current.url = line; channels.push(current); current = null
    }
  }
  return channels
}

// ── Channel logo with per-item error state ────────────────────────────────────
function ChannelLogo({ src, name, accent, size = 36, active }) {
  const [err, setErr] = useState(false)
  useEffect(() => setErr(false), [src])
  return (
    <div style={{ width: size, height: size, flexShrink: 0, borderRadius: 10, overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center', background: active ? `${accent}18` : 'rgba(255,255,255,0.05)', border: `1px solid ${active ? accent + '42' : 'rgba(255,255,255,0.08)'}`, transition: 'all .18s' }}>
      {src && !err
        ? <img src={src} alt={name} onError={() => setErr(true)} style={{ width: '100%', height: '100%', objectFit: 'contain', padding: 3 }} />
        : <Tv size={Math.round(size * 0.38)} style={{ color: active ? accent : 'rgba(255,255,255,0.18)' }} />}
    </div>
  )
}

// ── Animated equaliser bars ───────────────────────────────────────────────────
function EqBars({ accent }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 14 }}>
      {[0, 0.18, 0.08].map((delay, i) => (
        <motion.div key={i}
          animate={{ height: ['3px', '14px', '5px', '12px', '3px'] }}
          transition={{ duration: 0.95, repeat: Infinity, delay, ease: 'easeInOut' }}
          style={{ width: 3, borderRadius: 2, background: accent, flexShrink: 0 }}
        />
      ))}
    </div>
  )
}

// ── SE resize grip icon ───────────────────────────────────────────────────────
function ResizeGrip({ accent }) {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12">
      {[[8,4],[8,8],[4,8]].map(([cx,cy],i) => (
        <circle key={i} cx={cx} cy={cy} r={1.5} fill={accent} opacity={0.35} />
      ))}
    </svg>
  )
}

// ── Constants ─────────────────────────────────────────────────────────────────
const MIN_W = 700, MIN_H = 460

// ── Main IPTV Player ──────────────────────────────────────────────────────────
export default function IPTVPlayer() {
  const { settings, closeIPTV } = useStore()
  const accent = settings.accentColor || getDefaultAccent()
  const iptvLink = settings.iptvLink || 'https://raw.githubusercontent.com/Harleythetech/IPHTV/refs/heads/main/ph.m3u'

  // ── Window geometry (position + size) — all in screen pixels ─────────────
  const initW = useMemo(() => Math.min(1440, Math.max(MIN_W, window.innerWidth  - 20)), [])
  const initH = useMemo(() => Math.min(920,  Math.max(MIN_H, window.innerHeight - 20)), [])

  const [panelW, setPanelW] = useState(initW)
  const [panelH, setPanelH] = useState(initH)
  const [winX,   setWinX]   = useState(() => Math.round((window.innerWidth  - initW) / 2))
  const [winY,   setWinY]   = useState(() => Math.round((window.innerHeight - initH) / 2))

  // Refs so closure-based handlers always see latest values without re-creating
  const panelWRef = useRef(panelW); useEffect(() => { panelWRef.current = panelW }, [panelW])
  const panelHRef = useRef(panelH); useEffect(() => { panelHRef.current = panelH }, [panelH])
  const winXRef   = useRef(winX);   useEffect(() => { winXRef.current   = winX   }, [winX])
  const winYRef   = useRef(winY);   useEffect(() => { winYRef.current   = winY   }, [winY])

  // ── Drag (title bar only) ─────────────────────────────────────────────────
  const onTitleDown = useCallback((e) => {
    if (e.button !== 0) return
    e.preventDefault()
    const sx = e.clientX - winXRef.current
    const sy = e.clientY - winYRef.current
    const onMove = (mv) => {
      setWinX(Math.max(8, Math.min(window.innerWidth  - panelWRef.current - 8, mv.clientX - sx)))
      setWinY(Math.max(8, Math.min(window.innerHeight - panelHRef.current - 8, mv.clientY - sy)))
    }
    const onUp = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [])

  // ── Resize (SE corner) ────────────────────────────────────────────────────
  const onResizeDown = useCallback((e) => {
    if (e.button !== 0) return
    e.preventDefault(); e.stopPropagation()
    const sx = e.clientX, sy = e.clientY
    const sw = panelWRef.current, sh = panelHRef.current
    const onMove = (mv) => {
      setPanelW(Math.max(MIN_W, Math.min(window.innerWidth  - winXRef.current - 8, sw + mv.clientX - sx)))
      setPanelH(Math.max(MIN_H, Math.min(window.innerHeight - winYRef.current - 8, sh + mv.clientY - sy)))
    }
    const onUp = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [])

  // ── Playlist ──────────────────────────────────────────────────────────────
  const [channels, setChannels] = useState([])
  const [fetchLoading, setFetchLoading] = useState(true)
  const [fetchError, setFetchError]     = useState(null)

  // ── UI ────────────────────────────────────────────────────────────────────
  const [selected, setSelected]       = useState(null)
  const [search, setSearch]           = useState('')
  const [activeGroup, setActiveGroup] = useState('All')

  // ── Video ─────────────────────────────────────────────────────────────────
  const [vidStatus, setVidStatus] = useState('idle')
  const [vidError, setVidError]   = useState(null)
  const videoRef = useRef(null)
  const hlsRef   = useRef(null)
  const dashRef  = useRef(null)

  // ── Fetch ─────────────────────────────────────────────────────────────────
  const fetchPlaylist = useCallback(() => {
    setFetchLoading(true); setFetchError(null); setChannels([]); setSelected(null); setVidStatus('idle')
    const ctrl = new AbortController()
    fetch(iptvLink, { signal: ctrl.signal, cache: 'no-cache' })
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text() })
      .then(txt => { const list = parseM3U(txt); setChannels(list); if (list.length) setSelected(list[0]) })
      .catch(err => { if (err.name !== 'AbortError') setFetchError(err.message) })
      .finally(() => setFetchLoading(false))
    return () => ctrl.abort()
  }, [iptvLink])

  useEffect(() => { const c = fetchPlaylist(); return c }, [fetchPlaylist])

  // ── Derived ───────────────────────────────────────────────────────────────
  const groups = useMemo(() => {
    const s = new Set(channels.map(c => c.group))
    return ['All', ...Array.from(s).sort((a, b) => a.localeCompare(b))]
  }, [channels])

  const filtered = useMemo(() => channels.filter(c => {
    const q = search.toLowerCase()
    return (!q || c.name.toLowerCase().includes(q) || c.group.toLowerCase().includes(q))
        && (activeGroup === 'All' || c.group === activeGroup)
  }), [channels, search, activeGroup])

  // ── Teardown helper ───────────────────────────────────────────────────────
  const destroyPlayers = useCallback(() => {
    if (hlsRef.current)  { hlsRef.current.destroy();  hlsRef.current  = null }
    if (dashRef.current) { dashRef.current.destroy(); dashRef.current = null }
  }, [])

  // ── Stream loader — auto-detects HLS (.m3u8) vs DASH (.mpd) ──────────────
  const loadChannel = useCallback((ch) => {
    if (!ch?.url || !videoRef.current) return
    setVidStatus('loading'); setVidError(null)
    destroyPlayers()
    const video = videoRef.current
    video.pause(); video.removeAttribute('src'); video.load()

    const url = ch.url
    const isDash = /\.mpd(\?|$)/i.test(url)

    if (isDash) {
      // ── DASH stream ──────────────────────────────────────────────────────
      try {
        const player = DashMediaPlayer().create()
        player.initialize(video, url, true)
        // 'playbackPlaying' fires when actual frames are rendering (not just play() called)
        player.on('playbackPlaying', () => setVidStatus('playing'))
        // 'playbackError' fires only on fatal unrecoverable errors — 'error' fires on retries too
        player.on('playbackError', () => { setVidStatus('error'); setVidError('Stream unavailable or format unsupported') })
        dashRef.current = player
      } catch (_) {
        setVidStatus('error'); setVidError('DASH playback not supported')
      }
    } else if (Hls.isSupported()) {
      // ── HLS via hls.js ───────────────────────────────────────────────────
      const hls = new Hls({ enableWorker: false, maxBufferLength: 30 })
      hlsRef.current = hls
      hls.loadSource(url); hls.attachMedia(video)
      // video.play() triggers the native onPlaying handler which sets status to 'playing'
      hls.on(Hls.Events.MANIFEST_PARSED, () => { video.play().catch(() => {}) })
      hls.on(Hls.Events.ERROR, (_, d) => { if (d.fatal) { setVidStatus('error'); setVidError('Stream unavailable or format unsupported') } })
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // ── Native HLS (Safari) ──────────────────────────────────────────────
      video.src = url; video.play().then(() => setVidStatus('playing')).catch(() => setVidStatus('error'))
    } else {
      setVidStatus('error'); setVidError('HLS not supported in this browser')
    }
  }, [destroyPlayers])

  useEffect(() => { if (selected) loadChannel(selected) }, [selected, loadChannel])
  useEffect(() => () => destroyPlayers(), [destroyPlayers])

  // ── Pills drag-scroll ─────────────────────────────────────────────────────
  const pillsRef = useRef(null)
  const onPillsMouseDown = useCallback((e) => {
    const el = pillsRef.current
    if (!el || e.button !== 0) return
    const startX = e.clientX
    const startScroll = el.scrollLeft
    let moved = false
    const onMove = (mv) => {
      const dx = mv.clientX - startX
      if (!moved && Math.abs(dx) < 4) return
      moved = true
      el.scrollLeft = startScroll - dx
    }
    const onUp = (upEv) => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      // If we actually dragged, swallow the click so the pill doesn't fire
      if (moved) upEv.stopPropagation()
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [])

  // ESC
  useEffect(() => {
    const fn = (e) => { if (e.key === 'Escape') closeIPTV() }
    window.addEventListener('keydown', fn)
    return () => window.removeEventListener('keydown', fn)
  }, [closeIPTV])

  // ── Shared style helpers ──────────────────────────────────────────────────
  const S = {
    fontO: 'Orbitron, sans-serif',
    fontR: 'Rajdhani, sans-serif',
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    // Very subtle backdrop — removes the "shadow pool" look from a heavy overlay
    <div style={{ position: 'fixed', inset: 0, zIndex: 50, background: 'rgba(0,0,0,0.28)', pointerEvents: 'none' }}>

      {/* ── Floating window — pointer-events re-enabled on just this div ── */}
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
        style={{
          position: 'absolute',
          left: winX, top: winY,
          width: panelW, height: panelH,
          pointerEvents: 'all',
          borderRadius: 14,
          background: 'linear-gradient(160deg, rgba(15,13,10,0.99) 0%, rgba(9,8,6,1) 100%)',
          border: `1px solid ${accent}28`,
          // Subtle shadow — small offset, no huge dark pool
          boxShadow: `0 4px 24px rgba(0,0,0,0.55), 0 1px 3px rgba(0,0,0,0.4), 0 0 0 1px ${accent}0d`,
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
        }}
      >
        {/* Corner brackets */}
        {[
          { pos: 'top:0;left:0',    style: { borderTop:`2px solid ${accent}55`, borderLeft:`2px solid ${accent}55`,   borderRadius:'14px 0 0 0' } },
          { pos: 'top:0;right:0',   style: { borderTop:`2px solid ${accent}55`, borderRight:`2px solid ${accent}55`,  borderRadius:'0 14px 0 0' } },
          { pos: 'bottom:0;left:0', style: { borderBottom:`2px solid ${accent}1a`, borderLeft:`2px solid ${accent}1a`,  borderRadius:'0 0 0 14px' } },
          { pos: 'bottom:0;right:0',style: { borderBottom:`2px solid ${accent}1a`, borderRight:`2px solid ${accent}1a`, borderRadius:'0 0 14px 0' } },
        ].map(({ pos: p, style: s }, i) => {
          const css = {}; p.split(';').forEach(kv => { const [k,v]=kv.split(':'); if(k&&v) css[k]=v })
          return <div key={i} style={{ position:'absolute', width:40, height:40, pointerEvents:'none', ...css, ...s }} />
        })}

        {/* Top accent line */}
        <div style={{ position:'absolute', top:0, left:40, right:40, height:1, background:`linear-gradient(90deg,transparent,${accent}65,transparent)`, pointerEvents:'none' }} />

        {/* ── Title bar / drag handle ──────────────────────────────── */}
        <div
          onMouseDown={onTitleDown}
          style={{
            height: 48, display: 'flex', alignItems: 'center', gap: 10, padding: '0 12px 0 14px',
            background: `linear-gradient(90deg,rgba(20,17,13,0.95),rgba(16,13,10,0.95))`,
            borderBottom: `1px solid ${accent}14`,
            cursor: 'grab', userSelect: 'none', flexShrink: 0,
          }}
        >
          <GripHorizontal size={15} style={{ color:`${accent}38`, flexShrink:0 }} />

          {/* Live badge */}
          <div style={{ display:'flex', alignItems:'center', gap:5, padding:'2px 8px', borderRadius:999, background:'rgba(239,68,68,0.13)', border:'1px solid rgba(239,68,68,0.3)', flexShrink:0 }}>
            <div style={{ width:6, height:6, borderRadius:'50%', background:'#ef4444', animation:'pulse 2s infinite' }} />
            <span style={{ fontFamily:S.fontO, fontSize:8, color:'#f87171', fontWeight:700, letterSpacing:'0.18em' }}>LIVE</span>
          </div>

          <span style={{ fontFamily:S.fontO, fontSize:11, fontWeight:700, letterSpacing:'0.22em', color:accent, flexShrink:0 }}>IPTV</span>

          <span style={{ fontFamily:S.fontR, fontSize:12, color:'rgba(255,255,255,0.32)', overflow:'hidden', whiteSpace:'nowrap', textOverflow:'ellipsis', flex:1, minWidth:0 }}>
            {selected ? `· ${selected.name}` : fetchLoading ? '' : `${channels.length} channels`}
          </span>

          {/* Actions — stop mouse propagation so they don't trigger drag */}
          <div style={{ display:'flex', gap:3, flexShrink:0 }} onMouseDown={e => e.stopPropagation()}>
            {!fetchLoading && (
              <button onClick={fetchPlaylist} title="Reload playlist"
                style={{ width:28, height:28, borderRadius:7, display:'flex', alignItems:'center', justifyContent:'center', background:'transparent', border:'none', cursor:'pointer', color:`${accent}50`, transition:'color .18s' }}
                onMouseEnter={e => (e.currentTarget.style.color = accent)}
                onMouseLeave={e => (e.currentTarget.style.color = `${accent}50`)}
              ><RefreshCw size={12} /></button>
            )}
            <button onClick={closeIPTV} title="Close (Esc)"
              style={{ width:28, height:28, borderRadius:7, display:'flex', alignItems:'center', justifyContent:'center', background:'transparent', border:'none', cursor:'pointer', color:'rgba(255,255,255,0.25)', transition:'color .18s' }}
              onMouseEnter={e => (e.currentTarget.style.color = '#f87171')}
              onMouseLeave={e => (e.currentTarget.style.color = 'rgba(255,255,255,0.25)')}
            ><X size={14} /></button>
          </div>
        </div>

        {/* ── Body ─────────────────────────────────────────────────── */}
        <div style={{ display:'flex', flex:1, overflow:'hidden' }}>

          {/* ── LEFT: Channel list ───────────────────────────────── */}
          <div style={{ width:248, display:'flex', flexDirection:'column', flexShrink:0, borderRight:`1px solid ${accent}0e` }}>

            {/* Search */}
            <div style={{ padding:'10px 10px 6px' }}>
              <div style={{ position:'relative' }}>
                <Search size={11} style={{ position:'absolute', left:9, top:'50%', transform:'translateY(-50%)', color:'rgba(255,255,255,0.22)', pointerEvents:'none' }} />
                <input
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="Search channels…"
                  style={{ width:'100%', boxSizing:'border-box', background:'rgba(255,255,255,0.04)', border:'1px solid rgba(255,255,255,0.08)', borderRadius:10, paddingLeft:28, paddingRight:search?26:10, paddingTop:7, paddingBottom:7, fontSize:11, fontFamily:S.fontR, color:'rgba(255,255,255,0.82)', outline:'none', transition:'border-color .2s' }}
                  onFocus={e => (e.currentTarget.style.borderColor = `${accent}48`)}
                  onBlur={e => (e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)')}
                />
                {search && (
                  <button onClick={() => setSearch('')}
                    style={{ position:'absolute', right:8, top:'50%', transform:'translateY(-50%)', background:'none', border:'none', cursor:'pointer', color:'rgba(255,255,255,0.3)', display:'flex', padding:2 }}>
                    <X size={10} />
                  </button>
                )}
              </div>
            </div>

            {/* Group pills — drag to scroll horizontally */}
            {!fetchLoading && groups.length > 1 && (
              <div ref={pillsRef} onMouseDown={onPillsMouseDown} style={{ padding:'0 10px 7px', display:'flex', gap:5, overflowX:'auto', scrollbarWidth:'none', flexShrink:0, cursor:'grab', userSelect:'none' }}>
                {groups.map(g => (
                  <button key={g} onClick={() => setActiveGroup(g)}
                    style={{ padding:'2px 9px', borderRadius:999, fontSize:8, fontFamily:S.fontO, textTransform:'uppercase', letterSpacing:'0.1em', flexShrink:0, cursor:'pointer', transition:'all .18s', border:'1px solid', ...(activeGroup===g ? { background:`${accent}20`, color:accent, borderColor:`${accent}45` } : { background:'rgba(255,255,255,0.04)', color:'rgba(255,255,255,0.28)', borderColor:'rgba(255,255,255,0.07)' }) }}
                  >{g.length>12?g.slice(0,12)+'…':g}</button>
                ))}
              </div>
            )}

            {/* Count */}
            {!fetchLoading && !fetchError && (
              <div style={{ margin:'0 10px 5px', borderTop:`1px solid ${accent}0c`, paddingTop:5 }}>
                <span style={{ fontSize:9, fontFamily:S.fontR, color:'rgba(255,255,255,0.2)', letterSpacing:'0.05em' }}>
                  {filtered.length} {filtered.length===1?'channel':'channels'}{activeGroup!=='All'?` · ${activeGroup}`:''}
                </span>
              </div>
            )}

            {/* Channel rows */}
            <div style={{ flex:1, overflowY:'auto', padding:'0 6px 6px', scrollbarWidth:'thin', scrollbarColor:`${accent}18 transparent` }}>

              {fetchLoading && (
                <div style={{ display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', height:'100%', gap:10 }}>
                  <Loader2 size={22} className="animate-spin" style={{ color:`${accent}55` }} />
                  <span style={{ fontSize:10, fontFamily:S.fontR, color:'rgba(255,255,255,0.22)' }}>Fetching playlist…</span>
                </div>
              )}
              {!fetchLoading && fetchError && (
                <div style={{ display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', height:'100%', gap:10, padding:'0 12px', textAlign:'center' }}>
                  <AlertTriangle size={20} style={{ color:'rgba(239,68,68,0.4)' }} />
                  <span style={{ fontSize:10, fontFamily:S.fontR, color:'rgba(255,255,255,0.25)' }}>Failed to load playlist</span>
                  <button onClick={fetchPlaylist} style={{ padding:'4px 12px', borderRadius:8, fontSize:10, fontFamily:S.fontR, textTransform:'uppercase', cursor:'pointer', background:'transparent', border:`1px solid ${accent}35`, color:accent }}>Retry</button>
                </div>
              )}
              {!fetchLoading && !fetchError && filtered.length===0 && (
                <div style={{ display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', height:'100%', gap:8 }}>
                  <Tv size={20} style={{ color:'rgba(255,255,255,0.1)' }} />
                  <span style={{ fontSize:10, fontFamily:S.fontR, color:'rgba(255,255,255,0.18)' }}>No channels found</span>
                </div>
              )}
              {!fetchLoading && !fetchError && filtered.map(ch => {
                const isSel = selected?.uid === ch.uid
                return (
                  <div key={ch.uid} onClick={() => setSelected(ch)}
                    style={{ display:'flex', alignItems:'center', gap:9, padding:'7px 8px', borderRadius:11, cursor:'pointer', position:'relative', marginBottom:1, transition:'background .14s', border:'1px solid', ...(isSel ? { background:`${accent}12`, borderColor:`${accent}28` } : { background:'transparent', borderColor:'transparent' }) }}
                    onMouseEnter={e => { if(!isSel){e.currentTarget.style.background='rgba(255,255,255,0.03)';e.currentTarget.style.borderColor='rgba(255,255,255,0.06)'} }}
                    onMouseLeave={e => { if(!isSel){e.currentTarget.style.background='transparent';e.currentTarget.style.borderColor='transparent'} }}
                  >
                    {isSel && <div style={{ position:'absolute', left:0, top:8, bottom:8, width:3, borderRadius:'0 3px 3px 0', background:accent }} />}
                    <ChannelLogo src={ch.logo} name={ch.name} accent={accent} size={36} active={isSel} />
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ fontSize:12, fontFamily:S.fontR, fontWeight:600, color:isSel?'#fff':'rgba(255,255,255,0.62)', overflow:'hidden', whiteSpace:'nowrap', textOverflow:'ellipsis', lineHeight:1.3 }}>{ch.name}</div>
                      <div style={{ fontSize:9, fontFamily:S.fontR, color:isSel?`${accent}88`:'rgba(255,255,255,0.22)', overflow:'hidden', whiteSpace:'nowrap', textOverflow:'ellipsis', lineHeight:1.3, marginTop:1 }}>{ch.group}</div>
                    </div>
                    <div style={{ width:20, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                      {isSel && vidStatus==='playing' && <EqBars accent={accent} />}
                      {isSel && vidStatus==='loading' && <Loader2 size={11} className="animate-spin" style={{ color:`${accent}80` }} />}
                      {isSel && vidStatus==='error'   && <div style={{ width:7, height:7, borderRadius:'50%', background:'rgba(239,68,68,0.7)' }} />}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>

          {/* ── RIGHT: Video ─────────────────────────────────────── */}
          <div style={{ flex:1, display:'flex', flexDirection:'column', background:'#000', minWidth:0 }}>

            <div style={{ flex:1, position:'relative', background:'#000', display:'flex', alignItems:'center', justifyContent:'center', overflow:'hidden' }}>
              <video
                ref={videoRef}
                style={{ width:'100%', height:'100%', objectFit:'contain', display:(vidStatus==='error'||vidStatus==='idle')?'none':'block' }}
                onWaiting={() => setVidStatus(s => s==='playing'?'loading':s)}
                onPlaying={() => setVidStatus('playing')}
                onError={() => { setVidStatus('error'); setVidError('Playback error — stream may be offline') }}
                controls playsInline autoPlay
              />

              {/* Idle */}
              {vidStatus==='idle' && !fetchLoading && !fetchError && (
                <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:18 }}>
                  <div style={{ position:'relative' }}>
                    <div style={{ width:72, height:72, borderRadius:18, background:`${accent}0e`, border:`1px solid ${accent}1e`, display:'flex', alignItems:'center', justifyContent:'center' }}>
                      <Tv size={30} style={{ color:`${accent}45` }} />
                    </div>
                    <div style={{ position:'absolute', inset:-10, borderRadius:28, border:`1px dashed ${accent}22`, animation:'pulse 3s ease-in-out infinite' }} />
                  </div>
                  <div style={{ textAlign:'center' }}>
                    <div style={{ fontFamily:S.fontO, fontSize:12, letterSpacing:'0.2em', color:`${accent}50`, marginBottom:6 }}>SELECT A CHANNEL</div>
                    <div style={{ fontFamily:S.fontR, fontSize:11, color:'rgba(255,255,255,0.2)' }}>Pick a channel from the list to start watching</div>
                  </div>
                </div>
              )}

              {/* Buffering */}
              <AnimatePresence>
                {vidStatus==='loading' && (
                  <motion.div initial={{ opacity:0 }} animate={{ opacity:1 }} exit={{ opacity:0 }}
                    style={{ position:'absolute', inset:0, background:'rgba(0,0,0,0.68)', display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:14, pointerEvents:'none' }}>
                    <div style={{ position:'relative' }}>
                      <Loader2 size={38} className="animate-spin" style={{ color:accent }} />
                      <div style={{ position:'absolute', inset:0, borderRadius:'50%', background:accent, opacity:0.12, filter:'blur(14px)' }} />
                    </div>
                    <div style={{ textAlign:'center' }}>
                      <div style={{ fontFamily:S.fontR, fontSize:13, color:'rgba(255,255,255,0.45)' }}>Connecting to stream…</div>
                      {selected && <div style={{ fontFamily:S.fontO, fontSize:9, letterSpacing:'0.15em', color:`${accent}55`, marginTop:4, maxWidth:280, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{selected.name}</div>}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Error */}
              {vidStatus==='error' && (
                <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:16 }}>
                  <div style={{ width:68, height:68, borderRadius:18, background:'rgba(239,68,68,0.08)', border:'1px solid rgba(239,68,68,0.2)', display:'flex', alignItems:'center', justifyContent:'center' }}>
                    <WifiOff size={28} style={{ color:'rgba(239,68,68,0.55)' }} />
                  </div>
                  <div style={{ textAlign:'center' }}>
                    <div style={{ fontFamily:S.fontO, fontSize:11, letterSpacing:'0.15em', color:'rgba(239,68,68,0.55)', marginBottom:6 }}>STREAM UNAVAILABLE</div>
                    <div style={{ fontFamily:S.fontR, fontSize:11, color:'rgba(255,255,255,0.25)', maxWidth:260 }}>{vidError||'This channel is currently offline'}</div>
                  </div>
                  <button onClick={() => selected && loadChannel(selected)}
                    style={{ display:'flex', alignItems:'center', gap:6, padding:'6px 18px', borderRadius:10, fontFamily:S.fontR, fontSize:11, textTransform:'uppercase', letterSpacing:'0.1em', cursor:'pointer', background:'transparent', border:`1px solid ${accent}35`, color:accent, transition:'background .15s' }}
                    onMouseEnter={e => (e.currentTarget.style.background=`${accent}10`)}
                    onMouseLeave={e => (e.currentTarget.style.background='transparent')}
                  ><RefreshCw size={11} />Retry</button>
                </div>
              )}

              {/* Initial fetch loading */}
              {fetchLoading && (
                <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:12 }}>
                  <Loader2 size={28} className="animate-spin" style={{ color:`${accent}55` }} />
                  <span style={{ fontFamily:S.fontR, fontSize:12, color:'rgba(255,255,255,0.25)' }}>Loading channel list…</span>
                </div>
              )}

              {/* Fetch error */}
              {fetchError && !fetchLoading && (
                <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:14, padding:'0 40px', textAlign:'center' }}>
                  <AlertTriangle size={34} style={{ color:'rgba(239,68,68,0.4)' }} />
                  <div>
                    <div style={{ fontFamily:S.fontO, fontSize:10, letterSpacing:'0.15em', color:'rgba(239,68,68,0.5)', marginBottom:8 }}>PLAYLIST LOAD FAILED</div>
                    <div style={{ fontFamily:S.fontR, fontSize:11, color:'rgba(255,255,255,0.25)', marginBottom:4 }}>{fetchError}</div>
                    <div style={{ fontFamily:S.fontR, fontSize:10, color:'rgba(255,255,255,0.15)' }}>Update the IPTV link in Admin Panel → Settings → IPTV Source</div>
                  </div>
                  <button onClick={fetchPlaylist}
                    style={{ display:'flex', alignItems:'center', gap:6, padding:'6px 16px', borderRadius:10, fontFamily:S.fontR, fontSize:11, textTransform:'uppercase', cursor:'pointer', background:'transparent', border:`1px solid ${accent}30`, color:accent }}>
                    <RefreshCw size={10} />Retry
                  </button>
                </div>
              )}
            </div>

            {/* Now-playing footer */}
            <div style={{ height:50, display:'flex', alignItems:'center', gap:12, padding:'0 16px', background:'rgba(12,10,8,0.98)', borderTop:`1px solid ${accent}12`, flexShrink:0 }}>
              {selected ? (
                <>
                  <ChannelLogo src={selected.logo} name={selected.name} accent={accent} size={32} active />
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontFamily:S.fontO, fontSize:10, fontWeight:700, color:accent, overflow:'hidden', whiteSpace:'nowrap', textOverflow:'ellipsis', lineHeight:1.3 }}>{selected.name}</div>
                    <div style={{ fontFamily:S.fontR, fontSize:9, color:'rgba(255,255,255,0.28)', textTransform:'uppercase', letterSpacing:'0.08em' }}>{selected.group}</div>
                  </div>
                  {/* Status chip */}
                  <div style={{ display:'flex', alignItems:'center', gap:5, padding:'3px 10px', borderRadius:999, flexShrink:0, ...(vidStatus==='playing' ? { background:'rgba(74,222,128,0.1)', border:'1px solid rgba(74,222,128,0.28)' } : vidStatus==='loading' ? { background:`${accent}10`, border:`1px solid ${accent}30` } : { background:'rgba(239,68,68,0.1)', border:'1px solid rgba(239,68,68,0.25)' }) }}>
                    <div style={{ width:6, height:6, borderRadius:'50%', background:vidStatus==='playing'?'#4ade80':vidStatus==='loading'?accent:'#ef4444', animation:vidStatus!=='error'?'pulse 2s infinite':'none' }} />
                    <span style={{ fontFamily:S.fontO, fontSize:8, fontWeight:700, letterSpacing:'0.15em', color:vidStatus==='playing'?'#4ade80':vidStatus==='loading'?accent:'#f87171' }}>
                      {vidStatus==='playing'?'LIVE':vidStatus==='loading'?'BUFFERING':vidStatus==='error'?'OFFLINE':'—'}
                    </span>
                  </div>
                </>
              ) : (
                <span style={{ fontFamily:S.fontR, fontSize:11, color:'rgba(255,255,255,0.18)', fontStyle:'italic' }}>No channel selected</span>
              )}
            </div>
          </div>
        </div>

        {/* ── SE Resize handle ─────────────────────────────────────── */}
        <div
          onMouseDown={onResizeDown}
          title="Drag to resize"
          style={{ position:'absolute', bottom:0, right:0, width:22, height:22, cursor:'se-resize', display:'flex', alignItems:'flex-end', justifyContent:'flex-end', padding:5, zIndex:10 }}
        >
          <ResizeGrip accent={accent} />
        </div>
      </motion.div>
    </div>
  )
}
