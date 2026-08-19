import React, { useEffect, useState } from 'react'
import useStore from '../store/useStore'

const SCRAMBLE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#@!$%&'

// Watches the global `html.app-idle` class so JS-driven animations (like
// the scramble loop below) can stop when the user goes idle and resume
// the moment they move the mouse / press a key. The CSS rule in index.css
// already pauses *CSS* animations on idle; this hook is the JS twin.
function useIsIdle() {
  const [idle, setIdle] = useState(() =>
    typeof document !== 'undefined' && document.documentElement.classList.contains('app-idle')
  )
  useEffect(() => {
    if (typeof document === 'undefined') return
    const root = document.documentElement
    setIdle(root.classList.contains('app-idle'))
    const obs = new MutationObserver(() => {
      setIdle(root.classList.contains('app-idle'))
    })
    obs.observe(root, { attributes: true, attributeFilter: ['class'] })
    return () => obs.disconnect()
  }, [])
  return idle
}

// Brand-name scramble. Originally fired once on mount which made the
// header look "dead" after the first reveal. Now it loops on a fixed
// gap (RESTART_GAP_MS) between cycles whenever the app is active, and
// fully stops when `html.app-idle` is set so we don't waste CPU on the
// idle screen. When the user becomes active again, MutationObserver
// flips `idle` back to false, the effect re-runs, and the loop kicks
// off again — matching what the user expects from a "living" header.
function useScrambleText(text, { idle = false, restartGapMs = 7000 } = {}) {
  const [display, setDisplay] = useState(text)

  useEffect(() => {
    if (!text) return
    // While idle, freeze on the stable brand text. The next time `idle`
    // flips back to false this effect re-runs (idle is in the dep list)
    // and the loop starts over.
    if (idle) {
      setDisplay(text)
      return
    }

    let cancelled = false
    let frameTimer = null
    let cycleTimer = null
    const FRAME_MS = 40
    const FRAMES_PER_CHAR = 3

    const runScramble = () => {
      if (cancelled) return
      let iteration = 0
      const totalFrames = text.length * FRAMES_PER_CHAR
      const tick = () => {
        if (cancelled) return
        iteration++
        const result = text.split('').map((char, i) => {
          if (char === ' ') return ' '
          if (i < Math.floor(iteration / FRAMES_PER_CHAR)) return char
          return SCRAMBLE_CHARS[Math.floor(Math.random() * SCRAMBLE_CHARS.length)]
        }).join('')
        setDisplay(result)
        if (iteration < totalFrames) {
          frameTimer = setTimeout(tick, FRAME_MS)
        } else {
          setDisplay(text)
          // Schedule the next cycle. Re-checked at fire time so a quick
          // idle-then-unidle sequence still leaves a clean gap.
          cycleTimer = setTimeout(() => {
            if (!cancelled) runScramble()
          }, restartGapMs)
        }
      }
      tick()
    }

    // Initial reveal feels best with a short pre-roll; subsequent loops
    // are spaced by restartGapMs above.
    cycleTimer = setTimeout(runScramble, 500)

    return () => {
      cancelled = true
      if (frameTimer) clearTimeout(frameTimer)
      if (cycleTimer) clearTimeout(cycleTimer)
    }
  }, [text, idle, restartGapMs])

  return display
}

// Cyberpunk panel background for the featured banner.
// SVG-based angular dark slabs on the right half, diagonal accent-color
// edge lines, scattered circuit dashes — all tinted by --accent-rgb so
// every customer brand color carries through automatically.
function BannerCanvas() {
  // Small circuit dashes scattered across the dark panels
  const dashes = [
    { x: 488, y: 14, w: 24, h: 2.5 }, { x: 545, y: 36, w: 14, h: 2 },
    { x: 612, y: 18, w: 32, h: 2.5 }, { x: 638, y: 62, w: 18, h: 2 },
    { x: 704, y: 12, w: 12, h: 2 },   { x: 722, y: 50, w: 26, h: 2.5 },
    { x: 764, y: 76, w: 16, h: 2 },   { x: 816, y: 20, w: 20, h: 2.5 },
    { x: 844, y: 54, w: 14, h: 2 },   { x: 886, y: 32, w: 30, h: 2.5 },
    { x: 924, y: 70, w: 18, h: 2 },   { x: 964, y: 16, w: 22, h: 2.5 },
    { x: 1026, y: 46, w: 16, h: 2 },  { x: 1068, y: 78, w: 20, h: 2.5 },
    { x: 1106, y: 28, w: 14, h: 2 },  { x: 1148, y: 56, w: 24, h: 2.5 },
    // square pads
    { x: 594, y: 90, w: 7, h: 7 },    { x: 748, y: 98, w: 5, h: 5 },
    { x: 876, y: 88, w: 7, h: 7 },    { x: 1004, y: 96, w: 5, h: 5 },
    { x: 1112, y: 84, w: 6, h: 6 },
    // tiny corner marks on panels
    { x: 512, y: 4,  w: 6, h: 1.5 },  { x: 512, y: 7,  w: 3, h: 1.5 },
    { x: 662, y: 4,  w: 6, h: 1.5 },  { x: 662, y: 7,  w: 3, h: 1.5 },
    { x: 802, y: 4,  w: 6, h: 1.5 },  { x: 942, y: 4,  w: 6, h: 1.5 },
  ]

  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none">

      {/* Left-side accent tint — keeps text side branded */}
      <div style={{
        position: 'absolute', inset: 0,
        background: 'linear-gradient(90deg, rgb(var(--accent-rgb) / 0.09) 0%, rgb(var(--accent-rgb) / 0.04) 28%, transparent 52%)',
      }} />

      {/* Pulsing radial bloom behind the cafe name */}
      <div style={{
        position: 'absolute',
        left: 0, top: '-30%', width: '38%', height: '160%',
        background: 'radial-gradient(ellipse at 22% 50%, rgb(var(--accent-rgb) / 0.10) 0%, transparent 68%)',
        animation: 'cpBloom 7s ease-in-out infinite',
        willChange: 'opacity',
      }} />

      {/* SVG cyberpunk panels */}
      <svg
        viewBox="0 0 1200 130"
        preserveAspectRatio="none"
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
      >
        <defs>
          {/* Glow filter for primary accent lines */}
          <filter id="cpGlowHard" x="-60%" y="-200%" width="220%" height="500%">
            <feGaussianBlur stdDeviation="4" result="g" />
            <feMerge><feMergeNode in="g" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
          <filter id="cpGlowSoft" x="-60%" y="-200%" width="220%" height="500%">
            <feGaussianBlur stdDeviation="2.5" result="g" />
            <feMerge><feMergeNode in="g" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>

        {/* ── Dark angular panel slabs ────────────────────────────── */}
        {/* Base slab — widest, covers right 60%+ */}
        <polygon points="395,0 1200,0 1200,130 345,130"
          style={{ fill: 'rgba(5,5,9,0.92)' }} />
        {/* Slab 2 */}
        <polygon points="515,0 790,0 740,130 465,130"
          style={{ fill: 'rgba(11,11,17,0.86)' }} />
        {/* Slab 3 */}
        <polygon points="655,0 915,0 865,130 605,130"
          style={{ fill: 'rgba(8,8,14,0.82)' }} />
        {/* Slab 4 */}
        <polygon points="795,0 1040,0 990,130 745,130"
          style={{ fill: 'rgba(13,13,19,0.78)' }} />
        {/* Slab 5 — far right */}
        <polygon points="940,0 1200,0 1200,130 890,130"
          style={{ fill: 'rgba(6,6,12,0.74)' }} />

        {/* ── Diagonal accent edge lines — static base ────────────── */}
        <line x1="395" y1="0" x2="345" y2="130"
          style={{ stroke: 'rgb(var(--accent-rgb))', strokeWidth: 2.5, opacity: 0.35 }}
          filter="url(#cpGlowHard)" />
        <line x1="515" y1="0" x2="465" y2="130"
          style={{ stroke: 'rgb(var(--accent-rgb))', strokeWidth: 2, opacity: 0.28 }}
          filter="url(#cpGlowSoft)" />
        <line x1="655" y1="0" x2="605" y2="130"
          style={{ stroke: 'rgb(var(--accent-rgb))', strokeWidth: 1.5, opacity: 0.22 }} />
        <line x1="795" y1="0" x2="745" y2="130"
          style={{ stroke: 'rgb(var(--accent-rgb))', strokeWidth: 1.5, opacity: 0.18 }} />
        <line x1="940" y1="0" x2="890" y2="130"
          style={{ stroke: 'rgb(var(--accent-rgb))', strokeWidth: 1, opacity: 0.14 }} />
        {/* Secondary right-side edges (faint) */}
        <line x1="790" y1="0" x2="740" y2="130"
          style={{ stroke: 'rgb(var(--accent-rgb))', strokeWidth: 0.75, opacity: 0.12 }} />
        <line x1="915" y1="0" x2="865" y2="130"
          style={{ stroke: 'rgb(var(--accent-rgb))', strokeWidth: 0.75, opacity: 0.10 }} />
        <line x1="1040" y1="0" x2="990" y2="130"
          style={{ stroke: 'rgb(var(--accent-rgb))', strokeWidth: 0.75, opacity: 0.08 }} />

        {/* ── Glitch lines — segments spark at random positions on each edge */}
        {/* dasharray 35+104=139 ≈ line length; dashoffset jumps expose top/mid/bottom */}
        {[
          { x1: 395, y1: 0, x2: 345, y2: 130, sw: 3.5, dur: '3.2s', delay: '0s',    anim: 'cpGlitch0', filter: 'url(#cpGlowHard)' },
          { x1: 515, y1: 0, x2: 465, y2: 130, sw: 3,   dur: '2.8s', delay: '-1.1s', anim: 'cpGlitch1', filter: 'url(#cpGlowHard)' },
          { x1: 655, y1: 0, x2: 605, y2: 130, sw: 2.5, dur: '3.5s', delay: '-0.7s', anim: 'cpGlitch2', filter: 'url(#cpGlowSoft)' },
          { x1: 795, y1: 0, x2: 745, y2: 130, sw: 2.5, dur: '2.6s', delay: '-2.2s', anim: 'cpGlitch0', filter: 'url(#cpGlowSoft)' },
          { x1: 940, y1: 0, x2: 890, y2: 130, sw: 2,   dur: '3.8s', delay: '-1.5s', anim: 'cpGlitch1', filter: undefined },
        ].map((l, i) => (
          <line key={`glitch-${i}`}
            x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2}
            filter={l.filter}
            style={{
              stroke: 'rgb(var(--accent-rgb))',
              strokeWidth: l.sw,
              strokeDasharray: '35 104',
              strokeDashoffset: 0,
              opacity: 0,
              animation: `${l.anim} ${l.dur} step-start ${l.delay} infinite`,
            }}
          />
        ))}

        {/* ── Horizontal circuit trace lines across panels ─────────── */}
        <line x1="445" y1="42" x2="650" y2="42"
          style={{ stroke: 'rgb(var(--accent-rgb))', strokeWidth: 0.6, opacity: 0.16 }} />
        <line x1="580" y1="88" x2="790" y2="88"
          style={{ stroke: 'rgb(var(--accent-rgb))', strokeWidth: 0.6, opacity: 0.14 }} />
        <line x1="710" y1="64" x2="940" y2="64"
          style={{ stroke: 'rgb(var(--accent-rgb))', strokeWidth: 0.6, opacity: 0.12 }} />
        <line x1="850" y1="32" x2="1080" y2="32"
          style={{ stroke: 'rgb(var(--accent-rgb))', strokeWidth: 0.6, opacity: 0.10 }} />

        {/* ── Scanline stripes (ultra subtle depth) ───────────────── */}
        {Array.from({ length: 9 }, (_, i) => (
          <line key={i}
            x1="390" y1={i * 14 + 7} x2="1200" y2={i * 14 + 7}
            style={{ stroke: 'rgba(255,255,255,0.012)', strokeWidth: 1 }}
          />
        ))}

        {/* ── Circuit dashes ──────────────────────────────────────── */}
        {dashes.map((d, i) => (
          <rect key={i} x={d.x} y={d.y} width={d.w} height={d.h}
            style={{ fill: 'rgb(var(--accent-rgb))', opacity: 0.30 + (i % 5) * 0.09 }}
          />
        ))}
      </svg>

      {/* Slow flash sweep across the whole banner */}
      <div style={{
        position: 'absolute', inset: 0,
        background: 'linear-gradient(108deg, transparent 20%, rgb(var(--accent-rgb) / 0.035) 50%, transparent 80%)',
        animation: 'cpFlash 10s ease-in-out -3s infinite',
        willChange: 'transform',
      }} />

      <style>{`
        @keyframes cpBloom {
          0%, 100% { opacity: 0.65; }
          50%      { opacity: 1; }
        }
        @keyframes cpFlash {
          0%, 100% { transform: translateX(-130%); }
          50%      { transform: translateX(130%); }
        }

        /* Glitch variant A — rapid triple-burst, mostly dark */
        @keyframes cpGlitch0 {
          0%   { opacity:0; stroke-dashoffset:0; }
          3%   { opacity:1; stroke-dashoffset:0; }
          4%   { opacity:0; stroke-dashoffset:0; }
          6%   { opacity:.8; stroke-dashoffset:-52; }
          7%   { opacity:0; stroke-dashoffset:-52; }
          8%   { opacity:1; stroke-dashoffset:-104; }
          10%  { opacity:1; stroke-dashoffset:-104; }
          11%  { opacity:0; stroke-dashoffset:-104; }
          35%  { opacity:0; stroke-dashoffset:-52; }
          36%  { opacity:.9; stroke-dashoffset:-52; }
          37%  { opacity:0; stroke-dashoffset:-52; }
          55%  { opacity:0; stroke-dashoffset:0; }
          56%  { opacity:1; stroke-dashoffset:0; }
          57%  { opacity:.4; stroke-dashoffset:-70; }
          58%  { opacity:0; stroke-dashoffset:-70; }
          75%  { opacity:0; stroke-dashoffset:-104; }
          76%  { opacity:.8; stroke-dashoffset:-104; }
          78%  { opacity:.8; stroke-dashoffset:-104; }
          79%  { opacity:0; stroke-dashoffset:-104; }
          80%  { opacity:.6; stroke-dashoffset:-25; }
          81%  { opacity:0; stroke-dashoffset:-25; }
          100% { opacity:0; stroke-dashoffset:0; }
        }

        /* Glitch variant B — longer gaps, snappier flashes */
        @keyframes cpGlitch1 {
          0%   { opacity:0; stroke-dashoffset:-52; }
          2%   { opacity:.9; stroke-dashoffset:-52; }
          4%   { opacity:0; stroke-dashoffset:-52; }
          20%  { opacity:0; stroke-dashoffset:-104; }
          21%  { opacity:1; stroke-dashoffset:-104; }
          22%  { opacity:.5; stroke-dashoffset:-80; }
          23%  { opacity:0; stroke-dashoffset:-80; }
          45%  { opacity:0; stroke-dashoffset:0; }
          46%  { opacity:1; stroke-dashoffset:0; }
          47%  { opacity:0; stroke-dashoffset:0; }
          48%  { opacity:.7; stroke-dashoffset:-30; }
          49%  { opacity:0; stroke-dashoffset:-30; }
          65%  { opacity:0; stroke-dashoffset:-70; }
          67%  { opacity:.8; stroke-dashoffset:-70; }
          68%  { opacity:0; stroke-dashoffset:-70; }
          85%  { opacity:0; stroke-dashoffset:-104; }
          86%  { opacity:1; stroke-dashoffset:-104; }
          88%  { opacity:1; stroke-dashoffset:-104; }
          89%  { opacity:0; stroke-dashoffset:-104; }
          100% { opacity:0; stroke-dashoffset:-52; }
        }

        /* Glitch variant C — double-tap bursts, bottom-biased */
        @keyframes cpGlitch2 {
          0%   { opacity:0; stroke-dashoffset:-104; }
          5%   { opacity:1; stroke-dashoffset:-104; }
          6%   { opacity:.3; stroke-dashoffset:0; }
          7%   { opacity:0; stroke-dashoffset:0; }
          25%  { opacity:0; stroke-dashoffset:-25; }
          26%  { opacity:.8; stroke-dashoffset:-25; }
          27%  { opacity:0; stroke-dashoffset:-25; }
          40%  { opacity:0; stroke-dashoffset:-80; }
          41%  { opacity:1; stroke-dashoffset:-80; }
          43%  { opacity:1; stroke-dashoffset:-80; }
          44%  { opacity:0; stroke-dashoffset:-80; }
          60%  { opacity:0; stroke-dashoffset:-52; }
          61%  { opacity:.9; stroke-dashoffset:-52; }
          62%  { opacity:0; stroke-dashoffset:-52; }
          63%  { opacity:.6; stroke-dashoffset:-15; }
          64%  { opacity:0; stroke-dashoffset:-15; }
          80%  { opacity:0; stroke-dashoffset:-104; }
          82%  { opacity:1; stroke-dashoffset:-104; }
          83%  { opacity:0; stroke-dashoffset:-104; }
          100% { opacity:0; stroke-dashoffset:-104; }
        }
      `}</style>
    </div>
  )
}

export default function FeaturedBanner() {
  const settings = useStore(s => s.settings)

  return (
    <div className="relative h-24 md:h-28 lg:h-36 overflow-hidden border-b border-neon-orange/15 flex-shrink-0">
      <div className="absolute inset-0">
        <div
          className="w-full h-full bg-cover bg-center opacity-50"
          style={{
            backgroundImage: settings.background
              ? `url(${settings.background})`
              : 'none'
          }}
        />
      </div>

      <div className="absolute inset-0 bg-dark-500/60" />
      <div className="absolute inset-0 bg-gradient-to-r from-dark-500/60 via-dark-500/20 to-dark-500/50" />
      <div className="absolute inset-0 bg-gradient-to-b from-white/[0.03] via-transparent to-dark-500/80" />

      <BannerCanvas />

      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-neon-orange/40 to-transparent" />
        <div className="absolute bottom-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-neon-orange/20 to-transparent" />
        <div className="absolute top-0 left-0 bottom-0 w-px bg-gradient-to-b from-neon-orange/20 via-transparent to-neon-orange/10" />
        <div className="absolute top-0 right-0 bottom-0 w-px bg-gradient-to-b from-neon-orange/10 via-transparent to-neon-orange/20" />
      </div>

      <div className="relative z-20 h-full flex items-center px-3 md:px-4 lg:px-6">
        <div className="flex items-center gap-2 md:gap-3 lg:gap-5 flex-1 min-w-0">
          <div className="relative flex-shrink-0">
            <div className="w-1 md:w-1.5 h-10 md:h-12 lg:h-16 bg-gradient-to-b from-neon-orange via-neon-orange/60 to-transparent rounded-full" />
            <div className="absolute inset-0 w-1 md:w-1.5 h-10 md:h-12 lg:h-16 bg-gradient-to-b from-neon-orange via-neon-orange/60 to-transparent rounded-full blur-md" />
          </div>

          <BannerTitle settings={settings} />
        </div>

        {settings.bannerImage && (
          <div className="absolute right-3 md:right-4 lg:right-6 bottom-0 h-full flex items-end pointer-events-none">
            <img
              src={settings.bannerImage}
              alt="Banner"
              className="max-h-[80px] md:max-h-[100px] lg:max-h-[140px] w-auto object-contain"
              loading="lazy"
              decoding="async"
              style={{ filter: 'drop-shadow(0 0 20px rgb(var(--accent-rgb) / 0.3))' }}
            />
          </div>
        )}
      </div>

      <div className="absolute top-2 right-3 z-30">
        <div className="w-6 h-6 border-t-2 border-r-2 border-neon-orange/50 rounded-tr-sm" />
      </div>
      <div className="absolute bottom-2 left-3 z-30">
        <div className="w-6 h-6 border-b-2 border-l-2 border-neon-orange/50 rounded-bl-sm" />
      </div>
      <div className="absolute top-2 left-3 z-30">
        <div className="w-3 h-3 border-t border-l border-neon-orange/35" />
      </div>
      <div className="absolute bottom-2 right-3 z-30">
        <div className="w-3 h-3 border-b border-r border-neon-orange/35" />
      </div>
    </div>
  )
}

function BannerTitle({ settings }) {
  const name = (settings.launcherName || 'EXAMPLE CAFE').toUpperCase()
  const idle = useIsIdle()
  const scrambled = useScrambleText(name, { idle })

  return (
    <div className="min-w-0 flex-1">
      <h1
        className="font-orbitron font-black text-xl md:text-2xl lg:text-4xl leading-none tracking-[0.15em] lg:tracking-[0.2em] whitespace-nowrap overflow-hidden text-ellipsis"
        style={{
          color: 'rgb(var(--accent-rgb))',
          textShadow: '0 2px 4px rgba(0,0,0,0.8)',
          fontVariantNumeric: 'tabular-nums',
          fontFeatureSettings: '"tnum"',
        }}
      >
        <span style={{ display: 'inline-block', minWidth: `${name.length * 0.75}em` }}>{scrambled}</span>
      </h1>

      <p className="font-rajdhani text-white/65 text-[9px] md:text-[10px] lg:text-xs tracking-[0.15em] md:tracking-[0.2em] lg:tracking-[0.3em] uppercase mt-1 lg:mt-1.5 truncate max-w-[200px] md:max-w-[280px] lg:max-w-none">
        {settings.launcherTagline || 'JUST SIT. PLAY. RELAX & ENJOY'}
      </p>

      <div className="flex gap-1.5 md:gap-2 lg:gap-2.5 mt-1.5 md:mt-2 lg:mt-3">
        <div className="flex items-center gap-1 md:gap-1.5 px-1.5 md:px-2 lg:px-3 py-0.5 md:py-1 bg-neon-orange/10 border border-neon-orange/25 rounded-md backdrop-blur-sm">
          <span className="relative flex h-1.5 w-1.5 md:h-2 md:w-2">
            <span className="relative inline-flex rounded-full h-1.5 w-1.5 md:h-2 md:w-2 bg-neon-orange" style={{ boxShadow: '0 0 6px rgb(var(--accent-rgb))' }} />
          </span>
          <span className="text-neon-orange text-[8px] md:text-[9px] lg:text-[10px] font-orbitron font-bold tracking-wider">ONLINE</span>
        </div>

        <div className="relative flex items-center gap-1 md:gap-1.5 lg:gap-2 px-1.5 md:px-2.5 lg:px-3.5 py-0.5 md:py-1 rounded-md overflow-hidden group cursor-default">
          <div className="absolute inset-0 bg-gradient-to-r from-amber-500/20 via-yellow-400/15 to-amber-500/20 border border-amber-400/40 rounded-md" />
          <div className="absolute inset-0 bg-gradient-to-r from-amber-500/10 to-yellow-300/10 opacity-0 group-hover:opacity-100 transition-opacity duration-500 rounded-md" />
          <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-yellow-300/60 to-transparent" />
          <div className="absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-amber-500/30 to-transparent" />
          <span className="relative text-[8px] md:text-[9px]">⭐</span>
          <span className="relative text-[8px] md:text-[9px] lg:text-[10px] font-orbitron font-black tracking-widest"
            style={{ color: '#f59e0b', textShadow: '0 0 10px rgba(245,158,11,0.6), 0 0 20px rgba(245,158,11,0.2)' }}
          >
            PREMIUM
          </span>
          <div className="absolute -inset-1 rounded-md opacity-0 group-hover:opacity-100 transition-opacity duration-500"
            style={{ boxShadow: '0 0 12px rgba(245,158,11,0.15)' }}
          />
        </div>
      </div>
    </div>
  )
}
