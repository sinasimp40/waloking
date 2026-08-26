import React from 'react'
import { motion } from 'framer-motion'
import { Upload, ChevronRight, Folder } from 'lucide-react'
import toast from 'react-hot-toast'
import useStore from '../store/useStore'
import { getDefaultAccent } from '../lib/accent'

export function SectionTitle({ title, count, className = '' }) {
  const accent = useStore(s => s.settings.accentColor) || getDefaultAccent()
  return (
    <div className={`flex flex-col mb-8 ${className}`}>
      <div className="flex items-center gap-4">
        <h2 className="text-xl font-bold text-white tracking-wide uppercase font-jakarta">{title}</h2>
        {count !== undefined && (
          <span className="px-2 py-0.5 rounded bg-zinc-800 text-[10px] font-bold text-zinc-400 uppercase tracking-widest">{count} Items</span>
        )}
      </div>
      <motion.div 
        className="h-0.5 mt-1.5 relative overflow-hidden w-8"
        initial={{ width: 0 }}
        animate={{ width: 32 }}
      >
        <motion.div 
          className="absolute inset-0"
          style={{ backgroundColor: accent }}
          animate={{ x: ['-100%', '100%'] }}
          transition={{ duration: 3, repeat: Infinity, ease: "linear" }}
        />
        <div className="absolute inset-0 opacity-30" style={{ backgroundColor: accent }} />
      </motion.div>
    </div>
  )
}

export function Card({ children, highlight }) {
  return (
    <div className={`p-6 bg-[#0A0A0B] border transition-all rounded-2xl ${highlight ? 'border-zinc-500/50 shadow-[0_0_20px_-5px_rgba(0,0,0,0.3)]' : 'border-zinc-800/50 hover:border-zinc-700'}`}>
      {children}
    </div>
  )
}

export function Panel({ title, subtitle, action, children }) {
  return (
    <section className="bg-zinc-900/20 border border-zinc-800/40 rounded-2xl p-8 mb-8 relative overflow-hidden">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h4 className="text-[10px] font-black text-zinc-600 uppercase tracking-[0.3em] mb-1.5">{title}</h4>
          {subtitle && <p className="text-sm text-zinc-400 font-medium tracking-tight">{subtitle}</p>}
        </div>
        {action}
      </div>
      <div className="space-y-6 relative z-10">{children}</div>
    </section>
  )
}

export function PrimaryBtn({ children, onClick, type = 'button', disabled, noIcon, className = '' }) {
  const accent = useStore(s => s.settings.accentColor) || getDefaultAccent()
  return (
    <button
      type={type} onClick={onClick} disabled={disabled}
      className={`group relative flex items-center justify-center gap-3 px-6 py-3 rounded-xl font-black text-[11px] uppercase tracking-widest transition-all active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer shadow-lg shadow-black/20 ${className}`}
      style={{ backgroundColor: accent, color: '#000' }}
    >
      <span>{children}</span>
      {!noIcon && <ChevronRight size={14} className="group-hover:translate-x-1 transition-transform" />}
    </button>
  )
}

export function GhostBtn({ children, onClick, danger, type = 'button', className = '' }) {
  return (
    <button
      type={type} onClick={onClick}
      className={`px-5 py-2.5 bg-zinc-900 border border-zinc-800 hover:border-zinc-700 text-zinc-400 hover:text-white rounded-xl font-bold text-[10px] uppercase tracking-widest transition-all ${danger ? 'hover:border-red-900/30 hover:text-red-400 hover:bg-red-400/5' : ''} ${className}`}
    >
      {children}
    </button>
  )
}

export function Field({ label, children, hint }) {
  return (
    <div className="space-y-2">
      {label && <label className="block text-[10px] font-bold text-zinc-500 uppercase tracking-widest ml-1">{label}</label>}
      {children}
      {hint && <p className="text-[10px] text-zinc-600 font-medium italic">{hint}</p>}
    </div>
  )
}

export function Input({ value, onChange, placeholder, type = 'text', className = '', upload, browse, ...props }) {
  const { settings } = useStore()
  const handleBrowse = async () => {
    if (!window.electronAPI) return toast.error('Desktop integration not available');
    try {
      const result = browse === 'folder' 
        ? await window.electronAPI.selectFolder() 
        : await window.electronAPI.selectFile([
            { name: 'All Files', extensions: ['*'] }
          ]);
      if (result) onChange({ target: { value: result } });
    } catch (e) {
      toast.error('Selection failed');
    }
  }

  const handleUpload = async () => {
    if (!window.electronAPI) return toast.error('Desktop integration not available');
    try {
      const result = await window.electronAPI.selectImage()
      if (result) onChange({ target: { value: result } });
    } catch (e) {
      toast.error('Upload failed');
    }
  }

  return (
    <div className="relative group">
      <input
        type={type} value={value} onChange={onChange} placeholder={placeholder}
        className={`w-full bg-black border border-zinc-800 group-focus-within:border-zinc-700 group-focus-within:ring-1 group-focus-within:ring-zinc-700/50 rounded-xl px-4 py-3 text-white text-sm focus:outline-none transition-all placeholder:text-zinc-800 font-medium ${browse || upload ? 'pr-12' : ''} ${className}`}
        onMouseDown={e => e.stopPropagation()}
        {...props}
      />
      {upload && !browse && (
        <button 
          type="button"
          className="absolute right-3 top-1/2 -translate-y-1/2 p-1.5 text-zinc-600 hover:text-zinc-300 transition-all"
          title="Upload / Select Image"
          onClick={handleUpload}
        >
          <Upload size={14} />
        </button>
      )}
      {browse && (
        <button 
          type="button"
          className="absolute right-3 top-1/2 -translate-y-1/2 p-1.5 text-zinc-600 hover:text-zinc-300 transition-all"
          title={browse === 'folder' ? 'Browse Folder' : 'Browse File'}
          onClick={handleBrowse}
        >
          <Folder size={14} />
        </button>
      )}
    </div>
  )
}

export function Toggle({ checked, onChange, disabled }) {
  const accent = useStore(s => s.settings.accentColor) || getDefaultAccent()
  return (
    <button
      type="button"
      onClick={() => !disabled && onChange(!checked)}
      className="relative w-12 h-6 bg-black border border-zinc-800 rounded-full transition-all overflow-hidden"
    >
      <motion.div
        animate={{ x: checked ? 24 : 0 }}
        className="absolute inset-y-1 left-1 w-4 h-4 rounded-full transition-all"
        style={{ backgroundColor: checked ? accent : '#3f3f46' }}
      />
      <div className="absolute inset-0 flex justify-between items-center px-2.5 pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity">
        <span className={`text-[7px] font-black ${checked ? 'text-black' : 'text-transparent'}`}>ON</span>
        <span className={`text-[7px] font-black ${!checked ? 'text-zinc-600' : 'text-transparent'}`}>OFF</span>
      </div>
    </button>
  )
}
