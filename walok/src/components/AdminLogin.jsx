import React, { useState } from 'react'
import { motion } from 'framer-motion'
import { Lock, Eye, EyeOff, Shield, X } from 'lucide-react'
import toast from 'react-hot-toast'
import useStore from '../store/useStore'

export default function AdminLogin() {
  const { authenticateAdmin, closeAdmin } = useStore()
  const [key, setKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [isShaking, setIsShaking] = useState(false)
  const [attempts, setAttempts] = useState(0)

  const handleSubmit = (e) => {
    e.preventDefault()
    if (authenticateAdmin(key)) {
      toast.success('Access granted. Welcome, Admin.')
    } else {
      setAttempts(a => a + 1)
      setIsShaking(true)
      setTimeout(() => setIsShaking(false), 500)
      setKey('')
      toast.error('Invalid secret key')
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/90">
      <motion.div
        initial={{ scale: 0.85, opacity: 0 }}
        animate={{
          scale: 1,
          opacity: 1,
          x: isShaking ? [0, -10, 10, -10, 10, 0] : 0
        }}
        transition={{ duration: 0.3 }}
        className="relative w-96 bg-dark-400 border border-neon-orange/20 rounded-xl overflow-hidden"
      >
        <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-neon-orange to-transparent" />

        <button
          onClick={closeAdmin}
          className="absolute top-4 right-4 w-6 h-6 flex items-center justify-center text-white/20 hover:text-red-500 transition-colors"
        >
          <X size={14} />
        </button>

        <div className="p-10">
          <div className="flex flex-col items-center mb-8">
            <motion.div
              animate={{ rotate: [0, 360] }}
              transition={{ duration: 25, repeat: Infinity, ease: 'linear' }}
              className="w-16 h-16 rounded-full border border-neon-orange/20 flex items-center justify-center mb-4 relative"
            >
              <div className="absolute inset-2 rounded-full border border-neon-orange/10 animate-ping" style={{ animationDuration: '3s' }} />
              <Shield size={22} className="text-neon-orange" />
            </motion.div>
            <h2 className="font-orbitron font-bold text-lg text-neon-orange neon-text tracking-[0.2em]">ADMIN ACCESS</h2>
            <p className="font-rajdhani text-white/20 text-sm mt-1 tracking-[0.15em] uppercase">Enter secret key</p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-5">
            <div className="relative">
              <Lock size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-neon-orange/30" />
              <input
                type={showKey ? 'text' : 'password'}
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder="••••••••••••"
                className="w-full pl-9 pr-10 py-3 bg-dark-500 border border-white/5 rounded-lg text-neon-orange font-orbitron text-sm placeholder:text-white/10 focus:outline-none focus:border-neon-orange/40 transition-all tracking-widest"
                autoFocus
              />
              <button
                type="button"
                onClick={() => setShowKey(!showKey)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-white/20 hover:text-neon-orange transition-colors"
              >
                {showKey ? <EyeOff size={13} /> : <Eye size={13} />}
              </button>
            </div>

            {attempts > 0 && (
              <motion.p
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="text-red-500/60 text-xs font-rajdhani text-center tracking-wider"
              >
                Failed attempts: {attempts}
              </motion.p>
            )}

            <motion.button
              type="submit"
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
              className="w-full py-3 bg-neon-orange text-black font-orbitron font-bold text-sm tracking-[0.2em] rounded-lg hover:shadow-neon-sm transition-all uppercase"
            >
              AUTHENTICATE
            </motion.button>
          </form>

        </div>
      </motion.div>
    </div>
  )
}
