import React, { useState } from 'react'
import { motion } from 'framer-motion'
import { Tv } from 'lucide-react'
import toast from 'react-hot-toast'
import useStore from '../store/useStore'
import { getDefaultAccent } from '../lib/accent'
import { afterGameLaunch } from '../lib/afterLaunch'
import { createGameLaunchPayload } from '../lib/gameLaunchPayload'

export default function BottomBar() {
  const { settings, openIPTV } = useStore()
  const accent = settings.accentColor || getDefaultAccent()
  const rates = settings.computerRates || []
  const socials = settings.socialLinks || []
  const apps = settings.officeApps || []

  const handleSocialClick = (s) => {
    if (!s.url || s.url === '#') return
    if (window.electronAPI?.openExternal) {
      const browser = settings.customBrowserEnabled ? (settings.customBrowserPath || '') : ''
      window.electronAPI.openExternal(s.url, browser)
    } else {
      window.open(s.url, '_blank', 'noopener')
    }
    afterGameLaunch(settings)
  }

  const handleAppClick = async (app) => {
    if (!app.exePath) { toast.error(`No path for ${app.name}`); return }
    if (window.electronAPI) {
      const r = await window.electronAPI.launchGame(
        createGameLaunchPayload(app, app.exePath, settings)
      )
      if (r.success) {
        toast.success(`Opening ${app.name}…`)
        afterGameLaunch(settings)
      } else { toast.error(r.error || `Could not open ${app.name}`) }
    } else {
      toast.success(`Opening ${app.name}… (preview)`)
    }
  }

  const hasContent = rates.length > 0 || socials.length > 0 || apps.length > 0 || settings.showIPTV !== false

  if (!hasContent) return null

  return (
    <div
      className="flex items-center gap-0 flex-shrink-0 relative z-20 overflow-hidden"
      style={{
        height: 'var(--bottom-h)',
        background: 'rgba(8,8,9,0.75)',
        backdropFilter: 'blur(24px)',
        borderTop: '1px solid rgba(255,255,255,0.07)',
      }}
    >
      {/* Rates */}
      {rates.length > 0 && (
        <div className="flex items-center gap-0 h-full flex-shrink-0">
          {rates.map((rate, i) => {
            const colors = [accent, '#FFD600', '#00BCD4']
            const c = colors[i] || accent
            return (
              <div
                key={i}
                className="flex items-center gap-2.5 px-4 h-full border-r"
                style={{ borderColor: 'rgba(255,255,255,0.06)' }}
              >
                <div>
                  <div
                    className="font-syne font-black leading-none"
                    style={{ fontSize: 18, color: c, textShadow: `0 0 12px ${c}80` }}
                  >
                    {rate.price}
                    <span style={{ fontSize: 9, fontWeight: 600, color: `${c}90`, marginLeft: 2 }}>
                      {rate.unit}
                    </span>
                  </div>
                  <div className="font-jakarta text-[9px] uppercase tracking-widest mt-0.5" style={{ color: `${c}70` }}>
                    {rate.name}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Social */}
      {socials.length > 0 && (
        <div className="flex items-center gap-2 px-4 h-full border-r flex-shrink-0"
          style={{ borderColor: 'rgba(255,255,255,0.06)' }}>
          {socials.map(s => (
            <motion.button
              key={s.id}
              whileHover={{ scale: 1.2, y: -2 }}
              whileTap={{ scale: 0.85 }}
              onClick={() => handleSocialClick(s)}
              title={s.name}
              className={`w-8 h-8 rounded-xl bg-gradient-to-br ${s.color || 'from-fuchsia-500 to-purple-700'} flex items-center justify-center text-white text-xs shadow-lg cursor-pointer overflow-hidden`}
              style={{ boxShadow: `0 4px 12px rgba(0,0,0,0.4)` }}
            >
              {s.image ? <img src={s.image} alt={s.name} className="w-full h-full object-cover" /> : s.icon}
            </motion.button>
          ))}
        </div>
      )}

      {/* Apps */}
      {apps.length > 0 && (
        <div className="flex items-center gap-2 px-4 h-full border-r flex-shrink-0"
          style={{ borderColor: 'rgba(255,255,255,0.06)' }}>
          {apps.map(app => (
            <motion.button
              key={app.id}
              whileHover={{ scale: 1.2, y: -2 }}
              whileTap={{ scale: 0.85 }}
              onClick={() => handleAppClick(app)}
              title={app.name}
              className={`w-8 h-8 rounded-xl bg-gradient-to-br ${app.color || 'from-fuchsia-500 to-purple-700'} flex items-center justify-center text-white text-[10px] font-bold shadow-lg cursor-pointer overflow-hidden`}
            >
              {app.image ? <img src={app.image} alt={app.name} className="w-full h-full object-cover" /> : app.icon}
            </motion.button>
          ))}
        </div>
      )}

      {/* IPTV */}
      {settings.showIPTV !== false && (
        <div className="flex items-center px-4 h-full border-r flex-shrink-0"
          style={{ borderColor: 'rgba(255,255,255,0.06)' }}>
          <motion.button
            whileHover={{ scale: 1.04 }}
            whileTap={{ scale: 0.96 }}
            onClick={openIPTV}
            className="flex items-center gap-2 px-3 py-1.5 rounded-xl"
            style={{
              background: `linear-gradient(135deg, ${accent}25, rgba(0,188,212,0.15))`,
              border: `1px solid ${accent}35`,
              boxShadow: `0 0 16px ${accent}15`,
            }}
          >
            <Tv size={14} style={{ color: accent }} />
            <div>
              <div className="font-syne font-bold text-xs tracking-wider" style={{ color: accent }}>
                LIVE TV
              </div>
              <div className="flex items-center gap-1">
                <div className="w-1.5 h-1.5 rounded-full bg-red-400 animate-pulse" />
                <span className="font-jakarta text-[8px] text-dim uppercase tracking-widest">On Air</span>
              </div>
            </div>
          </motion.button>
        </div>
      )}

    </div>
  )
}
