import React, { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Lock, Eye, EyeOff, ShieldCheck, ChevronRight, Fingerprint } from 'lucide-react'
import useStore from '../store/useStore'
import { getDefaultAccent } from '../lib/accent'

export default function AdminLogin() {
  const { authenticateAdmin, closeAdmin } = useStore()
  const accent = useStore(s => s.settings.accentColor) || getDefaultAccent()
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState(false)

  const handleSubmit = (e) => {
    e.preventDefault()
    if (authenticateAdmin(password)) {
      setError(false)
    } else {
      setError(true)
      setPassword('')
    }
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-md"
      onMouseDown={closeAdmin}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.98 }}
        animate={{ opacity: 1, scale: 1 }}
        className="w-full max-w-[580px] flex overflow-hidden bg-[#0A0A0B] border border-zinc-800/50 shadow-[0_0_60px_-12px_rgba(0,0,0,0.6)] rounded-lg"
        onMouseDown={e => e.stopPropagation()}
      >
        {/* Left Side: Brand/Accent Block */}
        <div 
          className="w-24 flex-shrink-0 flex items-center justify-center relative overflow-hidden"
          style={{ background: accent }}
        >
          <div className="absolute inset-0 opacity-20 bg-[radial-gradient(circle_at_center,_var(--tw-gradient-stops))] from-white via-transparent to-transparent" />
          
          <div className="relative z-10">
            <Fingerprint className="text-white/20" size={42} strokeWidth={1} />
            <motion.div
              className="absolute inset-0 overflow-hidden"
              animate={{ height: ['0%', '100%', '0%'] }}
              transition={{ duration: 3, repeat: Infinity, ease: "linear" }}
            >
              <Fingerprint className="text-white" size={42} strokeWidth={1.5} />
            </motion.div>
            
            {/* Scanning Line */}
            <motion.div 
              className="absolute left-[-4px] right-[-4px] h-[2px] bg-white shadow-[0_0_8px_rgba(255,255,255,0.8)] z-20"
              animate={{ top: ['0%', '100%', '0%'] }}
              transition={{ duration: 3, repeat: Infinity, ease: "linear" }}
            />
          </div>
          
          <div className="absolute right-0 top-0 bottom-0 w-px bg-white/10" />
        </div>

        {/* Right Side: Form Content */}
        <div className="flex-1 p-10 bg-gradient-to-br from-zinc-900 to-zinc-950 flex flex-col justify-between min-h-[260px]">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-xl font-bold text-white tracking-wide uppercase font-jakarta">System Access</h2>
              <div className="h-0.5 mt-1.5 relative overflow-hidden w-8">
                <motion.div 
                  className="absolute inset-0"
                  style={{ backgroundColor: accent }}
                  animate={{ 
                    x: ['-100%', '0%', '100%']
                  }}
                  transition={{ 
                    duration: 2.5,
                    repeat: Infinity,
                    ease: "easeInOut"
                  }}
                />
                <div className="absolute inset-0 opacity-30" style={{ backgroundColor: accent }} />
              </div>
            </div>
          </div>

          <form onSubmit={handleSubmit} className="flex gap-4 items-center mt-4">
            <div className="flex-1">
              <div className="relative group">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={e => { setPassword(e.target.value); setError(false) }}
                  placeholder="••••••••"
                  autoFocus
                  autoComplete="off"
                  className={`w-full bg-zinc-950/50 border ${error ? 'border-red-500/50' : 'border-zinc-800 group-focus-within:border-zinc-700'} rounded-lg px-4 py-3.5 text-white text-[14px] focus:outline-none transition-all placeholder:text-zinc-800 font-mono`}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(v => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-600 hover:text-zinc-400 transition-colors"
                >
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>

            <div className="flex flex-col gap-0 min-w-[160px]">
              <button
                type="submit"
                className="group relative flex items-center justify-between px-8 py-[14px] bg-white hover:bg-zinc-100 text-black rounded-lg font-bold text-[13px] uppercase tracking-widest transition-all active:scale-[0.98] cursor-pointer"
              >
                <span>Authorize</span>
                <ChevronRight size={18} className="group-hover:translate-x-1 transition-transform" />
              </button>
            </div>
          </form>

          <div className="flex items-center justify-between mt-2">
            <div className="h-4 flex-1">
              <AnimatePresence mode="wait">
                {error && (
                  <motion.div
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: 10 }}
                    className="flex items-center gap-2 text-red-500 text-[10px] font-bold uppercase tracking-wider"
                  >
                    <div className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
                    Invalid Signature
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
            
            <button
              type="button"
              onClick={closeAdmin}
              className="text-[10px] text-zinc-500 hover:text-zinc-400 font-bold uppercase tracking-widest transition-colors"
            >
              Cancel Access
            </button>
          </div>
        </div>
      </motion.div>
    </div>
  )
}
