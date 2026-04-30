import React, { useState } from 'react'
import {
  X, Plus, Edit2, Trash2, Star, Pin, Upload, Save, Search,
  Gamepad2, Settings, Image, Layout, Key, Monitor, DollarSign,
  Share2, Briefcase, ExternalLink, Power, Megaphone, Bold, Italic,
  Underline, Type, Palette, AlignLeft, List, Network, ChevronRight
} from 'lucide-react'
import toast from 'react-hot-toast'
import useStore from '../store/useStore'

const CATEGORIES = [
  { id: 'online', label: 'Online' },
  { id: 'offline', label: 'Offline' },
  { id: 'apps', label: 'Application' },
]

export default function AdminPanel() {
  const { closeAdmin, adminSection, setAdminSection } = useStore()
  const accentColor = useStore(s => s.settings.accentColor) || '#ff6a00'

  const sections = [
    { id: 'games', label: 'Games', icon: Gamepad2 },
    { id: 'featured', label: 'Featured', icon: Star },
    { id: 'rates', label: 'Rates', icon: DollarSign },
    { id: 'social', label: 'Social', icon: Share2 },
    { id: 'office', label: 'Top Apps', icon: Briefcase },
    { id: 'pcgroups', label: 'PC Groups', icon: Network },
    { id: 'announcement', label: 'Announce', icon: Megaphone },
    { id: 'appearance', label: 'Appearance', icon: Layout },
    { id: 'settings', label: 'Settings', icon: Settings },
  ]

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ backgroundColor: 'rgba(0,0,0,0.92)' }} onMouseDown={e => e.stopPropagation()}>
      <div
        className="relative w-full max-w-5xl h-[85vh] overflow-hidden flex flex-col"
        style={{
          background: 'linear-gradient(180deg, rgba(18,18,22,0.98) 0%, rgba(10,10,14,0.99) 100%)',
          borderRadius: '16px',
          border: `1px solid ${accentColor}15`,
        }}
      >
        <div className="absolute top-0 left-0 right-0 h-[1px]" style={{ background: `linear-gradient(90deg, transparent 0%, ${accentColor} 50%, transparent 100%)`, opacity: 0.6 }} />
        <div className="absolute bottom-0 left-0 right-0 h-[1px]" style={{ background: `linear-gradient(90deg, transparent 0%, ${accentColor} 50%, transparent 100%)`, opacity: 0.15 }} />
        <div className="absolute top-0 left-0 w-[60px] h-[60px] pointer-events-none" style={{ borderTop: `2px solid ${accentColor}60`, borderLeft: `2px solid ${accentColor}60`, borderRadius: '16px 0 0 0' }} />
        <div className="absolute top-0 right-0 w-[60px] h-[60px] pointer-events-none" style={{ borderTop: `2px solid ${accentColor}60`, borderRight: `2px solid ${accentColor}60`, borderRadius: '0 16px 0 0' }} />

        <div className="flex items-center justify-between px-6 py-4 flex-shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: `linear-gradient(135deg, ${accentColor}20, ${accentColor}05)`, border: `1px solid ${accentColor}30` }}>
              <Settings size={18} style={{ color: accentColor }} />
            </div>
            <div>
              <h2 className="font-orbitron font-bold text-base tracking-[0.2em]" style={{ color: accentColor, textShadow: `0 0 20px ${accentColor}30` }}>ADMIN PANEL</h2>
              <p className="font-rajdhani text-white/35 text-[10px] uppercase tracking-[0.2em]">EXAMPLE CAFE Control Center</p>
            </div>
          </div>
          <button onClick={closeAdmin} className="p-2.5 rounded-lg transition-colors hover:bg-white/5 group">
            <X size={15} className="text-white/30 group-hover:text-white transition-colors" />
          </button>
        </div>

        <div className="h-[1px] mx-6" style={{ background: `linear-gradient(90deg, transparent, ${accentColor}15, transparent)` }} />

        <div className="flex flex-1 overflow-hidden">
          <div className="w-[160px] p-3 flex flex-col gap-0.5 flex-shrink-0 border-r" style={{ borderColor: `${accentColor}08` }}>
            {sections.map(s => (
              <button
                key={s.id}
                onClick={() => setAdminSection(s.id)}
                className="flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-sm font-rajdhani font-medium transition-all text-left"
                style={adminSection === s.id ? {
                  background: `linear-gradient(135deg, ${accentColor}15, ${accentColor}05)`,
                  color: accentColor,
                  border: `1px solid ${accentColor}25`,
                  fontWeight: 700,
                } : {
                  color: 'rgba(255,255,255,0.4)',
                  border: '1px solid transparent',
                }}
                onMouseEnter={e => { if (adminSection !== s.id) e.currentTarget.style.color = 'rgba(255,255,255,0.7)' }}
                onMouseLeave={e => { if (adminSection !== s.id) e.currentTarget.style.color = 'rgba(255,255,255,0.4)' }}
              >
                <s.icon size={13} />
                {s.label}
              </button>
            ))}
          </div>

          <div className="flex-1 overflow-y-auto p-6 scrollbar-thin">
            {adminSection === 'games' && <GamesSection />}
            {adminSection === 'featured' && <FeaturedSection />}
            {adminSection === 'rates' && <RatesSection />}
            {adminSection === 'social' && <SocialSection />}
            {adminSection === 'office' && <OfficeSection />}
            {adminSection === 'pcgroups' && <PCGroupsSection />}
            {adminSection === 'announcement' && <AnnouncementSection />}
            {adminSection === 'appearance' && <AppearanceSection />}
            {adminSection === 'settings' && <SettingsSection />}
          </div>
        </div>
      </div>
    </div>
  )
}

function SectionWrapper({ children }) {
  return <div className="space-y-4">{children}</div>
}

function SectionTitle({ icon: Icon, title, count }) {
  const accentColor = useStore(s => s.settings.accentColor) || '#ff6a00'
  return (
    <div className="flex items-center gap-2">
      {Icon && <Icon size={14} style={{ color: accentColor }} />}
      <h3 className="font-orbitron font-bold uppercase tracking-[0.15em] text-sm" style={{ color: accentColor }}>
        {title}
      </h3>
      {count !== undefined && <span className="font-rajdhani text-white/30 text-xs ml-1">({count})</span>}
    </div>
  )
}

function AccentButton({ children, onClick, type, disabled, className = '' }) {
  const accentColor = useStore(s => s.settings.accentColor) || '#ff6a00'
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`flex items-center gap-2 px-4 py-2 rounded-xl font-rajdhani font-bold text-sm transition-all active:scale-[0.97] disabled:opacity-40 ${className}`}
      style={{
        background: `linear-gradient(135deg, ${accentColor}, ${accentColor}cc)`,
        color: '#000',
        boxShadow: `0 2px 12px ${accentColor}20`,
      }}
    >
      {children}
    </button>
  )
}

function CardBox({ children, className = '', highlight }) {
  const accentColor = useStore(s => s.settings.accentColor) || '#ff6a00'
  return (
    <div
      className={`rounded-xl p-5 space-y-3 ${className}`}
      style={{
        background: highlight ? `${accentColor}06` : 'rgba(255,255,255,0.015)',
        border: `1px solid ${highlight ? accentColor + '20' : 'rgba(255,255,255,0.04)'}`,
      }}
    >
      {children}
    </div>
  )
}

const InputField = React.forwardRef(({ value, onChange, placeholder, className = '', ...props }, ref) => {
  return (
    <input
      ref={ref}
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      autoComplete="off"
      spellCheck={false}
      className={`w-full px-3 py-2.5 bg-black/30 border border-white/[0.06] rounded-lg text-white text-sm font-rajdhani focus:outline-none focus:border-white/15 transition-colors placeholder:text-white/15 ${className}`}
      onMouseDown={e => e.stopPropagation()}
      {...props}
    />
  )
})

function ToggleSwitch({ checked, onChange }) {
  const accentColor = useStore(s => s.settings.accentColor) || '#ff6a00'
  return (
    <button
      onClick={onChange}
      className="relative w-12 h-6 rounded-full transition-all flex-shrink-0"
      style={{
        background: checked ? accentColor : 'rgba(255,255,255,0.08)',
        boxShadow: checked ? `0 0 10px ${accentColor}30` : 'none',
        border: checked ? 'none' : '1px solid rgba(255,255,255,0.1)',
      }}
    >
      <div
        className="absolute top-1 w-4 h-4 rounded-full transition-all duration-200"
        style={{
          left: checked ? '26px' : '2px',
          background: checked ? '#000' : 'rgba(255,255,255,0.3)',
        }}
      />
    </button>
  )
}

function GamesSection() {
  const { games, addGame, updateGame, deleteGame, togglePinned } = useStore()
  const [showForm, setShowForm] = useState(false)
  const [editGame, setEditGame] = useState(null)
  const [filter, setFilter] = useState('')
  const [filterCat, setFilterCat] = useState('all')
  const [form, setForm] = useState({ name: '', category: 'online', icon: '', exePath: '', savePath: '', description: '', tags: '', pcGroups: [], variations: [] })
  const [igdbQuery, setIgdbQuery] = useState('')
  const [igdbResults, setIgdbResults] = useState([])
  const [igdbLoading, setIgdbLoading] = useState(false)
  const [igdbImporting, setIgdbImporting] = useState(null)
  const settings = useStore(s => s.settings)
  const accentColor = settings.accentColor || '#ff6a00'

  const resetForm = () => {
    setForm({ name: '', category: 'online', icon: '', exePath: '', savePath: '', description: '', tags: '', pcGroups: [], variations: [] })
    setEditGame(null)
    setShowForm(false)
    setIgdbResults([])
    setIgdbQuery('')
  }

  const handleEdit = (game) => {
    setForm({ ...game, tags: game.tags?.join(', ') || '', pcGroups: game.pcGroups || [], savePath: game.savePath || '', variations: game.variations || [] })
    setEditGame(game)
    setShowForm(true)
  }

  const handleIgdbSearch = async () => {
    if (!igdbQuery.trim()) return
    if (!settings.igdbClientId || !settings.igdbClientSecret) {
      return toast.error('IGDB credentials not configured. Go to Settings to add them.')
    }
    setIgdbLoading(true)
    try {
      const api = window.electronAPI
      if (api?.igdbSearch) {
        const data = await api.igdbSearch(igdbQuery, settings.igdbClientId, settings.igdbClientSecret)
        if (data.error) { toast.error(data.error); setIgdbResults([]) }
        else if (data.results?.length > 0) { setIgdbResults(data.results) }
        else { setIgdbResults([]); toast.error('No games found') }
      } else {
        const res = await fetch('/api/igdb/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: igdbQuery, clientId: settings.igdbClientId, clientSecret: settings.igdbClientSecret }),
        })
        const data = await res.json()
        if (data.error) { toast.error(data.error); setIgdbResults([]) }
        else if (data.results?.length > 0) { setIgdbResults(data.results) }
        else { setIgdbResults([]); toast.error('No games found') }
      }
    } catch { toast.error('IGDB search failed') }
    setIgdbLoading(false)
  }

  const handleIgdbSelect = async (result) => {
    setIgdbImporting(result.id)
    try {
      let icon = result.icon || ''
      const api = window.electronAPI
      if (api?.downloadImage && icon) {
        const dl = await api.downloadImage(icon, `igdb_${result.id}_${Date.now()}.jpg`)
        if (dl.success) icon = `file:///${dl.path}`
      }
      setForm({ name: result.name, category: result.category || 'online', icon, exePath: '', description: result.summary || '', tags: (result.genres || []).join(', '), pcGroups: [], variations: [] })
      setIgdbResults([])
      setIgdbQuery('')
      toast.success(`${result.name} loaded! Set the path to finish.`)
    } catch { toast.error('Failed to import game details') }
    setIgdbImporting(null)
  }

  const handleSubmit = (e) => {
    e.preventDefault()
    if (!form.name.trim()) return toast.error('Game name is required')
    if (!form.category.trim()) return toast.error('Category is required')
    const cleanedVariations = (form.variations || []).filter(v => v.name?.trim() && v.exePath?.trim()).map(v => ({ name: v.name.trim(), exePath: v.exePath.trim() }))
    const gameData = { ...form, tags: form.tags.split(',').map(t => t.trim()).filter(Boolean), variations: cleanedVariations }
    if (editGame) { updateGame(editGame.id, gameData); toast.success('Game updated!') }
    else { addGame(gameData); toast.success('Game added!') }
    resetForm()
  }

  const handleDelete = (game) => {
    if (window.confirm(`Delete "${game.name}"?`)) { deleteGame(game.id); toast.success('Game deleted') }
  }

  const handleImageSelect = async () => {
    if (window.electronAPI) { const path = await window.electronAPI.selectImage(); if (path) setForm(f => ({ ...f, icon: `file:///${path}` })) }
    else { const url = prompt('Enter image URL:'); if (url) setForm(f => ({ ...f, icon: url })) }
  }

  const handleExeSelect = async () => {
    if (window.electronAPI) { const path = await window.electronAPI.selectFile([{ name: 'All Files', extensions: ['*'] }]); if (path) setForm(f => ({ ...f, exePath: path })) }
    else { const path = prompt('Enter file path:'); if (path) setForm(f => ({ ...f, exePath: path })) }
  }

  const handleSavePathSelect = async () => {
    if (window.electronAPI?.selectFolder) { const fp = await window.electronAPI.selectFolder(); if (fp) setForm(f => ({ ...f, savePath: fp })) }
    else { const fp = prompt('Enter save data folder path:'); if (fp) setForm(f => ({ ...f, savePath: fp })) }
  }

  const COMMON_SAVE_PATHS = {
    'valorant': '%LOCALAPPDATA%\\VALORANT\\Saved', 'league of legends': '%LOCALAPPDATA%\\Riot Games\\League of Legends',
    'gta v': '%USERPROFILE%\\Documents\\Rockstar Games\\GTA V\\Profiles', 'grand theft auto v': '%USERPROFILE%\\Documents\\Rockstar Games\\GTA V\\Profiles',
    'minecraft': '%APPDATA%\\.minecraft\\saves', 'the sims 4': '%USERPROFILE%\\Documents\\Electronic Arts\\The Sims 4\\saves',
    'skyrim': '%USERPROFILE%\\Documents\\My Games\\Skyrim\\Saves', 'fallout 4': '%USERPROFILE%\\Documents\\My Games\\Fallout4\\Saves',
    'witcher 3': '%USERPROFILE%\\Documents\\The Witcher 3\\gamesaves', 'cyberpunk 2077': '%USERPROFILE%\\Saved Games\\CD Projekt Red\\Cyberpunk 2077',
    'elden ring': '%APPDATA%\\EldenRing', 'dark souls 3': '%APPDATA%\\DarkSoulsIII', 'dark souls iii': '%APPDATA%\\DarkSoulsIII',
    'resident evil 4': '%USERPROFILE%\\Documents\\My Games\\RE4',
    'nba 2k14': '%APPDATA%\\2K Sports\\NBA 2K14\\Saves', 'nba 2k23': '%APPDATA%\\2K Sports\\NBA 2K23\\Saves',
    'nba 2k24': '%APPDATA%\\2K Sports\\NBA 2K24\\Saves', 'nba 2k25': '%APPDATA%\\2K Sports\\NBA 2K25\\Saves',
    'fifa 23': '%USERPROFILE%\\Documents\\FIFA 23',
    'fortnite': '%LOCALAPPDATA%\\FortniteGame\\Saved', 'apex legends': '%USERPROFILE%\\Saved Games\\Respawn\\Apex',
    'counter-strike 2': 'C:\\Program Files (x86)\\Steam\\userdata', 'cs2': 'C:\\Program Files (x86)\\Steam\\userdata',
    'dota 2': 'C:\\Program Files (x86)\\Steam\\userdata', 'pubg': '%LOCALAPPDATA%\\TslGame\\Saved',
    'stardew valley': '%APPDATA%\\StardewValley\\Saves', 'terraria': '%USERPROFILE%\\Documents\\My Games\\Terraria\\Players',
    'roblox': '%LOCALAPPDATA%\\Roblox',
    'call of duty warzone': '%USERPROFILE%\\Documents\\Call of Duty Modern Warfare\\players',
    'warzone': '%USERPROFILE%\\Documents\\Call of Duty Modern Warfare\\players',
    'overwatch 2': '%USERPROFILE%\\Documents\\Overwatch',
    'genshin impact': '%USERPROFILE%\\AppData\\LocalLow\\miHoYo\\Genshin Impact',
    'honkai star rail': '%USERPROFILE%\\AppData\\LocalLow\\miHoYo\\Star Rail',
    'need for speed heat': '%USERPROFILE%\\Documents\\Need for Speed Heat\\SaveGame',
    'need for speed': '%USERPROFILE%\\Documents\\Need for Speed',
    'tekken 8': '%LOCALAPPDATA%\\TEKKEN 8\\Saved\\SaveGames', 'tekken 7': '%LOCALAPPDATA%\\TekkenGame\\Saved\\SaveGames',
    'mortal kombat 1': '%LOCALAPPDATA%\\MK12\\Saved\\SaveGames',
    'dragon ball fighterz': '%LOCALAPPDATA%\\DBFighterZ\\Saved\\SaveGames',
    'street fighter 6': '%LOCALAPPDATA%\\StreetFighter6\\Saved\\SaveGames',
    'left 4 dead 2': 'C:\\Program Files (x86)\\Steam\\userdata',
    'crossfire': '%LOCALAPPDATA%\\CrossFire', 'point blank': '%LOCALAPPDATA%\\PointBlank',
    'ragnarok online': '%USERPROFILE%\\Documents\\Ragnarok', 'mobile legends': '%LOCALAPPDATA%\\MobileLegends',
  }

  const getSuggestedSavePath = (gameName) => {
    if (!gameName) return null
    return COMMON_SAVE_PATHS[gameName.toLowerCase().trim()] || null
  }

  return (
    <SectionWrapper>
      <div className="flex items-center justify-between">
        <SectionTitle icon={Gamepad2} title="Manage Games" count={games.length} />
        <AccentButton onClick={() => setShowForm(!showForm)}>
          <Plus size={13} />ADD GAME
        </AccentButton>
      </div>

      {showForm && (
        <CardBox highlight>
          <h4 className="font-orbitron text-xs uppercase tracking-[0.15em]" style={{ color: `${accentColor}70` }}>{editGame ? 'Edit Game' : 'New Game'}</h4>

          {!editGame && (
            <div className="rounded-xl p-3 space-y-2" style={{ background: 'rgba(0,0,0,0.2)', border: `1px solid ${accentColor}10` }}>
              <label className="block text-[10px] mb-1 font-rajdhani uppercase tracking-wider flex items-center gap-1" style={{ color: `${accentColor}50` }}>
                <Search size={10} /> Search IGDB
              </label>
              <div className="flex gap-2">
                <InputField value={igdbQuery} onChange={e => setIgdbQuery(e.target.value)} onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), handleIgdbSearch())} placeholder="Type a game name..." className="flex-1" />
                <button type="button" onClick={handleIgdbSearch} disabled={igdbLoading} className="px-4 py-2 rounded-lg text-[11px] font-rajdhani font-bold transition-all disabled:opacity-40" style={{ background: `${accentColor}15`, border: `1px solid ${accentColor}20`, color: accentColor }}>
                  {igdbLoading ? '...' : 'SEARCH'}
                </button>
              </div>
              {igdbResults.length > 0 && (
                <div className="grid grid-cols-2 gap-2 max-h-[200px] overflow-y-auto pr-1">
                  {igdbResults.map(r => (
                    <button key={r.id} type="button" onClick={() => handleIgdbSelect(r)} disabled={igdbImporting === r.id}
                      className="flex items-center gap-2 p-2 rounded-lg border transition-all text-left disabled:opacity-50"
                      style={{ background: 'rgba(0,0,0,0.3)', borderColor: 'rgba(255,255,255,0.04)' }}
                      onMouseEnter={e => e.currentTarget.style.borderColor = `${accentColor}30`}
                      onMouseLeave={e => e.currentTarget.style.borderColor = 'rgba(255,255,255,0.04)'}
                    >
                      {r.icon ? <img src={r.icon} alt="" className="w-12 h-16 object-cover rounded flex-shrink-0" /> : <div className="w-12 h-16 bg-black/30 rounded flex-shrink-0 flex items-center justify-center"><Gamepad2 size={14} className="text-white/20" /></div>}
                      <div className="min-w-0">
                        <span className="text-white text-[11px] font-rajdhani leading-tight block truncate">{r.name}</span>
                        {r.genres?.length > 0 && <span className="text-white/20 text-[9px] font-rajdhani block truncate">{r.genres.slice(0, 3).join(', ')}</span>}
                      </div>
                      {igdbImporting === r.id && <span className="text-[9px] ml-auto" style={{ color: accentColor }}>...</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-white/40 mb-1.5 font-rajdhani uppercase tracking-wider">Game Name *</label>
                <InputField value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Valorant" />
              </div>
              <div>
                <label className="block text-xs text-white/40 mb-1.5 font-rajdhani uppercase tracking-wider">Category</label>
                <div className="flex gap-2">
                  <select value={CATEGORIES.find(c => c.id === form.category) ? form.category : '_custom'} onChange={e => { if (e.target.value === '_custom') setForm(f => ({ ...f, category: '' })); else setForm(f => ({ ...f, category: e.target.value })) }}
                    className="flex-1 px-3 py-2.5 bg-black/30 border border-white/[0.06] rounded-lg text-white text-sm font-rajdhani focus:outline-none">
                    {CATEGORIES.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
                    <option value="_custom">Custom...</option>
                  </select>
                  {!CATEGORIES.find(c => c.id === form.category) && (
                    <InputField value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') }))} placeholder="e.g. racing" className="flex-1" />
                  )}
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-white/40 mb-1.5 font-rajdhani uppercase tracking-wider">Icon / Image</label>
                <div className="flex gap-2">
                  <InputField value={form.icon} onChange={e => setForm(f => ({ ...f, icon: e.target.value }))} placeholder="URL or select file" className="flex-1 min-w-0 text-[11px]" />
                  <button type="button" onClick={handleImageSelect} className="px-2 py-2 border border-white/[0.06] rounded-lg hover:border-white/15 transition-all">
                    <Upload size={11} style={{ color: accentColor }} />
                  </button>
                </div>
              </div>
              <div>
                <label className="block text-xs text-white/40 mb-1.5 font-rajdhani uppercase tracking-wider">Path <span className="text-white/20">(.exe, file, shortcut)</span></label>
                <div className="flex gap-2">
                  <InputField value={form.exePath} onChange={e => setForm(f => ({ ...f, exePath: e.target.value }))} placeholder="C:\\Games\\game.exe or any file path" className="flex-1 min-w-0 text-[11px]" />
                  <button type="button" onClick={handleExeSelect} className="px-2 py-2 border border-white/[0.06] rounded-lg hover:border-white/15 transition-all">
                    <Upload size={11} style={{ color: accentColor }} />
                  </button>
                </div>
              </div>
            </div>

            <div>
              <label className="block text-xs text-white/40 mb-1.5 font-rajdhani uppercase tracking-wider">Variations <span className="text-white/20">(alternate launch options)</span></label>
              <div className="space-y-2">
                {(form.variations || []).map((v, i) => (
                  <div key={i} className="flex gap-2 items-center p-2 rounded-lg border border-white/[0.04] bg-white/[0.02]">
                    <span className="text-[9px] text-white/20 font-orbitron w-4 text-center flex-shrink-0">{i + 1}</span>
                    <InputField value={v.name} onChange={e => { const vars = [...form.variations]; vars[i] = { ...vars[i], name: e.target.value }; setForm(f => ({ ...f, variations: vars })) }} placeholder="Variation name (e.g. Play Normal)" className="flex-1 text-[11px]" />
                    <InputField value={v.exePath} onChange={e => { const vars = [...form.variations]; vars[i] = { ...vars[i], exePath: e.target.value }; setForm(f => ({ ...f, variations: vars })) }} placeholder="C:\\path\\to\\file" className="flex-1 text-[11px]" />
                    <button type="button" onClick={async () => { if (window.electronAPI) { const p = await window.electronAPI.selectFile([{ name: 'All Files', extensions: ['*'] }]); if (p) { const vars = [...form.variations]; vars[i] = { ...vars[i], exePath: p }; setForm(f => ({ ...f, variations: vars })) } } }} className="px-2 py-2 border border-white/[0.06] rounded-lg hover:border-white/15 transition-all flex-shrink-0" title="Browse file"><Upload size={11} style={{ color: accentColor }} /></button>
                    <button type="button" onClick={() => setForm(f => ({ ...f, variations: f.variations.filter((_, j) => j !== i) }))} className="px-2 py-2 border border-red-500/10 rounded-lg text-red-400/50 hover:text-red-400 hover:bg-red-500/5 transition-all flex-shrink-0" title="Remove"><Trash2 size={11} /></button>
                  </div>
                ))}
                <button type="button" onClick={() => { setForm(f => ({ ...f, variations: [...(f.variations || []), { name: '', exePath: '' }] })); setTimeout(() => { const el = document.querySelector('[data-variations-end]'); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' }) }, 50) }}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-[11px] font-rajdhani font-bold transition-all uppercase tracking-wider hover:scale-[1.02]"
                  style={{ background: `${accentColor}12`, border: `1px dashed ${accentColor}30`, color: accentColor }}
                ><Plus size={12} />Add Variation</button>
                <div data-variations-end="" />
                {(form.variations || []).length > 0 && (form.variations || []).some(v => !v.name?.trim() || !v.exePath?.trim()) && (
                  <p className="text-[9px] text-yellow-500/60 font-rajdhani">Variations with empty name or path will be removed on save.</p>
                )}
              </div>
            </div>

            <div>
              <label className="block text-xs text-white/40 mb-1.5 font-rajdhani uppercase tracking-wider">Save Data Path <span className="text-white/20">(for Save & Load)</span></label>
              <div className="flex gap-2">
                <InputField value={form.savePath} onChange={e => setForm(f => ({ ...f, savePath: e.target.value }))} placeholder="C:\\Users\\Public\\GameSaves\\MyGame" className="flex-1 min-w-0 text-[11px]" />
                <button type="button" onClick={handleSavePathSelect} className="px-2 py-2 border border-white/[0.06] rounded-lg hover:border-white/15 transition-all" title="Browse folder">
                  <Upload size={11} style={{ color: accentColor }} />
                </button>
              </div>
              {!form.savePath && getSuggestedSavePath(form.name) && (
                <button type="button" onClick={() => setForm(f => ({ ...f, savePath: getSuggestedSavePath(f.name) }))}
                  className="mt-1.5 flex items-center gap-1.5 px-2 py-1.5 rounded-lg transition-all text-left w-full"
                  style={{ background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.15)' }}
                >
                  <span className="text-emerald-400 text-[9px] font-orbitron uppercase tracking-wider font-bold flex-shrink-0">Suggested:</span>
                  <span className="text-emerald-400/70 text-[10px] font-rajdhani truncate">{getSuggestedSavePath(form.name)}</span>
                </button>
              )}
            </div>

            <div>
              <label className="block text-xs text-white/40 mb-1.5 font-rajdhani uppercase tracking-wider">Tags (comma-separated)</label>
              <InputField value={form.tags} onChange={e => setForm(f => ({ ...f, tags: e.target.value }))} placeholder="fps, action, multiplayer" />
            </div>

            {settings.pcGroups?.length > 0 && (
              <div>
                <label className="block text-xs text-white/40 mb-1.5 font-rajdhani uppercase tracking-wider">PC Groups <span className="text-white/20">(empty = show on all PCs)</span></label>
                <div className="flex flex-wrap gap-2">
                  {settings.pcGroups.map(group => {
                    const isSelected = (form.pcGroups || []).includes(group.id)
                    return (
                      <button key={group.id} type="button" onClick={() => { setForm(f => ({ ...f, pcGroups: isSelected ? f.pcGroups.filter(id => id !== group.id) : [...(f.pcGroups || []), group.id] })) }}
                        className="px-3 py-1.5 rounded-lg text-[11px] font-rajdhani font-bold transition-all"
                        style={isSelected ? { background: `${accentColor}15`, border: `1px solid ${accentColor}40`, color: accentColor } : { background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.35)' }}
                      >
                        <Network size={10} className="inline mr-1" />{group.name}
                        <span className="ml-1 text-[9px] opacity-60">({group.ips?.length || 0} IPs)</span>
                      </button>
                    )
                  })}
                </div>
              </div>
            )}

            <div className="flex gap-2 pt-1">
              <AccentButton type="submit"><Save size={11} />{editGame ? 'SAVE' : 'ADD'}</AccentButton>
              <button type="button" onClick={resetForm} className="px-4 py-2 border border-white/[0.06] rounded-lg text-white/30 hover:text-white font-rajdhani text-sm transition-all">CANCEL</button>
            </div>
          </form>
        </CardBox>
      )}

      <div className="flex items-center gap-2 mb-2">
        <div className="relative flex-1">
          <Search size={12} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/20" />
          <InputField value={filter} onChange={e => setFilter(e.target.value)} placeholder="Filter games..." className="pl-8 text-xs" />
        </div>
        <select value={filterCat} onChange={e => setFilterCat(e.target.value)} className="px-3 py-2.5 bg-black/30 border border-white/[0.06] rounded-lg text-white/50 text-xs font-rajdhani focus:outline-none">
          <option value="all">All Categories</option>
          {[...new Set(games.map(g => g.category).filter(Boolean))].map(c => (
            <option key={c} value={c}>{c.charAt(0).toUpperCase() + c.slice(1)}</option>
          ))}
        </select>
      </div>

      <div className="space-y-1.5">
        {games
          .filter(g => filterCat === 'all' || g.category === filterCat)
          .filter(g => !filter || g.name.toLowerCase().includes(filter.toLowerCase()))
          .map(game => (
          <div key={game.id} className="flex items-center gap-3 p-3 rounded-xl border transition-all"
            style={{ background: 'rgba(255,255,255,0.015)', borderColor: 'rgba(255,255,255,0.04)' }}
            onMouseEnter={e => e.currentTarget.style.borderColor = `${accentColor}20`}
            onMouseLeave={e => e.currentTarget.style.borderColor = 'rgba(255,255,255,0.04)'}
          >
            <div className="w-10 h-10 rounded-lg overflow-hidden flex-shrink-0 border border-white/[0.06]">
              {game.icon ? <img src={game.icon} alt={game.name} className="w-full h-full object-cover" /> : (
                <div className="w-full h-full flex items-center justify-center" style={{ background: `${accentColor}10` }}>
                  <span className="font-bold text-sm" style={{ color: accentColor }}>{game.name[0]}</span>
                </div>
              )}
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-rajdhani font-semibold text-white/80 text-sm truncate">{game.name}</p>
              <p className="font-rajdhani text-white/30 text-[10px] uppercase tracking-wider">
                {game.category} &middot; {game.launchCount || 0} launches
                {game.variations?.length > 0 && <span className="ml-1" style={{ color: `${accentColor}50` }}>&middot; {game.variations.length} var</span>}
                {game.pcGroups?.length > 0 && <span className="ml-1" style={{ color: `${accentColor}50` }}>&middot; {game.pcGroups.map(gid => settings.pcGroups?.find(g => g.id === gid)?.name || gid).join(', ')}</span>}
              </p>
            </div>
            <div className="flex items-center gap-0.5">
              <button onClick={() => togglePinned(game.id)} title="Pin" className="w-7 h-7 flex items-center justify-center rounded-md transition-all" style={{ color: game.pinned ? accentColor : 'rgba(255,255,255,0.15)' }}>
                <Pin size={12} fill={game.pinned ? 'currentColor' : 'none'} />
              </button>
              <button onClick={() => handleEdit(game)} className="w-7 h-7 flex items-center justify-center text-white/15 hover:text-white/60 transition-all"><Edit2 size={12} /></button>
              <button onClick={() => handleDelete(game)} className="w-7 h-7 flex items-center justify-center text-white/15 hover:text-red-400 transition-all"><Trash2 size={12} /></button>
            </div>
          </div>
        ))}
      </div>
    </SectionWrapper>
  )
}

function FeaturedSection() {
  const { games, setTopPick } = useStore()
  const accentColor = useStore(s => s.settings.accentColor) || '#ff6a00'
  const rankLabels = ['1ST', '2ND', '3RD']
  const topPicks = [1, 2, 3].map(rank => games.find(g => g.topPickRank === rank) || null)
  const availableGames = games.filter(g => !g.topPickRank)

  return (
    <SectionWrapper>
      <SectionTitle icon={Star} title="Top 3 Picks" count={`${topPicks.filter(Boolean).length}/3 assigned`} />
      <p className="font-rajdhani text-white/40 text-sm">Manually assign which games appear as Top Pick 1st, 2nd, and 3rd in the sidebar.</p>

      <div className="space-y-2">
        {[1, 2, 3].map((rank, i) => {
          const game = topPicks[i]
          return (
            <CardBox key={rank} highlight={!!game}>
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 border" style={{ borderColor: game ? accentColor : 'rgba(255,255,255,0.06)', background: game ? `${accentColor}15` : 'rgba(0,0,0,0.3)' }}>
                  <span className="font-orbitron text-[10px] font-bold" style={{ color: game ? accentColor : 'rgba(255,255,255,0.2)' }}>{rankLabels[i]}</span>
                </div>
                {game ? (
                  <div className="flex items-center gap-2 flex-1 min-w-0">
                    <div className="w-8 h-8 rounded-lg overflow-hidden border border-white/[0.06] flex-shrink-0">
                      {game.icon ? <img src={game.icon} alt={game.name} className="w-full h-full object-cover" /> : <div className="w-full h-full flex items-center justify-center" style={{ background: `${accentColor}15` }}><span className="text-xs" style={{ color: accentColor }}>{game.name[0]}</span></div>}
                    </div>
                    <span className="font-rajdhani text-white/70 text-sm font-medium truncate flex-1">{game.name}</span>
                    <button onClick={() => setTopPick(game.id, null)} className="px-3 py-1 text-[10px] font-rajdhani text-red-400/70 hover:bg-red-500/10 rounded-lg border border-red-500/10 transition-all uppercase tracking-wider flex-shrink-0">Remove</button>
                  </div>
                ) : (
                  <span className="font-rajdhani text-white/20 text-sm italic">Empty — assign a game below</span>
                )}
              </div>
            </CardBox>
          )
        })}
      </div>

      {availableGames.length > 0 && (
        <div>
          <h4 className="font-orbitron text-[10px] text-white/20 uppercase tracking-[0.15em] mb-2">Assign to Top Pick</h4>
          <div className="grid grid-cols-3 gap-2">
            {availableGames.map(game => (
              <CardBox key={game.id}>
                <div className="flex items-center gap-2 mb-2">
                  <div className="w-8 h-8 rounded-lg overflow-hidden border border-white/[0.06] flex-shrink-0">
                    {game.icon ? <img src={game.icon} alt={game.name} className="w-full h-full object-cover" /> : <div className="w-full h-full bg-black/30 flex items-center justify-center"><span className="text-white/30 text-xs">{game.name[0]}</span></div>}
                  </div>
                  <span className="font-rajdhani text-white/40 text-sm truncate flex-1">{game.name}</span>
                </div>
                <div className="flex gap-1">
                  {[1, 2, 3].map(rank => (
                    <button key={rank} onClick={() => setTopPick(game.id, rank)} disabled={!!topPicks[rank - 1]} className="flex-1 py-1.5 text-[10px] font-orbitron font-bold rounded-lg border transition-all uppercase disabled:opacity-20 disabled:cursor-not-allowed" style={{ color: topPicks[rank - 1] ? 'rgba(255,255,255,0.2)' : accentColor, borderColor: topPicks[rank - 1] ? 'rgba(255,255,255,0.05)' : `${accentColor}25` }}>{rankLabels[rank - 1]}</button>
                  ))}
                </div>
              </CardBox>
            ))}
          </div>
        </div>
      )}
    </SectionWrapper>
  )
}

function PCGroupsSection() {
  const { settings, updateSettings, games, updateGame, localIPs, localHostname } = useStore()
  const accentColor = settings.accentColor || '#ff6a00'
  const pcGroups = settings.pcGroups || []
  const [showForm, setShowForm] = useState(false)
  const [editGroup, setEditGroup] = useState(null)
  const [groupName, setGroupName] = useState('')
  const [ipInput, setIpInput] = useState('')
  const [groupIPs, setGroupIPs] = useState([])

  const resetForm = () => { setGroupName(''); setIpInput(''); setGroupIPs([]); setEditGroup(null); setShowForm(false) }
  const isValidIP = (ip) => { const parts = ip.split('.'); if (parts.length !== 4) return false; return parts.every(p => { const n = Number(p); return !isNaN(n) && n >= 0 && n <= 255 && String(n) === p }) }
  const handleAddIP = () => { const ip = ipInput.trim(); if (!ip) return; if (!isValidIP(ip)) return toast.error('Invalid IP format'); if (groupIPs.includes(ip)) return toast.error('IP already added'); setGroupIPs([...groupIPs, ip]); setIpInput('') }
  const handleRemoveIP = (ip) => setGroupIPs(groupIPs.filter(i => i !== ip))

  const handleSave = () => {
    if (!groupName.trim()) return toast.error('Group name is required')
    if (groupIPs.length === 0) return toast.error('Add at least one IP address')
    if (editGroup) { updateSettings({ pcGroups: pcGroups.map(g => g.id === editGroup.id ? { ...g, name: groupName.trim(), ips: groupIPs } : g) }); toast.success('PC Group updated!') }
    else { updateSettings({ pcGroups: [...pcGroups, { id: Date.now().toString(), name: groupName.trim(), ips: groupIPs }] }); toast.success('PC Group created!') }
    resetForm()
  }

  const handleEdit = (group) => { setGroupName(group.name); setGroupIPs([...group.ips]); setEditGroup(group); setShowForm(true) }
  const handleDelete = (group) => {
    if (!window.confirm(`Delete group "${group.name}"?`)) return
    updateSettings({ pcGroups: pcGroups.filter(g => g.id !== group.id) })
    games.forEach(game => { if (game.pcGroups?.includes(group.id)) updateGame(game.id, { pcGroups: game.pcGroups.filter(id => id !== group.id) }) })
    toast.success('PC Group deleted')
  }

  const currentIP = localIPs.length > 0 ? localIPs[0] : null

  return (
    <SectionWrapper>
      <div className="flex items-center justify-between">
        <SectionTitle icon={Network} title="PC Groups" count={pcGroups.length} />
        <AccentButton onClick={() => { resetForm(); setShowForm(!showForm) }}><Plus size={13} />ADD GROUP</AccentButton>
      </div>
      <p className="font-rajdhani text-white/40 text-sm">Create PC groups and assign IP addresses. PCs in a group ONLY see games assigned to that group.</p>

      {currentIP && (
        <div className="flex items-center gap-2 px-3 py-2.5 rounded-xl" style={{ background: `${accentColor}08`, border: `1px solid ${accentColor}15` }}>
          <Monitor size={13} style={{ color: accentColor }} />
          <span className="font-rajdhani text-sm text-white/60">This PC: <span className="font-bold" style={{ color: accentColor }}>{localIPs.join(', ')}</span>
            {localHostname && <span className="text-white/30 ml-2">({localHostname})</span>}
          </span>
        </div>
      )}

      {!currentIP && (
        <div className="flex items-center gap-2 px-3 py-2.5 rounded-xl" style={{ background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(255,255,255,0.04)' }}>
          <Monitor size={13} className="text-white/20" />
          <span className="font-rajdhani text-sm text-white/30">IP detection available in Electron (built app) only</span>
        </div>
      )}

      {showForm && (
        <CardBox highlight>
          <h4 className="font-orbitron text-xs uppercase tracking-[0.15em]" style={{ color: `${accentColor}70` }}>{editGroup ? 'Edit Group' : 'New PC Group'}</h4>
          <div>
            <label className="block text-xs text-white/40 mb-1.5 font-rajdhani uppercase tracking-wider">Group Name</label>
            <InputField value={groupName} onChange={e => setGroupName(e.target.value)} placeholder="e.g. Low Spec, High Spec, VIP PCs" />
          </div>
          <div>
            <label className="block text-xs text-white/40 mb-1.5 font-rajdhani uppercase tracking-wider">IP Addresses ({groupIPs.length})</label>
            <div className="flex gap-2 mb-2">
              <InputField value={ipInput} onChange={e => setIpInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleAddIP() } }} placeholder="e.g. 192.168.1.101" className="flex-1" />
              <button type="button" onClick={handleAddIP} className="px-4 py-2 rounded-lg text-[11px] font-rajdhani font-bold transition-all" style={{ background: `${accentColor}15`, border: `1px solid ${accentColor}20`, color: accentColor }}>ADD IP</button>
              {currentIP && !groupIPs.includes(currentIP) && (
                <button type="button" onClick={() => { setGroupIPs([...groupIPs, currentIP]); toast.success('Added this PC\'s IP') }} className="px-3 py-2 border border-white/[0.06] rounded-lg text-white/30 text-[10px] font-rajdhani hover:text-white/60 transition-all">+ THIS PC</button>
              )}
            </div>
            {groupIPs.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {groupIPs.map(ip => (
                  <div key={ip} className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg" style={{ background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.06)' }}>
                    <span className="text-white/60 text-[11px] font-rajdhani font-mono">{ip}</span>
                    <button onClick={() => handleRemoveIP(ip)} className="text-white/20 hover:text-red-400 transition-all"><X size={10} /></button>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="flex gap-2 pt-1">
            <AccentButton onClick={handleSave}><Save size={11} />{editGroup ? 'SAVE' : 'CREATE'}</AccentButton>
            <button type="button" onClick={resetForm} className="px-4 py-2 border border-white/[0.06] rounded-lg text-white/30 hover:text-white font-rajdhani text-sm transition-all">CANCEL</button>
          </div>
        </CardBox>
      )}

      <div className="space-y-2">
        {pcGroups.map(group => {
          const assignedGames = games.filter(g => g.pcGroups?.includes(group.id))
          const isCurrentPC = localIPs.some(ip => group.ips.includes(ip))
          return (
            <CardBox key={group.id} highlight={isCurrentPC}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Network size={14} style={{ color: isCurrentPC ? accentColor : 'rgba(255,255,255,0.3)' }} />
                  <span className="font-orbitron text-sm font-bold text-white/80">{group.name}</span>
                  {isCurrentPC && <span className="px-2 py-0.5 rounded text-[8px] font-orbitron font-bold uppercase tracking-wider" style={{ background: `${accentColor}20`, border: `1px solid ${accentColor}30`, color: accentColor }}>This PC</span>}
                  <span className="text-white/25 text-[10px] font-rajdhani">{assignedGames.length} games</span>
                </div>
                <div className="flex items-center gap-1">
                  <button onClick={() => handleEdit(group)} className="w-7 h-7 flex items-center justify-center text-white/15 hover:text-white/60 transition-all"><Edit2 size={12} /></button>
                  <button onClick={() => handleDelete(group)} className="w-7 h-7 flex items-center justify-center text-white/15 hover:text-red-400 transition-all"><Trash2 size={12} /></button>
                </div>
              </div>
              <div className="flex flex-wrap gap-1">
                {group.ips.map(ip => (
                  <span key={ip} className="px-2 py-0.5 rounded text-[10px] font-rajdhani font-mono" style={localIPs.includes(ip) ? { background: `${accentColor}12`, color: accentColor, border: `1px solid ${accentColor}25` } : { background: 'rgba(0,0,0,0.3)', color: 'rgba(255,255,255,0.4)', border: '1px solid rgba(255,255,255,0.04)' }}>{ip}</span>
                ))}
              </div>
              {assignedGames.length > 0 && (
                <div className="pt-2 border-t border-white/[0.04]">
                  <span className="text-[9px] font-rajdhani text-white/25 uppercase tracking-wider">Assigned: </span>
                  <span className="text-[10px] font-rajdhani text-white/40">{assignedGames.map(g => g.name).join(', ')}</span>
                </div>
              )}
            </CardBox>
          )
        })}
      </div>
    </SectionWrapper>
  )
}

function InlinePrompt({ label, placeholder, onSubmit, onCancel }) {
  const [val, setVal] = useState('')
  const inputRef = React.useRef(null)
  const accentColor = useStore(s => s.settings.accentColor) || '#ff6a00'
  React.useEffect(() => { inputRef.current?.focus() }, [])
  const handleSubmit = () => { if (val.trim()) onSubmit(val.trim()) }
  return (
    <div className="absolute left-0 right-0 top-full mt-1 z-50 rounded-xl p-3 shadow-2xl shadow-black/50" style={{ background: 'rgb(18,18,22)', border: `1px solid ${accentColor}30` }}>
      <label className="text-[9px] font-orbitron uppercase tracking-wider block mb-1.5" style={{ color: `${accentColor}60` }}>{label}</label>
      <div className="flex gap-2">
        <InputField ref={inputRef} value={val} onChange={e => setVal(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') handleSubmit(); if (e.key === 'Escape') onCancel() }} placeholder={placeholder} className="flex-1" />
        <AccentButton onClick={handleSubmit}>OK</AccentButton>
        <button onClick={onCancel} className="px-3 py-2 border border-white/[0.06] rounded-lg text-white/30 text-[11px] font-rajdhani">Cancel</button>
      </div>
    </div>
  )
}

function AnnouncementSection() {
  const { settings, updateSettings } = useStore()
  const accentColor = settings.accentColor || '#ff6a00'
  const [text, setText] = useState(settings.announcement || '')
  const textRef = React.useRef(null)
  const [inlinePrompt, setInlinePrompt] = useState(null)
  const cursorRef = React.useRef({ start: 0, end: 0, selected: '' })

  const saveCursor = () => { const ta = textRef.current; if (!ta) return; cursorRef.current = { start: ta.selectionStart, end: ta.selectionEnd, selected: text.substring(ta.selectionStart, ta.selectionEnd) } }
  const applyInsert = (insertion) => { const { start, end } = cursorRef.current; const newText = text.substring(0, start) + insertion + text.substring(end); setText(newText); const ta = textRef.current; setTimeout(() => { if (ta) { ta.focus(); const newPos = start + insertion.length; ta.setSelectionRange(newPos, newPos) } }, 0) }
  const showPrompt = (label, placeholder, callback) => { saveCursor(); setInlinePrompt({ label, placeholder, callback }) }
  const handlePromptSubmit = async (val) => { const cb = inlinePrompt?.callback; setInlinePrompt(null); if (cb) await cb(val) }

  const insertBBCode = async (tag, value) => {
    const ta = textRef.current; if (!ta) return; const { selected } = cursorRef.current
    if (tag === 'color' && !value) { saveCursor(); showPrompt('Color', '#ff6a00 or red', (color) => { applyInsert(`[color=${color}]${cursorRef.current.selected || 'text'}[/color]`) }); return }
    if (tag === 'color' && value) { saveCursor(); applyInsert(`[color=${value}]${cursorRef.current.selected || 'text'}[/color]`); return }
    if (tag === 'size' && !value) { saveCursor(); showPrompt('Font Size', '10, 12, 14, 16, 20, 24', (size) => { applyInsert(`[size=${size}]${cursorRef.current.selected || 'text'}[/size]`) }); return }
    if (tag === 'size' && value) { saveCursor(); applyInsert(`[size=${value}]${cursorRef.current.selected || 'text'}[/size]`); return }
    if (tag === 'url') { saveCursor(); showPrompt('URL', 'https://example.com', (url) => { applyInsert(`[url=${url}]${cursorRef.current.selected || 'link text'}[/url]`) }); return }
    if (tag === 'img') { saveCursor(); showPrompt('Image URL', 'https://i.imgur.com/example.png', async (url) => { const api = window.electronAPI; if (api?.downloadImage) { const ext = url.split('.').pop()?.split('?')[0] || 'png'; try { const dl = await api.downloadImage(url, `announce_img_${Date.now()}.${ext}`); if (dl.success) { applyInsert(`[img]file:///${dl.path}[/img]`); return } } catch {} } applyInsert(`[img]${url}[/img]`) }); return }
    saveCursor()
    let insertion
    if (tag === 'list') insertion = `[list]\n[*] Item 1\n[*] Item 2\n[/list]`
    else if (tag === 'hr') insertion = `[hr]`
    else if (tag === 'quote') insertion = `[quote]${cursorRef.current.selected || 'quoted text'}[/quote]`
    else insertion = `[${tag}]${cursorRef.current.selected || 'text'}[/${tag}]`
    applyInsert(insertion)
  }

  const handleSave = () => { updateSettings({ announcement: text }); toast.success('Announcement updated!') }
  const handleClear = () => { setText(''); updateSettings({ announcement: '' }); toast.success('Announcement cleared!') }

  const bbTools = [
    { icon: Bold, tag: 'b', title: 'Bold' }, { icon: Italic, tag: 'i', title: 'Italic' }, { icon: Underline, tag: 'u', title: 'Underline' },
    { label: 'S', tag: 's', title: 'Strikethrough', className: 'line-through' }, { icon: Type, tag: 'size', title: 'Font Size' },
    { icon: Palette, tag: 'color', title: 'Color' }, { icon: AlignLeft, tag: 'center', title: 'Center' },
    { icon: ExternalLink, tag: 'url', title: 'Link' }, { icon: Image, tag: 'img', title: 'Image' },
    { icon: List, tag: 'list', title: 'List' }, { label: '❝', tag: 'quote', title: 'Quote' }, { label: '—', tag: 'hr', title: 'Horizontal Rule' },
  ]

  return (
    <SectionWrapper>
      <SectionTitle icon={Megaphone} title="Announcement" />
      <p className="text-white/25 text-xs font-rajdhani mb-4">Displayed in the sidebar. Supports BBCode formatting.</p>

      <CardBox>
        <div className="px-3 py-2 border-b border-white/[0.04] space-y-1.5 relative">
          <div className="flex items-center gap-0.5 flex-wrap">
            {bbTools.map(tool => (
              <button key={tool.tag} onClick={() => insertBBCode(tool.tag)} title={tool.title}
                className={`w-7 h-7 flex items-center justify-center rounded-md text-white/25 hover:text-white/60 transition-all ${tool.className || ''}`}
                onMouseEnter={e => e.currentTarget.style.color = accentColor}
                onMouseLeave={e => e.currentTarget.style.color = 'rgba(255,255,255,0.25)'}
              >
                {tool.icon ? <tool.icon size={13} /> : <span className="text-xs font-bold">{tool.label}</span>}
              </button>
            ))}
            <div className="w-px h-5 bg-white/[0.06] mx-1" />
            <div className="flex gap-1">
              {[{ color: '#ff6a00', name: 'Orange' }, { color: '#10b981', name: 'Green' }, { color: '#3b82f6', name: 'Blue' }, { color: '#ef4444', name: 'Red' }, { color: '#eab308', name: 'Yellow' }, { color: '#a855f7', name: 'Purple' }, { color: '#ffffff', name: 'White' }].map(c => (
                <button key={c.color} onClick={() => insertBBCode('color', c.color)} className="w-5 h-5 rounded-full border border-white/10 hover:scale-125 transition-transform" style={{ background: c.color }} title={c.name} />
              ))}
            </div>
          </div>
          <div className="flex items-center gap-1">
            <span className="text-[9px] text-white/15 font-rajdhani uppercase tracking-wider mr-1">Size:</span>
            {[{ label: 'S', size: '10' }, { label: 'M', size: '12' }, { label: 'L', size: '14' }, { label: 'XL', size: '18' }, { label: 'XXL', size: '24' }].map(s => (
              <button key={s.size} onClick={() => insertBBCode('size', s.size)} className="px-2 py-0.5 rounded-md border text-[9px] font-rajdhani text-white/25 hover:text-white/50 transition-all" style={{ background: 'rgba(0,0,0,0.2)', borderColor: 'rgba(255,255,255,0.04)' }} title={`Size ${s.size}px`}>{s.label}</button>
            ))}
          </div>
          {inlinePrompt && <InlinePrompt label={inlinePrompt.label} placeholder={inlinePrompt.placeholder} onSubmit={handlePromptSubmit} onCancel={() => setInlinePrompt(null)} />}
        </div>
        <textarea ref={textRef} value={text} onChange={(e) => setText(e.target.value)} placeholder="Type your announcement here..." className="w-full h-48 bg-transparent text-white/70 font-rajdhani text-sm p-4 outline-none resize-none placeholder:text-white/10" />
      </CardBox>

      <CardBox>
        <span className="text-[8px] font-orbitron uppercase tracking-wider block mb-2" style={{ color: `${accentColor}40` }}>Preview</span>
        <div className="text-[10px] font-rajdhani text-white/50 leading-relaxed break-words">
          <BBCodeRenderer text={text || 'No announcement set'} />
        </div>
      </CardBox>

      <div className="flex gap-2 mt-4">
        <AccentButton onClick={handleSave}><Save size={13} />Save Announcement</AccentButton>
        {text && <button onClick={handleClear} className="px-4 py-2.5 border border-red-500/10 rounded-lg text-red-400/70 text-sm font-rajdhani hover:bg-red-500/5 transition-all">Clear</button>}
      </div>

      <AnnouncementImagesManager />
    </SectionWrapper>
  )
}

function AnnouncementImagesManager() {
  const { settings, updateSettings } = useStore()
  const accentColor = settings.accentColor || '#ff6a00'
  const images = settings.announcementImages || []
  const [interval, setInterval_] = useState(settings.announcementSlideInterval || 5)
  const [newUrl, setNewUrl] = useState('')

  const save = (updated) => updateSettings({ announcementImages: updated })
  const handleAdd = async () => { const url = newUrl.trim(); if (!url) return toast.error('Image URL or path is required'); const api = window.electronAPI; if (api?.downloadImage) { const ext = url.split('.').pop()?.split('?')[0] || 'png'; try { const dl = await api.downloadImage(url, `announce_${Date.now()}.${ext}`); if (dl.success) { save([...images, `file:///${dl.path}`]); setNewUrl(''); return toast.success('Image downloaded & added!') } } catch {} } save([...images, url]); setNewUrl(''); toast.success('Image added!') }
  const handleBrowse = async () => { if (window.electronAPI?.selectImage) { const path = await window.electronAPI.selectImage(); if (path) { save([...images, `file:///${path}`]); toast.success('Image added!') } } else { const url = prompt('Enter image URL:'); if (url) { save([...images, url]); toast.success('Image added!') } } }
  const handleRemove = async (index) => { const img = images[index]; if (img.startsWith('file:///') && window.electronAPI?.deleteAsset) { try { await window.electronAPI.deleteAsset(img.replace('file:///', '')) } catch {} } save(images.filter((_, i) => i !== index)); toast.success('Image removed') }
  const handleIntervalChange = (val) => { const num = Math.max(1, Math.min(60, Number(val) || 5)); setInterval_(num); updateSettings({ announcementSlideInterval: num }) }

  return (
    <CardBox className="mt-4">
      <h4 className="font-orbitron text-xs uppercase tracking-[0.15em]" style={{ color: `${accentColor}60` }}>Image Slideshow</h4>
      <p className="font-rajdhani text-white/35 text-xs">Add images that rotate as a slideshow below the announcement text.</p>
      {images.length > 0 && (
        <div className="space-y-2">
          {images.map((img, i) => (
            <div key={i} className="flex items-center gap-3 p-2 rounded-lg" style={{ background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(255,255,255,0.04)' }}>
              <div className="w-16 h-10 rounded overflow-hidden border border-white/[0.06] flex-shrink-0 bg-black/30"><img src={img} alt={`Slide ${i + 1}`} className="w-full h-full object-cover" /></div>
              <span className="flex-1 text-white/35 text-[11px] font-rajdhani truncate">{img}</span>
              <button onClick={() => handleRemove(i)} className="w-7 h-7 flex items-center justify-center text-white/15 hover:text-red-400 transition-all rounded-md"><Trash2 size={12} /></button>
            </div>
          ))}
        </div>
      )}
      <div className="flex gap-2">
        <InputField value={newUrl} onChange={e => setNewUrl(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleAdd()} placeholder="https://... or file path" className="flex-1" />
        <button onClick={handleAdd} className="px-3 py-2 rounded-lg text-[11px] font-rajdhani font-bold transition-all" style={{ background: `${accentColor}15`, border: `1px solid ${accentColor}20`, color: accentColor }}>ADD</button>
        <button onClick={handleBrowse} className="px-2 py-2 border border-white/[0.06] rounded-lg hover:border-white/15 transition-all"><Upload size={11} style={{ color: accentColor }} /></button>
      </div>
      <div className="flex items-center gap-3 pt-1">
        <label className="text-xs text-white/40 font-rajdhani uppercase tracking-wider">Slide Duration:</label>
        <InputField type="number" value={interval} onChange={e => handleIntervalChange(e.target.value)} min={1} max={60} className="w-20 text-center font-orbitron" />
        <span className="text-xs text-white/25 font-rajdhani">seconds per slide</span>
      </div>
    </CardBox>
  )
}

function escAttr(s) { return s.replace(/"/g, '&quot;').replace(/'/g, '&#39;') }
function safeUrl(u) { try { const p = new URL(u); return ['http:', 'https:', 'file:'].includes(p.protocol) ? escAttr(u) : '' } catch { return '' } }
function safeColor(c) { return /^(#[0-9a-fA-F]{3,8}|[a-zA-Z]+|rgba?\([^)]+\))$/.test(c) ? escAttr(c) : '' }
function safeSize(s) { const n = parseInt(s, 10); return (n > 0 && n <= 72) ? n : '' }

function parseBBCode(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    .replace(/\[b\](.*?)\[\/b\]/gs, '<strong>$1</strong>')
    .replace(/\[i\](.*?)\[\/i\]/gs, '<em>$1</em>')
    .replace(/\[u\](.*?)\[\/u\]/gs, '<u>$1</u>')
    .replace(/\[s\](.*?)\[\/s\]/gs, '<span style="text-decoration:line-through">$1</span>')
    .replace(/\[color=([^\]]+)\](.*?)\[\/color\]/gs, (_, c, t) => { const sc = safeColor(c); return sc ? `<span style="color:${sc}">${t}</span>` : t })
    .replace(/\[size=([^\]]+)\](.*?)\[\/size\]/gs, (_, s, t) => { const ss = safeSize(s); return ss ? `<span style="font-size:${ss}px">${t}</span>` : t })
    .replace(/\[center\](.*?)\[\/center\]/gs, '<div style="text-align:center">$1</div>')
    .replace(/\[url=([^\]]+)\](.*?)\[\/url\]/gs, (_, u, t) => { const su = safeUrl(u); return su ? `<span style="color:rgb(var(--accent-rgb));text-decoration:underline;cursor:pointer" title="${su}">${t}</span>` : t })
    .replace(/\[img\](.*?)\[\/img\]/gs, (_, u) => { const su = safeUrl(u); return su ? `<img src="${su}" style="max-width:100%;border-radius:4px;margin:4px 0" />` : '' })
    .replace(/\[quote\](.*?)\[\/quote\]/gs, '<div style="border-left:2px solid rgb(var(--accent-rgb) / 0.25);padding:4px 8px;margin:4px 0;background:rgb(var(--accent-rgb) / 0.05);border-radius:4px;font-style:italic">$1</div>')
    .replace(/\[hr\]/g, '<hr style="border:none;border-top:1px solid rgb(var(--accent-rgb) / 0.15);margin:6px 0" />')
    .replace(/\[list\](.*?)\[\/list\]/gs, (_, content) => { const items = content.split('[*]').filter(s => s.trim()).map(s => `<li>${s.trim()}</li>`).join(''); return `<ul style="list-style:disc;padding-left:14px">${items}</ul>` })
    .replace(/\n/g, '<br/>')
}

function BBCodeRenderer({ text }) { if (!text) return null; return <div dangerouslySetInnerHTML={{ __html: parseBBCode(text) }} /> }

function AppearanceSection() {
  const { settings, updateSettings } = useStore()
  const accentColor = settings.accentColor || '#ff6a00'
  const [hexDraft, setHexDraft] = React.useState('')
  const [hexFocused, setHexFocused] = React.useState(false)

  const handleBackgroundSelect = async () => { if (window.electronAPI) { const p = await window.electronAPI.selectImage(); if (p) { const normalized = p.replace(/\\/g, '/'); updateSettings({ background: `file:///${normalized}` }); toast.success('Background updated!') } } else { const url = prompt('Enter background image URL:'); if (url) { updateSettings({ background: url }); toast.success('Background updated!') } } }
  const handleLogoSelect = async () => { if (window.electronAPI) { const p = await window.electronAPI.selectImage(); if (p) { const normalized = p.replace(/\\/g, '/'); updateSettings({ logo: `file:///${normalized}` }); toast.success('Logo updated!') } } else { const url = prompt('Enter logo image URL:'); if (url) { updateSettings({ logo: url }); toast.success('Logo updated!') } } }
  const handleBannerImageSelect = async () => { if (window.electronAPI) { const p = await window.electronAPI.selectImage(); if (p) { const normalized = p.replace(/\\/g, '/'); updateSettings({ bannerImage: `file:///${normalized}` }); toast.success('Banner image updated!') } } else { const url = prompt('Enter banner image URL:'); if (url) { updateSettings({ bannerImage: url }); toast.success('Banner image updated!') } } }

  const presetColors = [
    { name: 'Orange', hex: '#ff6a00' }, { name: 'Cyan', hex: '#00d4ff' }, { name: 'Purple', hex: '#a855f7' }, { name: 'Green', hex: '#22c55e' }, { name: 'Red', hex: '#ef4444' },
    { name: 'Pink', hex: '#ec4899' }, { name: 'Blue', hex: '#3b82f6' }, { name: 'Yellow', hex: '#eab308' }, { name: 'Teal', hex: '#14b8a6' }, { name: 'Rose', hex: '#f43f5e' },
  ]
  const handleAccentChange = (hex) => { if (/^#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/.test(hex)) updateSettings({ accentColor: hex }) }

  return (
    <SectionWrapper>
      <SectionTitle icon={Layout} title="Appearance" />

      <CardBox>
        <h4 className="font-orbitron text-xs uppercase tracking-[0.15em]" style={{ color: `${accentColor}60` }}>Accent Color</h4>
        <p className="font-rajdhani text-white/35 text-xs">Choose the main theme color for the entire launcher.</p>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-xl border-2 border-white/20 cursor-pointer relative overflow-hidden" style={{ background: accentColor, boxShadow: `0 0 20px ${accentColor}40` }}>
              <input type="color" value={accentColor} onChange={e => handleAccentChange(e.target.value)} className="absolute inset-0 w-full h-full opacity-0 cursor-pointer" />
            </div>
            <input value={hexFocused ? hexDraft : accentColor} onFocus={() => { setHexDraft(accentColor); setHexFocused(true) }} onBlur={() => { handleAccentChange(hexDraft); setHexFocused(false) }} onChange={e => setHexDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { handleAccentChange(hexDraft); setHexFocused(false); e.target.blur() } }} placeholder="#ff6a00"
              className="w-24 px-3 py-2.5 bg-black/30 border border-white/[0.06] rounded-lg text-white text-sm font-mono focus:outline-none focus:border-white/15 uppercase" />
          </div>
          <div className="flex gap-1.5 flex-wrap flex-1">
            {presetColors.map(c => (
              <button key={c.hex} onClick={() => handleAccentChange(c.hex)} title={c.name} className="w-7 h-7 rounded-lg border-2 transition-all hover:scale-110 active:scale-95"
                style={{ background: c.hex, borderColor: accentColor === c.hex ? '#fff' : 'rgba(255,255,255,0.1)', boxShadow: accentColor === c.hex ? `0 0 10px ${c.hex}60` : 'none' }} />
            ))}
          </div>
          {accentColor !== '#ff6a00' && <button onClick={() => handleAccentChange('#ff6a00')} className="px-3 py-2 border border-white/[0.06] rounded-lg text-white/40 text-[11px] font-rajdhani hover:text-white/60 transition-all uppercase tracking-wider flex-shrink-0">Reset</button>}
        </div>
      </CardBox>

      <div className="grid grid-cols-2 gap-4">
        <CardBox>
          <h4 className="font-orbitron text-xs uppercase tracking-[0.15em]" style={{ color: `${accentColor}60` }}>Background</h4>
          <div className="aspect-video rounded-lg overflow-hidden border border-white/[0.06] bg-black/30 flex items-center justify-center">
            {settings.background ? <img src={settings.background} alt="Background" className="w-full h-full object-cover" /> : <div className="text-white/10 text-center"><Image size={22} className="mx-auto mb-1" /><p className="text-[10px] font-rajdhani">No background</p></div>}
          </div>
          <div className="flex gap-2">
            <button onClick={handleBackgroundSelect} className="flex-1 flex items-center justify-center gap-2 py-2 rounded-lg text-[11px] font-rajdhani font-bold transition-all uppercase tracking-wider" style={{ background: `${accentColor}10`, border: `1px solid ${accentColor}15`, color: accentColor }}><Upload size={11} />Change</button>
            {settings.background && <button onClick={() => updateSettings({ background: null })} className="px-3 py-2 border border-red-500/10 rounded-lg text-red-400/70 text-[11px] hover:bg-red-500/5 transition-all">Clear</button>}
          </div>
        </CardBox>

        <CardBox>
          <h4 className="font-orbitron text-xs uppercase tracking-[0.15em]" style={{ color: `${accentColor}60` }}>Logo</h4>
          <div className="aspect-square w-20 mx-auto rounded-xl overflow-hidden border border-white/[0.06] bg-black/30 flex items-center justify-center">
            {settings.logo ? <img src={settings.logo} alt="Logo" className="w-full h-full object-contain" /> : <Monitor size={18} className="text-white/10" />}
          </div>
          <div className="flex gap-2">
            <button onClick={handleLogoSelect} className="flex-1 flex items-center justify-center gap-2 py-2 rounded-lg text-[11px] font-rajdhani font-bold transition-all uppercase tracking-wider" style={{ background: `${accentColor}10`, border: `1px solid ${accentColor}15`, color: accentColor }}><Upload size={11} />Change</button>
            {settings.logo && <button onClick={() => updateSettings({ logo: null })} className="px-3 py-2 border border-red-500/10 rounded-lg text-red-400/70 text-[11px] hover:bg-red-500/5 transition-all">Clear</button>}
          </div>
        </CardBox>
      </div>

      <CardBox>
        <h4 className="font-orbitron text-xs uppercase tracking-[0.15em]" style={{ color: `${accentColor}60` }}>Banner Image</h4>
        <p className="font-rajdhani text-white/35 text-xs">An image displayed on the right side of the top banner.</p>
        <div className="flex items-center gap-4">
          <div className="w-32 h-20 rounded-lg overflow-hidden border border-white/[0.06] bg-black/30 flex items-center justify-center">
            {settings.bannerImage ? <img src={settings.bannerImage} alt="Banner" className="w-full h-full object-contain" /> : <div className="text-white/10 text-center"><Image size={18} className="mx-auto mb-1" /><p className="text-[9px] font-rajdhani">No banner</p></div>}
          </div>
          <div className="flex-1 space-y-2">
            <InputField value={settings.bannerImage || ''} onChange={e => updateSettings({ bannerImage: e.target.value || null })} placeholder="https://... or file path" />
            <div className="flex gap-2">
              <button onClick={handleBannerImageSelect} className="flex items-center gap-2 py-2 px-3 rounded-lg text-[11px] font-rajdhani font-bold transition-all uppercase tracking-wider" style={{ background: `${accentColor}10`, border: `1px solid ${accentColor}15`, color: accentColor }}><Upload size={11} />Browse</button>
              {settings.bannerImage && <button onClick={() => updateSettings({ bannerImage: null })} className="px-3 py-2 border border-red-500/10 rounded-lg text-red-400/70 text-[11px] hover:bg-red-500/5 transition-all">Clear</button>}
            </div>
          </div>
        </div>
      </CardBox>

      <CardBox>
        <h4 className="font-orbitron text-xs uppercase tracking-[0.15em]" style={{ color: `${accentColor}60` }}>Preloading Screen</h4>
        <p className="font-rajdhani text-white/35 text-xs">Image shown when the .exe is launched, before the main app loads.</p>
        <div className="flex items-center gap-4">
          <div className="w-32 h-20 rounded-lg overflow-hidden border border-white/[0.06] bg-black/30 flex items-center justify-center">
            {settings.splashImage ? <img src={settings.splashImage} alt="Splash" className="w-full h-full object-contain" /> : <div className="text-white/10 text-center"><Image size={18} className="mx-auto mb-1" /><p className="text-[9px] font-rajdhani">No splash</p></div>}
          </div>
          <div className="flex gap-2">
            <button onClick={async () => { if (window.electronAPI) { const p = await window.electronAPI.selectImage(); if (p) { const normalized = p.replace(/\\/g, '/'); updateSettings({ splashImage: `file:///${normalized}` }); toast.success('Splash image updated!') } } else { const url = prompt('Enter splash image URL:'); if (url) { updateSettings({ splashImage: url }); toast.success('Splash image updated!') } } }}
              className="flex items-center gap-2 py-2 px-3 rounded-lg text-[11px] font-rajdhani font-bold transition-all uppercase tracking-wider" style={{ background: `${accentColor}10`, border: `1px solid ${accentColor}15`, color: accentColor }}><Upload size={11} />Change</button>
            {settings.splashImage && <button onClick={() => updateSettings({ splashImage: null })} className="px-3 py-2 border border-red-500/10 rounded-lg text-red-400/70 text-[11px] hover:bg-red-500/5 transition-all">Clear</button>}
          </div>
        </div>
      </CardBox>

      <CardBox>
        <h4 className="font-orbitron text-xs uppercase tracking-[0.15em]" style={{ color: `${accentColor}60` }}>Launcher Info</h4>
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className="block text-xs text-white/40 mb-1.5 font-rajdhani uppercase tracking-wider">Launcher Name</label>
            <InputField value={settings.launcherName || ''} onChange={e => updateSettings({ launcherName: e.target.value })} className="font-orbitron" />
          </div>
          <div>
            <label className="block text-xs text-white/40 mb-1.5 font-rajdhani uppercase tracking-wider">Tagline</label>
            <InputField value={settings.launcherTagline || ''} onChange={e => updateSettings({ launcherTagline: e.target.value })} />
          </div>
          <div>
            <label className="block text-xs text-white/40 mb-1.5 font-rajdhani uppercase tracking-wider">Powered By</label>
            <InputField value={settings.poweredBy || ''} onChange={e => updateSettings({ poweredBy: e.target.value })} placeholder="e.g. EXAMPLE CAFE" />
          </div>
        </div>
      </CardBox>
    </SectionWrapper>
  )
}

function RatesSection() {
  const { settings, updateSettings } = useStore()
  const accentColor = settings.accentColor || '#ff6a00'
  const [rates, setRates] = useState(settings.computerRates || [])
  const [newRate, setNewRate] = useState({ name: '', price: '', unit: '/hr' })

  const handleAddRate = () => { if (!newRate.name.trim()) return toast.error('Rate name is required'); if (!newRate.price || isNaN(newRate.price)) return toast.error('Valid price is required'); const updated = [...rates, { name: newRate.name, price: Number(newRate.price), unit: newRate.unit }]; setRates(updated); updateSettings({ computerRates: updated }); setNewRate({ name: '', price: '', unit: '/hr' }); toast.success('Rate added!') }
  const handleRemoveRate = (index) => { const updated = rates.filter((_, i) => i !== index); setRates(updated); updateSettings({ computerRates: updated }); toast.success('Rate removed') }
  const handleUpdateRate = (index, field, value) => { const updated = rates.map((r, i) => i === index ? { ...r, [field]: field === 'price' ? Number(value) || 0 : value } : r); setRates(updated); updateSettings({ computerRates: updated }) }

  return (
    <SectionWrapper>
      <SectionTitle icon={DollarSign} title="Computer Rates" />
      <p className="font-rajdhani text-white/40 text-sm">Set pricing tiers displayed in the sidebar.</p>
      <div className="space-y-2">
        {rates.map((rate, i) => (
          <div key={i} className="flex items-center gap-3 p-3 rounded-xl border transition-all" style={{ background: 'rgba(255,255,255,0.015)', borderColor: 'rgba(255,255,255,0.04)' }}>
            <div className="flex-1 grid grid-cols-3 gap-2">
              <InputField value={rate.name} onChange={e => handleUpdateRate(i, 'name', e.target.value)} placeholder="Name" />
              <InputField type="number" value={rate.price} onChange={e => handleUpdateRate(i, 'price', e.target.value)} placeholder="Price" className="font-orbitron" style={{ color: accentColor }} />
              <InputField value={rate.unit} onChange={e => handleUpdateRate(i, 'unit', e.target.value)} placeholder="/hr" />
            </div>
            <button onClick={() => handleRemoveRate(i)} className="w-8 h-8 flex items-center justify-center text-white/15 hover:text-red-400 transition-all rounded-lg"><Trash2 size={13} /></button>
          </div>
        ))}
      </div>
      <CardBox highlight>
        <h4 className="font-orbitron text-xs uppercase tracking-[0.15em]" style={{ color: `${accentColor}60` }}>Add New Rate</h4>
        <div className="grid grid-cols-3 gap-2">
          <div><label className="block text-xs text-white/40 mb-1.5 font-rajdhani uppercase tracking-wider">Name</label><InputField value={newRate.name} onChange={e => setNewRate(r => ({ ...r, name: e.target.value }))} placeholder="e.g. VIP Room" /></div>
          <div><label className="block text-xs text-white/40 mb-1.5 font-rajdhani uppercase tracking-wider">Price (₱)</label><InputField type="number" value={newRate.price} onChange={e => setNewRate(r => ({ ...r, price: e.target.value }))} placeholder="25" className="font-orbitron" /></div>
          <div><label className="block text-xs text-white/40 mb-1.5 font-rajdhani uppercase tracking-wider">Unit</label><InputField value={newRate.unit} onChange={e => setNewRate(r => ({ ...r, unit: e.target.value }))} placeholder="/hr" /></div>
        </div>
        <AccentButton onClick={handleAddRate}><Plus size={13} />ADD RATE</AccentButton>
      </CardBox>
    </SectionWrapper>
  )
}

const GRADIENT_COLORS = [
  { label: 'Blue', value: 'from-blue-500 to-blue-600' }, { label: 'Red', value: 'from-red-500 to-red-600' }, { label: 'Green', value: 'from-green-500 to-green-600' },
  { label: 'Purple', value: 'from-purple-500 to-purple-600' }, { label: 'Orange', value: 'from-orange-500 to-orange-600' }, { label: 'Indigo', value: 'from-indigo-500 to-indigo-600' },
  { label: 'Emerald', value: 'from-emerald-500 to-emerald-600' }, { label: 'Gray', value: 'from-gray-500 to-gray-600' }, { label: 'Pink', value: 'from-pink-500 to-pink-600' },
  { label: 'Cyan', value: 'from-cyan-500 to-cyan-600' },
]

function SocialSection() {
  const { settings, updateSettings } = useStore()
  const accentColor = settings.accentColor || '#ff6a00'
  const [links, setLinks] = useState(settings.socialLinks || [])
  const [newItem, setNewItem] = useState({ name: '', icon: '', url: '', image: '', color: 'from-blue-500 to-blue-600' })

  const save = (updated) => { setLinks(updated); updateSettings({ socialLinks: updated }) }
  const handleAdd = () => { if (!newItem.name.trim()) return toast.error('Name is required'); if (!newItem.icon.trim() && !newItem.image.trim()) return toast.error('Icon letter or image is required'); if (!newItem.url.trim()) return toast.error('URL is required'); save([...links, { ...newItem, id: Date.now().toString() }]); setNewItem({ name: '', icon: '', url: '', image: '', color: 'from-blue-500 to-blue-600' }); toast.success('Social link added!') }
  const handleRemove = (id) => { save(links.filter(l => l.id !== id)); toast.success('Social link removed') }
  const handleUpdate = (id, field, value) => save(links.map(l => l.id === id ? { ...l, [field]: value } : l))

  return (
    <SectionWrapper>
      <SectionTitle icon={Share2} title="Social Media Links" />
      <p className="font-rajdhani text-white/40 text-sm">Manage social media buttons in the sidebar.</p>
      <div className="space-y-2">
        {links.map((link) => (
          <div key={link.id} className="flex items-center gap-3 p-3 rounded-xl border transition-all" style={{ background: 'rgba(255,255,255,0.015)', borderColor: 'rgba(255,255,255,0.04)' }}>
            <div className={`w-9 h-9 rounded-full bg-gradient-to-br ${link.color} flex items-center justify-center text-white text-sm font-bold flex-shrink-0 overflow-hidden`}>
              {link.image ? <img src={link.image} alt={link.name} className="w-full h-full object-cover" /> : link.icon}
            </div>
            <div className="flex-1 space-y-2">
              <div className="grid grid-cols-3 gap-2">
                <InputField value={link.name} onChange={e => handleUpdate(link.id, 'name', e.target.value)} placeholder="Name" />
                <InputField value={link.icon} onChange={e => handleUpdate(link.id, 'icon', e.target.value)} placeholder="Icon letter" maxLength={3} className="text-center" />
                <InputField value={link.url} onChange={e => handleUpdate(link.id, 'url', e.target.value)} placeholder="https://..." />
              </div>
              <div className="flex gap-2">
                <div className="flex-1 flex gap-1">
                  <InputField value={link.image || ''} onChange={e => handleUpdate(link.id, 'image', e.target.value)} placeholder="Image path — overrides icon letter" className="flex-1" />
                  <button onClick={async () => { if (window.electronAPI?.selectImage) { const path = await window.electronAPI.selectImage(); if (path) handleUpdate(link.id, 'image', `file:///${path}`) } else { const path = prompt('Enter image path:'); if (path) handleUpdate(link.id, 'image', path) } }} className="px-2 py-2 border border-white/[0.06] rounded-lg text-white/20 hover:text-white/50 transition-all" title="Browse image"><Image size={12} /></button>
                </div>
                <select value={link.color} onChange={e => handleUpdate(link.id, 'color', e.target.value)} className="px-2 py-2 bg-black/30 border border-white/[0.06] rounded-lg text-white/40 text-[10px] font-rajdhani focus:outline-none w-20">
                  {GRADIENT_COLORS.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                </select>
              </div>
            </div>
            <button onClick={() => handleRemove(link.id)} className="w-8 h-8 flex items-center justify-center text-white/15 hover:text-red-400 transition-all rounded-lg"><Trash2 size={13} /></button>
          </div>
        ))}
      </div>
      <CardBox highlight>
        <h4 className="font-orbitron text-xs uppercase tracking-[0.15em]" style={{ color: `${accentColor}60` }}>Add Social Link</h4>
        <div className="grid grid-cols-4 gap-2">
          <div><label className="block text-xs text-white/40 mb-1.5 font-rajdhani uppercase tracking-wider">Name</label><InputField value={newItem.name} onChange={e => setNewItem(s => ({ ...s, name: e.target.value }))} placeholder="Facebook" /></div>
          <div><label className="block text-xs text-white/40 mb-1.5 font-rajdhani uppercase tracking-wider">Icon Letter</label><InputField value={newItem.icon} onChange={e => setNewItem(s => ({ ...s, icon: e.target.value }))} placeholder="f" maxLength={3} className="text-center" /></div>
          <div><label className="block text-xs text-white/40 mb-1.5 font-rajdhani uppercase tracking-wider">URL</label><InputField value={newItem.url} onChange={e => setNewItem(s => ({ ...s, url: e.target.value }))} placeholder="https://facebook.com" /></div>
          <div><label className="block text-xs text-white/40 mb-1.5 font-rajdhani uppercase tracking-wider">Color</label><select value={newItem.color} onChange={e => setNewItem(s => ({ ...s, color: e.target.value }))} className="w-full px-3 py-2.5 bg-black/30 border border-white/[0.06] rounded-lg text-white/40 text-sm font-rajdhani focus:outline-none">{GRADIENT_COLORS.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}</select></div>
        </div>
        <div><label className="block text-xs text-white/40 mb-1.5 font-rajdhani uppercase tracking-wider">Image (optional)</label>
          <div className="flex gap-1">
            <InputField value={newItem.image} onChange={e => setNewItem(s => ({ ...s, image: e.target.value }))} placeholder="/icons/facebook.png or https://..." className="flex-1" />
            <button onClick={async () => { if (window.electronAPI?.selectImage) { const path = await window.electronAPI.selectImage(); if (path) setNewItem(s => ({ ...s, image: `file://${path}` })) } else { const path = prompt('Enter image path:'); if (path) setNewItem(s => ({ ...s, image: path })) } }} className="px-3 py-2 border border-white/[0.06] rounded-lg text-white/20 hover:text-white/50 transition-all" title="Browse image"><Image size={14} /></button>
          </div>
        </div>
        <AccentButton onClick={handleAdd}><Plus size={13} />ADD SOCIAL LINK</AccentButton>
      </CardBox>
    </SectionWrapper>
  )
}

function OfficeSection() {
  const { settings, updateSettings } = useStore()
  const accentColor = settings.accentColor || '#ff6a00'
  const [apps, setApps] = useState(settings.officeApps || [])
  const [newItem, setNewItem] = useState({ name: '', icon: '', exePath: '', image: '', color: 'from-blue-500 to-blue-600' })

  const save = (updated) => { setApps(updated); updateSettings({ officeApps: updated }) }
  const handleAdd = () => { if (!newItem.name.trim()) return toast.error('Name is required'); if (!newItem.icon.trim() && !newItem.image.trim()) return toast.error('Icon letter or image is required'); save([...apps, { ...newItem, id: Date.now().toString() }]); setNewItem({ name: '', icon: '', exePath: '', image: '', color: 'from-blue-500 to-blue-600' }); toast.success('Top app added!') }
  const handleRemove = (id) => { save(apps.filter(a => a.id !== id)); toast.success('Top app removed') }
  const handleUpdate = (id, field, value) => save(apps.map(a => a.id === id ? { ...a, [field]: value } : a))
  const handleBrowse = async (id) => { if (window.electronAPI) { const path = await window.electronAPI.selectFile([{ name: 'All Files', extensions: ['*'] }]); if (path) handleUpdate(id, 'exePath', path) } else { const path = prompt('Enter file path:'); if (path) handleUpdate(id, 'exePath', path) } }

  return (
    <SectionWrapper>
      <SectionTitle icon={Briefcase} title="Top Apps" />
      <p className="font-rajdhani text-white/40 text-sm">Manage quick-launch apps in the sidebar.</p>
      <div className="space-y-2">
        {apps.map((app) => (
          <div key={app.id} className="flex items-center gap-3 p-3 rounded-xl border transition-all" style={{ background: 'rgba(255,255,255,0.015)', borderColor: 'rgba(255,255,255,0.04)' }}>
            <div className={`w-9 h-9 rounded-full bg-gradient-to-br ${app.color} flex items-center justify-center text-white text-sm font-bold flex-shrink-0 overflow-hidden`}>
              {app.image ? <img src={app.image} alt={app.name} className="w-full h-full object-cover" /> : app.icon}
            </div>
            <div className="flex-1 space-y-2">
              <div className="grid grid-cols-3 gap-2">
                <InputField value={app.name} onChange={e => handleUpdate(app.id, 'name', e.target.value)} placeholder="Name" />
                <InputField value={app.icon} onChange={e => handleUpdate(app.id, 'icon', e.target.value)} placeholder="Icon letter" maxLength={3} className="text-center" />
                <div className="flex gap-1">
                  <InputField value={app.exePath} onChange={e => handleUpdate(app.id, 'exePath', e.target.value)} placeholder="File path (.exe, shortcut, etc.)" className="flex-1" />
                  <button onClick={() => handleBrowse(app.id)} className="px-2 py-2 border border-white/[0.06] rounded-lg text-white/20 hover:text-white/50 transition-all" title="Browse"><ExternalLink size={12} /></button>
                </div>
              </div>
              <div className="flex gap-2">
                <div className="flex-1 flex gap-1">
                  <InputField value={app.image || ''} onChange={e => handleUpdate(app.id, 'image', e.target.value)} placeholder="Image path — overrides icon letter" className="flex-1" />
                  <button onClick={async () => { if (window.electronAPI?.selectImage) { const path = await window.electronAPI.selectImage(); if (path) handleUpdate(app.id, 'image', `file:///${path}`) } else { const path = prompt('Enter image path:'); if (path) handleUpdate(app.id, 'image', path) } }} className="px-2 py-2 border border-white/[0.06] rounded-lg text-white/20 hover:text-white/50 transition-all" title="Browse image"><Image size={12} /></button>
                </div>
                <select value={app.color} onChange={e => handleUpdate(app.id, 'color', e.target.value)} className="px-2 py-2 bg-black/30 border border-white/[0.06] rounded-lg text-white/40 text-[10px] font-rajdhani focus:outline-none w-20">
                  {GRADIENT_COLORS.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                </select>
              </div>
            </div>
            <button onClick={() => handleRemove(app.id)} className="w-8 h-8 flex items-center justify-center text-white/15 hover:text-red-400 transition-all rounded-lg"><Trash2 size={13} /></button>
          </div>
        ))}
      </div>
      <CardBox highlight>
        <h4 className="font-orbitron text-xs uppercase tracking-[0.15em]" style={{ color: `${accentColor}60` }}>Add Top App</h4>
        <div className="grid grid-cols-4 gap-2">
          <div><label className="block text-xs text-white/40 mb-1.5 font-rajdhani uppercase tracking-wider">Name</label><InputField value={newItem.name} onChange={e => setNewItem(s => ({ ...s, name: e.target.value }))} placeholder="Excel" /></div>
          <div><label className="block text-xs text-white/40 mb-1.5 font-rajdhani uppercase tracking-wider">Icon Letter</label><InputField value={newItem.icon} onChange={e => setNewItem(s => ({ ...s, icon: e.target.value }))} placeholder="X" maxLength={3} className="text-center" /></div>
          <div><label className="block text-xs text-white/40 mb-1.5 font-rajdhani uppercase tracking-wider">EXE Path</label><InputField value={newItem.exePath} onChange={e => setNewItem(s => ({ ...s, exePath: e.target.value }))} placeholder="C:\\Program Files\\..." /></div>
          <div><label className="block text-xs text-white/40 mb-1.5 font-rajdhani uppercase tracking-wider">Color</label><select value={newItem.color} onChange={e => setNewItem(s => ({ ...s, color: e.target.value }))} className="w-full px-3 py-2.5 bg-black/30 border border-white/[0.06] rounded-lg text-white/40 text-sm font-rajdhani focus:outline-none">{GRADIENT_COLORS.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}</select></div>
        </div>
        <div><label className="block text-xs text-white/40 mb-1.5 font-rajdhani uppercase tracking-wider">Image (optional)</label>
          <div className="flex gap-1">
            <InputField value={newItem.image} onChange={e => setNewItem(s => ({ ...s, image: e.target.value }))} placeholder="/icons/excel.png or https://..." className="flex-1" />
            <button onClick={async () => { if (window.electronAPI?.selectImage) { const path = await window.electronAPI.selectImage(); if (path) setNewItem(s => ({ ...s, image: `file://${path}` })) } else { const path = prompt('Enter image path:'); if (path) setNewItem(s => ({ ...s, image: path })) } }} className="px-3 py-2 border border-white/[0.06] rounded-lg text-white/20 hover:text-white/50 transition-all" title="Browse image"><Image size={14} /></button>
          </div>
        </div>
        <AccentButton onClick={handleAdd}><Plus size={13} />ADD TOP APP</AccentButton>
      </CardBox>
    </SectionWrapper>
  )
}

function SettingsSection() {
  const { settings, updateSettings } = useStore()
  const accentColor = settings.accentColor || '#ff6a00'
  const [newKey, setNewKey] = useState('')
  const [confirmKey, setConfirmKey] = useState('')

  const handleUpdateKey = () => { if (!newKey.trim()) return toast.error('Key cannot be empty'); if (newKey !== confirmKey) return toast.error('Keys do not match'); if (newKey.length < 6) return toast.error('Key must be at least 6 characters'); updateSettings({ secretKey: newKey }); setNewKey(''); setConfirmKey(''); toast.success('Secret key updated!') }

  return (
    <SectionWrapper>
      <SectionTitle icon={Settings} title="Settings" />

      <CardBox>
        <div className="flex items-center gap-2"><Power size={13} style={{ color: accentColor }} /><h4 className="font-orbitron text-xs uppercase tracking-[0.15em]" style={{ color: `${accentColor}60` }}>Launch Behavior</h4></div>
        <div className="flex items-center justify-between">
          <div><p className="font-rajdhani text-white/50 text-sm font-semibold">Auto-close launcher on game launch</p><p className="font-rajdhani text-white/30 text-xs">The launcher will close automatically after launching a game.</p></div>
          <ToggleSwitch checked={settings.autoCloseOnLaunch} onChange={() => updateSettings({ autoCloseOnLaunch: !settings.autoCloseOnLaunch })} />
        </div>
      </CardBox>

      <CardBox>
        <div className="flex items-center gap-2"><Layout size={13} style={{ color: accentColor }} /><h4 className="font-orbitron text-xs uppercase tracking-[0.15em]" style={{ color: `${accentColor}60` }}>Display</h4></div>
        <div className="flex items-center justify-between">
          <div><p className="font-rajdhani text-white/50 text-sm font-semibold">Show game names on cards</p><p className="font-rajdhani text-white/30 text-xs">Toggle game name labels under each card.</p></div>
          <ToggleSwitch checked={settings.showGameNames !== false} onChange={() => updateSettings({ showGameNames: settings.showGameNames === false ? true : false })} />
        </div>
      </CardBox>

      <CardBox>
        <div className="flex items-center gap-2"><Key size={13} style={{ color: accentColor }} /><h4 className="font-orbitron text-xs uppercase tracking-[0.15em]" style={{ color: `${accentColor}60` }}>Change Secret Key</h4></div>
        <p className="font-rajdhani text-white/30 text-xs tracking-wider">Update the admin access password.</p>
        <div className="space-y-2">
          <InputField type="password" value={newKey} onChange={e => setNewKey(e.target.value)} placeholder="New secret key" className="font-orbitron tracking-widest" />
          <InputField type="password" value={confirmKey} onChange={e => setConfirmKey(e.target.value)} placeholder="Confirm new key" className="font-orbitron tracking-widest" />
          <AccentButton onClick={handleUpdateKey} className="w-full justify-center">UPDATE KEY</AccentButton>
        </div>
      </CardBox>

      <CardBox>
        <div className="flex items-center gap-2"><Monitor size={13} style={{ color: accentColor }} /><h4 className="font-orbitron text-xs uppercase tracking-[0.15em]" style={{ color: `${accentColor}60` }}>Save & Load Server</h4></div>
        <p className="font-rajdhani text-white/30 text-xs tracking-wider">Connect to a EXAMPLE CAFE Save & Load Server.</p>
        <div className="space-y-2">
          <InputField type="text" value={settings.saveLoadServerUrl} onChange={e => updateSettings({ saveLoadServerUrl: e.target.value })} placeholder="http://192.168.1.100:3456" />
          {settings.saveLoadServerUrl ? <p className="text-emerald-400/60 text-[10px] font-rajdhani">Server URL configured</p> : <p className="text-white/25 text-[10px] font-rajdhani">Not configured — Save & Load will show setup instructions</p>}
        </div>
      </CardBox>

      <CardBox>
        <div className="flex items-center gap-2"><Gamepad2 size={13} style={{ color: accentColor }} /><h4 className="font-orbitron text-xs uppercase tracking-[0.15em]" style={{ color: `${accentColor}60` }}>IGDB API Credentials</h4></div>
        <p className="font-rajdhani text-white/30 text-xs tracking-wider">Connect to IGDB (via Twitch) to search and auto-fill game data.</p>
        <div className="space-y-2">
          <InputField type="text" value={settings.igdbClientId} onChange={e => updateSettings({ igdbClientId: e.target.value })} placeholder="Twitch Client ID" />
          <InputField type="password" value={settings.igdbClientSecret} onChange={e => updateSettings({ igdbClientSecret: e.target.value })} placeholder="Twitch Client Secret" />
          {settings.igdbClientId && settings.igdbClientSecret ? <p className="text-emerald-400/60 text-[10px] font-rajdhani">Credentials configured</p> : <p className="text-red-400/50 text-[10px] font-rajdhani">Not configured — IGDB game search will not work</p>}
        </div>
      </CardBox>

      <CardBox>
        <h4 className="font-orbitron text-xs uppercase tracking-[0.15em] mb-3" style={{ color: `${accentColor}60` }}>About</h4>
        <div className="space-y-2 font-rajdhani text-sm">
          <div className="flex justify-between"><span className="text-white/20">Launcher</span><span style={{ color: accentColor }}>EXAMPLE CAFE</span></div>
          <div className="flex justify-between"><span className="text-white/20">Framework</span><span className="text-white/35">Electron + React</span></div>
        </div>
      </CardBox>
    </SectionWrapper>
  )
}
