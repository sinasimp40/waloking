import React, { useState, useRef, useEffect } from 'react'
import {
  X, Plus, Edit2, Trash2, Star, Pin, Upload, Save, Search,
  Gamepad2, Settings, Image, Layout, Key, Monitor, DollarSign,
  Share2, Briefcase, ExternalLink, Power, Megaphone, Bold, Italic,
  Underline, Type, Palette, AlignLeft, List, Network, ChevronRight,
  Download, ArchiveRestore, Tv, ChevronDown, Heart, Calendar,
  Activity, Cpu, Wifi, Shield
} from 'lucide-react'
import toast from 'react-hot-toast'
import { motion, AnimatePresence } from 'framer-motion'
import useStore from '../store/useStore'
import { getDefaultAccent } from '../lib/accent'
import * as Sections from './AdminPanelSections'
import IGDBSearchModal from './IGDBSearchModal'
import { 
  SectionTitle, Card, Panel, PrimaryBtn, GhostBtn, 
  Field, Input, Toggle 
} from './AdminPanelShared'

export default function AdminPanel() {
  const { closeAdmin, adminSection, setAdminSection } = useStore()
  const accent = useStore(s => s.settings.accentColor) || getDefaultAccent()

  const sections = [
    { id: 'games', label: 'Games', icon: Gamepad2 },
    { id: 'featured', label: 'Featured', icon: Star },
    { id: 'rates', label: 'Rates', icon: DollarSign },
    { id: 'social', label: 'Social', icon: Share2 },
    { id: 'office', label: 'Apps', icon: Briefcase },
    { id: 'pcgroups', label: 'PC Grouping', icon: Network },
    { id: 'announcement', label: 'News', icon: Megaphone },
    { id: 'events', label: 'Events', icon: Calendar },
    { id: 'appearance', label: 'Design', icon: Palette },
    { id: 'settings', label: 'Settings', icon: Settings },
    { id: 'backup', label: 'Backup', icon: Download },
  ]

  return (
    <div className="fixed inset-0 z-[100] bg-[#020203] text-zinc-200 font-jakarta overflow-hidden">
      <div className="relative w-full h-full flex overflow-hidden">
        {/* Navigation Sidebar */}
        <aside className="w-72 flex-shrink-0 bg-[#0A0A0B] border-r border-zinc-800/50 flex flex-col">
          <div className="h-20 flex items-center px-8 border-b border-zinc-800/50 relative overflow-hidden">
            <div className="absolute top-0 left-0 w-1 h-full" style={{ backgroundColor: accent }} />
            <div className="flex items-center gap-4">
              <div className="w-10 h-10 bg-zinc-950 border border-zinc-800 rounded-xl flex items-center justify-center relative overflow-hidden group">
                 <Shield size={16} className="text-zinc-400 group-hover:text-white transition-colors relative z-10" />
                 <div className="absolute inset-0 bg-zinc-900 opacity-0 group-hover:opacity-100 transition-opacity" />
              </div>
              <div className="flex flex-col">
                <span className="font-bold text-white tracking-widest text-[10px] uppercase font-jakarta">System Core</span>
                <span className="text-[8px] text-zinc-500 font-bold uppercase tracking-[0.3em]">Management Console</span>
              </div>
            </div>
          </div>

          <nav className="flex-1 w-full py-8 px-4 space-y-2 overflow-y-auto custom-scrollbar">
            {sections.map(s => (
              <button
                key={s.id}
                onClick={() => setAdminSection(s.id)}
                className={`w-full flex items-center gap-4 px-5 py-4 transition-all relative group ${adminSection === s.id ? 'text-white' : 'text-zinc-500 hover:text-zinc-300'}`}
              >
                {adminSection === s.id && (
                  <motion.div 
                    layoutId="active-nav"
                    className="absolute inset-0 bg-zinc-900/40 rounded-xl"
                  />
                )}
                {adminSection === s.id && (
                  <div className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-6 rounded-full" style={{ backgroundColor: accent }} />
                )}
                <s.icon size={18} className={`relative z-10 transition-colors ${adminSection === s.id ? '' : 'group-hover:text-zinc-300'}`} style={{ color: adminSection === s.id ? accent : undefined }} />
                <span className="relative z-10 text-[11px] font-bold uppercase tracking-[0.2em]">{s.label}</span>
              </button>
            ))}
          </nav>

          <div className="p-6 border-t border-zinc-800/50">
             <button 
                onClick={closeAdmin} 
                className="w-full flex items-center justify-center gap-3 px-4 py-3.5 bg-zinc-900 hover:bg-red-950/20 text-zinc-500 hover:text-red-500 border border-zinc-800 hover:border-red-900/30 rounded-xl transition-all text-[10px] font-bold uppercase tracking-[0.2em] group"
              >
                <Power size={14} />
                <span>Abort Session</span>
             </button>
          </div>
        </aside>

        {/* Main Content */}
        <div className="flex-1 flex flex-col min-w-0 bg-[#020203] relative">
          {/* Subtle Grid Pattern Overlay */}
          <div className="absolute inset-0 opacity-[0.02] pointer-events-none bg-[url('https://www.transparenttextures.com/patterns/carbon-fibre.png')]" />
          
          {/* Header */}
          <header className="h-20 flex-shrink-0 flex items-center justify-between px-10 border-b border-zinc-800/50 bg-[#0A0A0B]/80 backdrop-blur-md relative z-10">
            <div className="flex items-center gap-4">
                <div className="w-1 h-6" style={{ backgroundColor: accent }} />
                <h1 className="text-xl font-bold text-white uppercase tracking-widest font-jakarta">
                    {sections.find(s => s.id === adminSection)?.label}
                </h1>
            </div>

            <div className="flex items-center gap-6">
            </div>
          </header>

          {/* Content Area */}
          <main className="flex-1 overflow-y-auto custom-scrollbar relative z-10">
            <div className="max-w-6xl mx-auto px-10 py-12">
              <AnimatePresence mode="wait">
                <motion.div
                  key={adminSection}
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -20 }}
                  transition={{ duration: 0.3, ease: "easeOut" }}
                >
                  <div className="grid grid-cols-1">
                    {adminSection === 'games' && <GamesSection gameId={useStore.getState().editingGameId} />}
                    {adminSection === 'featured' && <Sections.FeaturedSection />}
                    {adminSection === 'rates' && <Sections.RatesSection />}
                    {adminSection === 'social' && <Sections.SocialSection />}
                    {adminSection === 'office' && <Sections.OfficeSection />}
                    {adminSection === 'pcgroups' && <Sections.PCGroupsSection />}
                    {adminSection === 'announcement' && <Sections.AnnouncementSection />}
                    {adminSection === 'events' && <Sections.EventsSection />}
                    {adminSection === 'appearance' && <Sections.AppearanceSection />}
                    {adminSection === 'settings' && <Sections.SettingsSection />}
                    {adminSection === 'backup' && <Sections.BackupSection />}
                  </div>
                </motion.div>
              </AnimatePresence>
            </div>
          </main>
        </div>
      </div>
    </div>
  )
}



// ─── Games section ────────────────────────────────────────────────────────────
function GamesSection({ gameId }) {
  const { games, addGame, updateGame, deleteGame, togglePinned, toggleFavorite } = useStore()
  const [showForm, setShowForm] = useState(!!gameId)
  const [editGame, setEditGame] = useState(null)
  const [filter, setFilter] = useState('')
  const [isIgdbModalOpen, setIsIgdbModalOpen] = useState(false)
  const [form, setForm] = useState({ name: '', category: 'offline', icon: '', wallpaper: '', exePath: '', savePath: '', description: '', tags: '', pcGroups: [], variations: [] })
  
  useEffect(() => {
    if (gameId) {
      const g = games.find(x => x.id === gameId)
      if (g) handleEdit(g)
      useStore.setState({ editingGameId: null })
    }
  }, [gameId, games])

  const handleEdit = (game) => {
    setForm({ ...game, tags: game.tags?.join(', ') || '', pcGroups: game.pcGroups || [], savePath: game.savePath || '', wallpaper: game.wallpaper || '', variations: game.variations || [] })
    setEditGame(game); setShowForm(true)
    setTimeout(() => {
      const formEl = document.getElementById('game-edit-form');
      if (formEl) {
        const scrollParent = formEl.closest('.custom-scrollbar');
        if (scrollParent) {
          scrollParent.scrollTo({ top: formEl.offsetTop - 20, behavior: 'smooth' });
        }
      }
    }, 100);
  }

  const resetForm = () => {
    setForm({ name: '', category: 'offline', icon: '', wallpaper: '', exePath: '', savePath: '', description: '', tags: '', pcGroups: [], variations: [] })
    setEditGame(null); setShowForm(false)
  }

  const handleSubmit = (e) => {
    e.preventDefault()
    if (!form.name.trim()) return toast.error('Name required')
    const gameData = { ...form, tags: form.tags.split(',').map(t => t.trim()).filter(Boolean) }
    if (editGame) { updateGame(editGame.id, gameData); toast.success('Updated successfully') }
    else { addGame(gameData); toast.success('Game added') }
    resetForm()
  }

  const displayed = games.filter(g => !filter || g.name.toLowerCase().includes(filter.toLowerCase()))

  if (showForm) {
    return (
        <div id="game-edit-form" className="space-y-8 scroll-mt-6">
            <div className="flex items-center justify-between mb-12">
                <SectionTitle title={editGame ? "Modify Game Entry" : "Initialize New Game"} />
                <GhostBtn onClick={resetForm} className="!border-zinc-700/50 hover:!bg-red-950/20 hover:!text-red-400 hover:!border-red-900/30">
                    Cancel
                </GhostBtn>
            </div>

            <Panel title="Primary Data Configuration" subtitle="Define executable paths and system identifiers">
                <form onSubmit={handleSubmit} className="space-y-10">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-10">
                        <Field label="Game Designation">
                            <Input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. COUNTER_STRIKE_PRO" />
                        </Field>
                        <Field label="System Executable Path">
                            <Input value={form.exePath} onChange={e => setForm(f => ({ ...f, exePath: e.target.value }))} placeholder="C:\PROTCOLS\SYSTEM\..." browse="file" />
                        </Field>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-10">
                        <Field label="Save and Load Folder Path">
                            <Input value={form.savePath} onChange={e => setForm(f => ({ ...f, savePath: e.target.value }))} placeholder="C:\PROTCOLS\SYSTEM\SAVE" browse="folder" />
                        </Field>
                        <Field label="Game Category">
                            <div className="space-y-3">
                                <div className="flex flex-wrap gap-2">
                                    {['online', 'offline', 'tools'].map(c => (
                                        <button 
                                            key={c}
                                            type="button"
                                            onClick={() => setForm(f => ({ ...f, category: c }))}
                                            className={`px-4 py-2 text-[10px] font-black uppercase tracking-[0.2em] rounded-lg border transition-all ${form.category === c ? 'bg-orange-500 text-black border-orange-500 shadow-[0_0_15px_rgba(249,115,22,0.3)]' : 'bg-black border-zinc-800 text-zinc-500 hover:text-zinc-300 hover:border-zinc-700'}`}
                                        >
                                            {c}
                                        </button>
                                    ))}
                                    <button 
                                        type="button"
                                        onClick={() => setForm(f => ({ ...f, category: 'Custom' }))}
                                        className={`px-4 py-2 text-[10px] font-black uppercase tracking-[0.2em] rounded-lg border transition-all ${!['online', 'offline', 'tools'].includes(form.category) || form.category === 'Custom' ? 'bg-orange-500 text-black border-orange-500 shadow-[0_0_15px_rgba(249,115,22,0.3)]' : 'bg-black border-zinc-800 text-zinc-500 hover:text-zinc-300 hover:border-zinc-700'}`}
                                    >
                                        Custom
                                    </button>
                                </div>
                                {!['online', 'offline', 'tools'].includes(form.category) && (
                                    <motion.div
                                        initial={{ opacity: 0, y: -10 }}
                                        animate={{ opacity: 1, y: 0 }}
                                    >
                                        <Input 
                                            value={form.category === 'Custom' ? '' : form.category} 
                                            onChange={e => setForm(f => ({ ...f, category: e.target.value }))}
                                            placeholder="Enter custom category name..."
                                            autoFocus
                                        />
                                    </motion.div>
                                )}
                            </div>
                        </Field>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-10">
                        <Field label="Visual Interface URL (Icon)">
                            <Input value={form.icon} onChange={e => setForm(f => ({ ...f, icon: e.target.value }))} placeholder="https://cdn.assets/..." upload />
                        </Field>
                        <Field label="Environment Wallpaper URL">
                            <Input value={form.wallpaper} onChange={e => setForm(f => ({ ...f, wallpaper: e.target.value }))} placeholder="https://cdn.assets/..." upload />
                        </Field>
                    </div>
                    <div className="grid grid-cols-1 gap-10">
                        <Field label="Assigned PC Groupings" hint="Select groups allowed to display this game">
                            <div className="flex flex-wrap gap-3 p-4 bg-zinc-950/30 border border-zinc-900 rounded-xl">
                                {useStore.getState().settings.pcGroups?.map(group => (
                                    <button
                                        key={group.id}
                                        type="button"
                                        onClick={() => {
                                            const current = form.pcGroups || []
                                            const next = current.includes(group.id)
                                                ? current.filter(id => id !== group.id)
                                                : [...current, group.id]
                                            setForm(f => ({ ...f, pcGroups: next }))
                                        }}
                                        className={`px-4 py-2 text-[9px] font-black uppercase tracking-widest rounded-lg border transition-all ${
                                            (form.pcGroups || []).includes(group.id)
                                                ? 'bg-orange-500 text-black border-orange-500'
                                                : 'bg-black border-zinc-800 text-zinc-500 hover:border-zinc-700'
                                        }`}
                                    >
                                        {group.name}
                                    </button>
                                ))}
                                {(!useStore.getState().settings.pcGroups || useStore.getState().settings.pcGroups.length === 0) && (
                                    <span className="text-[9px] text-zinc-600 uppercase font-bold py-2">No groupings defined in Network tab</span>
                                )}
                            </div>
                        </Field>
                    </div>
                    <Field label="Technical Description">
                        <Input value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} placeholder="Input brief operational summary..." />
                    </Field>
                    <Field label="Game Variations">
                        <div className="space-y-4 p-4 bg-zinc-950/30 border border-zinc-900">
                            {form.variations?.map((v, i) => (
                                <div key={i} className="flex flex-col gap-4 p-4 bg-zinc-900/40 border border-zinc-800 relative group">
                                    <div className="flex gap-4">
                                        <Input className="flex-1" value={v.label} onChange={e => {
                                            const next = [...form.variations]; next[i].label = e.target.value; setForm(f => ({ ...f, variations: next }))
                                        }} placeholder="Variation Label (e.g. DX11)" />
                                        <Input className="flex-[2]" value={v.path} onChange={e => {
                                            const next = [...form.variations]; next[i].path = e.target.value; setForm(f => ({ ...f, variations: next }))
                                        }} placeholder="Executable Path" browse="file" />
                                        <button type="button" onClick={() => {
                                            const next = form.variations.filter((_, idx) => idx !== i); setForm(f => ({ ...f, variations: next }))
                                        }} className="p-2 text-zinc-600 hover:text-red-500"><Trash2 size={16}/></button>
                                    </div>
                                    <Input value={v.savePath || ''} onChange={e => {
                                        const next = [...form.variations]; next[i].savePath = e.target.value; setForm(f => ({ ...f, variations: next }))
                                    }} placeholder="Save and Load Folder Path for this variation" browse="folder" />
                                </div>
                            ))}
                            <button 
                                type="button"
                                onClick={() => setForm(f => ({ ...f, variations: [...(f.variations || []), { label: '', path: '' }] }))}
                                className="flex items-center gap-2 text-[10px] font-bold text-zinc-500 hover:text-white uppercase tracking-widest transition-colors"
                            >
                                <Plus size={14} /> Add Variation
                            </button>
                        </div>
                    </Field>
                    <div className="flex justify-end pt-8 border-t border-zinc-900">
                        <PrimaryBtn type="submit">{editGame ? 'Commit Modifications' : 'Saved'}</PrimaryBtn>
                    </div>
                </form>
            </Panel>
        </div>
    )
  }

  const handleIgdbSelect = (igdbGame) => {
    setForm(f => ({
      ...f,
      name: igdbGame.name,
      description: igdbGame.summary,
      icon: igdbGame.icon,
      wallpaper: igdbGame.wallpaper,
      category: igdbGame.category || 'offline'
    }))
    setIsIgdbModalOpen(false)
    setShowForm(true)
  }

  return (
    <div className="space-y-10">
        <div className="flex items-center justify-between gap-8 h-12 mb-10">
            <SectionTitle title="Game List" count={displayed.length} className="!mb-0" />
            <div className="flex-1 flex items-center justify-end gap-4">
                <div className="relative group flex-1 max-w-md">
                    <Search size={14} className="absolute left-4 top-1/2 -translate-y-1/2 text-zinc-600 group-focus-within:text-zinc-300 transition-colors" />
                    <input 
                        className="bg-zinc-950 border border-zinc-800 focus:border-zinc-700 w-full pl-10 pr-4 py-2.5 text-[10px] font-bold uppercase tracking-widest text-white focus:outline-none transition-all placeholder:text-zinc-800"
                        placeholder="Search Games..."
                        value={filter}
                        onChange={e => setFilter(e.target.value)}
                    />
                </div>
                <div className="flex items-center gap-3">
                    <PrimaryBtn onClick={() => setIsIgdbModalOpen(true)} className="whitespace-nowrap">
                        <span>Add Games</span>
                    </PrimaryBtn>
                </div>
            </div>
        </div>

        <IGDBSearchModal 
            isOpen={isIgdbModalOpen} 
            onClose={() => setIsIgdbModalOpen(false)} 
            onSelect={handleIgdbSelect} 
        />
        
        <div className="flex flex-col gap-4">
            {displayed.map(g => (
                <Card key={g.id} className="group/game relative !p-0 overflow-hidden border-zinc-800/50 hover:border-zinc-700 transition-all duration-300">
                    <div className="flex items-center h-24 bg-[#0A0A0B]">
                        {/* Game Media Section - Compact Icon */}
                        <div className="w-24 h-full relative overflow-hidden bg-zinc-950 flex-shrink-0 border-r border-zinc-900">
                            {g.icon ? (
                                <img 
                                    src={g.icon} 
                                    alt={g.name} 
                                    className="w-full h-full object-cover opacity-50 group-hover/game:opacity-80 transition-all duration-500" 
                                />
                            ) : (
                                <div className="w-full h-full flex items-center justify-center">
                                    <Gamepad2 size={24} className="text-zinc-800" />
                                </div>
                            )}
                            
                            {/* Category Indicator - Mini */}
                        </div>

                        {/* Game Info Section - Horizontal Flow */}
                        <div className="flex-1 px-4 py-3 flex items-center justify-between min-w-0">
                            <div className="flex flex-col min-w-0 pr-4">
                                <h4 className="font-jakarta font-bold text-white text-[11px] tracking-widest leading-tight uppercase truncate group-hover/game:text-white transition-colors">
                                    {g.name}
                                </h4>
                                <div className="flex items-center gap-2 mt-1">
                                    <span className="text-[8px] font-bold text-zinc-600 uppercase tracking-widest">{g.category}</span>
                                    {g.tags?.length > 0 && (
                                        <>
                                            <div className="w-1 h-1 rounded-full bg-zinc-800" />
                                            <span className="text-[8px] text-zinc-700 uppercase truncate">{g.tags[0]}</span>
                                        </>
                                    )}
                                </div>
                            </div>

                            <div className="flex items-center gap-2 flex-shrink-0">
                                <button 
                                    onClick={() => toggleFavorite(g.id)}
                                    className={`w-8 h-8 flex items-center justify-center border border-zinc-900 transition-all ${g.isFavorite ? 'text-red-500 bg-red-950/10' : 'text-zinc-700 hover:text-red-400'}`}
                                    title="Favorite"
                                >
                                    <Heart size={14} fill={g.isFavorite ? "currentColor" : "none"} /> 
                                </button>
                                <button 
                                    onClick={() => togglePinned(g.id)}
                                    className={`w-8 h-8 flex items-center justify-center border border-zinc-900 transition-all ${g.pinned ? 'text-blue-500 bg-blue-950/10' : 'text-zinc-700 hover:text-blue-400'}`}
                                    title="Pin to Top"
                                >
                                    <Pin size={14} /> 
                                </button>
                                <button 
                                    onClick={() => handleEdit(g)}
                                    className="w-8 h-8 flex items-center justify-center text-zinc-600 hover:text-white hover:bg-zinc-800 border border-zinc-900 transition-all"
                                    title="Configure"
                                >
                                    <Edit2 size={14} /> 
                                </button>
                                <button 
                                    onClick={() => deleteGame(g.id)}
                                    className="w-8 h-8 flex items-center justify-center text-zinc-800 hover:text-red-500 hover:bg-red-950/20 border border-zinc-900 hover:border-red-900/30 transition-all"
                                    title="Delete"
                                >
                                    <Trash2 size={14} />
                                </button>
                            </div>
                        </div>
                    </div>
                </Card>
            ))}
        </div>
    </div>
  )
}
