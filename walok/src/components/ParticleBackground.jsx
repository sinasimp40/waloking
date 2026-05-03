import React, { useMemo } from 'react'

export default function ParticleBackground() {
  const particles = useMemo(() => Array.from({ length: 40 }, (_, i) => ({
    id: i,
    left: (i * 37.3 + 11) % 100,
    top:  (i * 53.7 + 7)  % 100,
    size: i < 6 ? (i * 0.9 + 3.5) : ((i * 0.7 + 0.4) % 2.2 + 0.4),
    opacity: i < 6 ? 0.18 + (i % 3) * 0.06 : 0.04 + (i % 4) * 0.025,
    duration: 35 + (i * 7.3) % 55,
    delay: -((i * 11.7) % 80),
    glow: i < 6,
    driftX: [28, -18, 22, -30, 14, -24, 32, -12][i % 8],
    driftY: [-22, 26, -14, 18, -28, 12, -20, 30][i % 8],
  })), [])

  const traces = useMemo(() => Array.from({ length: 10 }, (_, i) => ({
    id: i,
    top:  (i * 19.3 + 5)  % 95,
    left: (i * 23.7 + 3)  % 85,
    length: 60 + (i * 37) % 140,
    horiz: i % 3 !== 0,
    duration: 5 + (i * 2.3) % 9,
    delay: -((i * 4.1) % 18),
    opacity: 0.18 + (i % 4) * 0.08,
  })), [])

  const rings = useMemo(() => Array.from({ length: 5 }, (_, i) => ({
    id: i,
    left: 12 + (i * 19.3) % 72,
    top:  15 + (i * 17.7) % 68,
    size: 80 + (i * 43) % 200,
    duration: 7 + (i * 2.1) % 7,
    delay: -((i * 3.3) % 14),
  })), [])

  return (
    <div className="absolute inset-0 pointer-events-none overflow-hidden" style={{ zIndex: 0 }}>

      {/* Nebula glow clouds */}
      <div style={{
        position: 'absolute', top: '-15%', left: '-12%',
        width: '55%', height: '55%',
        background: 'radial-gradient(ellipse at 40% 50%, rgb(var(--accent-rgb) / 0.07) 0%, transparent 68%)',
        animation: 'nebulaA 14s ease-in-out infinite',
        willChange: 'transform, opacity',
      }} />
      <div style={{
        position: 'absolute', bottom: '-18%', right: '-15%',
        width: '65%', height: '60%',
        background: 'radial-gradient(ellipse at 60% 55%, rgb(var(--accent-rgb) / 0.055) 0%, transparent 65%)',
        animation: 'nebulaB 18s ease-in-out infinite',
        willChange: 'transform, opacity',
      }} />
      <div style={{
        position: 'absolute', top: '30%', right: '10%',
        width: '35%', height: '40%',
        background: 'radial-gradient(ellipse at 50% 50%, rgb(var(--accent-rgb) / 0.04) 0%, transparent 70%)',
        animation: 'nebulaC 22s ease-in-out infinite',
        willChange: 'transform, opacity',
      }} />

      {/* Scan line sweep */}
      <div style={{
        position: 'absolute', left: 0, right: 0, height: '2px',
        background: 'linear-gradient(90deg, transparent 0%, rgb(var(--accent-rgb) / 0.0) 15%, rgb(var(--accent-rgb) / 0.35) 40%, rgb(var(--accent-rgb) / 0.55) 50%, rgb(var(--accent-rgb) / 0.35) 60%, rgb(var(--accent-rgb) / 0.0) 85%, transparent 100%)',
        boxShadow: '0 0 8px 1px rgb(var(--accent-rgb) / 0.2)',
        animation: 'scanLine 9s linear infinite',
        willChange: 'transform',
      }} />

      {/* Particle field */}
      {particles.map(p => (
        <div key={p.id} style={{
          position: 'absolute',
          left: `${p.left}%`,
          top: `${p.top}%`,
          width: `${p.size}px`,
          height: `${p.size}px`,
          borderRadius: '50%',
          backgroundColor: 'var(--accent)',
          opacity: p.opacity,
          boxShadow: p.glow ? `0 0 ${p.size * 4}px ${p.size}px rgb(var(--accent-rgb) / 0.15)` : 'none',
          animation: `drift${p.id % 4} ${p.duration}s linear ${p.delay}s infinite`,
          willChange: 'transform',
        }} />
      ))}

      {/* Circuit energy traces */}
      {traces.map(t => (
        <div key={t.id} style={{
          position: 'absolute',
          top: `${t.top}%`,
          left: `${t.left}%`,
          width:  t.horiz ? `${t.length}px` : '1px',
          height: t.horiz ? '1px'           : `${t.length}px`,
          background: t.horiz
            ? `linear-gradient(90deg, transparent, rgb(var(--accent-rgb) / ${t.opacity}), rgb(var(--accent-rgb) / ${t.opacity * 1.4}), rgb(var(--accent-rgb) / ${t.opacity}), transparent)`
            : `linear-gradient(180deg, transparent, rgb(var(--accent-rgb) / ${t.opacity}), rgb(var(--accent-rgb) / ${t.opacity * 1.4}), rgb(var(--accent-rgb) / ${t.opacity}), transparent)`,
          animation: `traceFlash ${t.duration}s ease-in-out ${t.delay}s infinite`,
          willChange: 'opacity, transform',
          transformOrigin: t.horiz ? 'left center' : 'center top',
        }} />
      ))}

      {/* Pulse rings */}
      {rings.map(r => (
        <div key={r.id} style={{
          position: 'absolute',
          left: `${r.left}%`,
          top: `${r.top}%`,
          width: `${r.size}px`,
          height: `${r.size}px`,
          marginLeft: `-${r.size / 2}px`,
          marginTop: `-${r.size / 2}px`,
          border: '1px solid rgb(var(--accent-rgb) / 0.25)',
          borderRadius: '50%',
          animation: `pulseRing ${r.duration}s ease-out ${r.delay}s infinite`,
          willChange: 'transform, opacity',
        }} />
      ))}

      {/* Vignette edges */}
      <div style={{
        position: 'absolute', inset: 0,
        background: 'radial-gradient(ellipse at 50% 50%, transparent 55%, rgba(0,0,0,0.45) 100%)',
        pointerEvents: 'none',
      }} />

      <style>{`
        @keyframes drift0 {
          0%   { transform: translate(0px,    0px);   }
          25%  { transform: translate(28px,  -22px);  }
          50%  { transform: translate(-14px,  20px);  }
          75%  { transform: translate(18px,   8px);   }
          100% { transform: translate(0px,    0px);   }
        }
        @keyframes drift1 {
          0%   { transform: translate(0px,   0px);   }
          33%  { transform: translate(-20px, 18px);  }
          66%  { transform: translate(24px, -12px);  }
          100% { transform: translate(0px,   0px);   }
        }
        @keyframes drift2 {
          0%   { transform: translate(0px,   0px);  }
          20%  { transform: translate(16px,  24px); }
          60%  { transform: translate(-22px,-16px); }
          80%  { transform: translate(10px,  12px); }
          100% { transform: translate(0px,   0px);  }
        }
        @keyframes drift3 {
          0%   { transform: translate(0px,  0px);  }
          40%  { transform: translate(-18px,22px); }
          70%  { transform: translate(26px,-10px); }
          100% { transform: translate(0px,  0px);  }
        }
        @keyframes scanLine {
          0%   { transform: translateY(-8px); }
          100% { transform: translateY(100vh); }
        }
        @keyframes traceFlash {
          0%   { opacity: 0;   transform: scaleX(0.05); }
          15%  { opacity: 1;   transform: scaleX(1);    }
          75%  { opacity: 0.9; transform: scaleX(1);    }
          100% { opacity: 0;   transform: scaleX(1.05); }
        }
        @keyframes pulseRing {
          0%   { transform: scale(0.15); opacity: 0.7; }
          60%  { opacity: 0.25; }
          100% { transform: scale(2.8);  opacity: 0;   }
        }
        @keyframes nebulaA {
          0%, 100% { transform: scale(1)    translate(0%,  0%);  opacity: 0.9; }
          40%      { transform: scale(1.18) translate(4%,  3%);  opacity: 1;   }
          70%      { transform: scale(0.95) translate(-2%, 2%);  opacity: 0.8; }
        }
        @keyframes nebulaB {
          0%, 100% { transform: scale(1)    translate(0%,   0%); opacity: 0.85; }
          35%      { transform: scale(1.12) translate(-3%, -2%); opacity: 1;    }
          65%      { transform: scale(1.05) translate(2%,   3%); opacity: 0.75; }
        }
        @keyframes nebulaC {
          0%, 100% { transform: scale(1)    translate(0%,  0%);  opacity: 0.7;  }
          50%      { transform: scale(1.22) translate(-4%, 5%);  opacity: 1;    }
        }
        @media (prefers-reduced-motion: reduce) {
          * { animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; }
        }
      `}</style>
    </div>
  )
}
