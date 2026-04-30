import React, { useMemo } from 'react'
import useStore from '../store/useStore'

export default function ParticleBackground() {
  const accentColor = useStore(s => s.settings.accentColor) || '#ff6a00'

  const dots = useMemo(() => {
    return Array.from({ length: 12 }, (_, i) => ({
      id: i,
      left: Math.random() * 100,
      top: Math.random() * 100,
      size: Math.random() * 2 + 1,
      opacity: Math.random() * 0.12 + 0.04,
      duration: 40 + Math.random() * 60,
      delay: Math.random() * -80,
    }))
  }, [])

  return (
    <div className="absolute inset-0 pointer-events-none overflow-hidden" style={{ zIndex: 0 }}>
      {dots.map(d => (
        <div
          key={d.id}
          className="absolute rounded-full"
          style={{
            left: `${d.left}%`,
            top: `${d.top}%`,
            width: `${d.size}px`,
            height: `${d.size}px`,
            backgroundColor: accentColor,
            opacity: d.opacity,
            animation: `particleDrift ${d.duration}s linear ${d.delay}s infinite`,
            willChange: 'transform',
          }}
        />
      ))}
      <style>{`
        @keyframes particleDrift {
          0% { transform: translate(0, 0); }
          25% { transform: translate(30px, -20px); }
          50% { transform: translate(-15px, 25px); }
          75% { transform: translate(20px, 10px); }
          100% { transform: translate(0, 0); }
        }
      `}</style>
    </div>
  )
}
