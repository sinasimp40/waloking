import React, { useState, useRef, useEffect } from 'react'
import { Plus, Trash2, Save, DollarSign, Share2, Briefcase, Network, Megaphone, Calendar, Palette, Settings, Download, Search, ChevronUp, ChevronDown, Edit2, Image as ImageIcon, FileArchive, Bell, Activity, Loader2, CheckCircle2, XCircle, AlertCircle, Server } from 'lucide-react'
import JSZip from 'jszip'
import toast from 'react-hot-toast'
import { motion, AnimatePresence } from 'framer-motion'
import useStore from '../store/useStore'
import { getDefaultAccent } from '../lib/accent'
import { SectionTitle, Card, Panel, PrimaryBtn, GhostBtn, Field, Input, Toggle } from './AdminPanelShared'

export function RatesSection() {
  const { settings, updateSettings } = useStore()
  const [newRate, setNewRate] = useState({ name: '', price: '', unit: '/hr' })
  const [editingIndex, setEditingIndex] = useState(null)
  const accent = useStore(s => s.settings.accentColor) || getDefaultAccent()

  const handleCommit = () => {
    if (!newRate.name || !newRate.price) return toast.error('Name and Price required')
    
    let updated = [...(settings.computerRates || [])]
    if (editingIndex !== null) {
      updated[editingIndex] = newRate
      toast.success('Rate updated successfully')
    } else {
      updated.push(newRate)
      toast.success('Rate added successfully')
    }
    
    updateSettings({ computerRates: updated })
    setNewRate({ name: '', price: '', unit: '/hr' })
    setEditingIndex(null)
  }

  const deleteRate = (index) => {
    const updated = settings.computerRates.filter((_, i) => i !== index)
    updateSettings({ computerRates: updated })
    toast.success('Rate removed')
    if (editingIndex === index) {
      setEditingIndex(null)
      setNewRate({ name: '', price: '', unit: '/hr' })
    }
  }

  const startEdit = (index) => {
    setEditingIndex(index)
    setNewRate(settings.computerRates[index])
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  return (
    <div className="space-y-12">
      <SectionTitle title="Pricing Architecture" count={settings.computerRates?.length} />
      
      <Panel 
        title={editingIndex !== null ? "Modify Strategy" : "Data Entry"} 
        subtitle={editingIndex !== null ? `Updating parameters for ${settings.computerRates[editingIndex].name}` : "Configure new billing parameters for station sessions"}
        action={editingIndex !== null && (
          <GhostBtn onClick={() => {
            setEditingIndex(null)
            setNewRate({ name: '', price: '', unit: '/hr' })
          }}>Cancel Edit</GhostBtn>
        )}
      >
        <div className="grid grid-cols-1 md:grid-cols-4 gap-6 items-end">
          <div className="md:col-span-2">
            <Field label="Identification Tag">
              <Input 
                value={newRate.name} 
                onChange={e => setNewRate(r => ({ ...r, name: e.target.value }))} 
                placeholder="e.g. VIP_STATION_ALPHA" 
              />
            </Field>
          </div>
          <Field label="Credit Value">
            <Input 
              type="number" 
              value={newRate.price} 
              onChange={e => setNewRate(r => ({ ...r, price: e.target.value }))} 
              placeholder="0.00" 
            />
          </Field>
          <PrimaryBtn onClick={handleCommit}>
            {editingIndex !== null ? 'Update Rate' : 'Commit Rate'}
          </PrimaryBtn>
        </div>
      </Panel>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {settings.computerRates?.map((rate, i) => (
          <div 
            key={i} 
            className={`group relative bg-[#0A0A0B] border rounded-2xl p-6 transition-all duration-300 hover:shadow-2xl hover:shadow-black/40 ${editingIndex === i ? 'ring-2' : 'hover:border-zinc-700/50'}`}
            style={{ 
              borderColor: editingIndex === i ? accent : 'rgba(39, 39, 42, 0.5)',
              boxShadow: editingIndex === i ? `0 0 20px ${accent}20` : 'none'
            }}
          >
            {/* Glossy top bar */}
            <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-zinc-800/50 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
            
            <div className="flex justify-between items-start mb-6">
              <div 
                className="w-12 h-12 rounded-xl flex items-center justify-center transition-all duration-300"
                style={{ backgroundColor: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.05)' }}
              >
                <DollarSign size={20} style={{ color: accent }} />
              </div>
              
              <div className="flex gap-2">
                <button 
                  onClick={() => startEdit(i)} 
                  className="w-8 h-8 rounded-lg flex items-center justify-center text-zinc-600 hover:text-white hover:bg-zinc-800 transition-all border border-transparent hover:border-zinc-700"
                  title="Edit Rate"
                >
                  <Edit2 size={16} />
                  <span className="sr-only">Edit</span>
                </button>
                <button 
                  onClick={() => deleteRate(i)} 
                  className="w-8 h-8 rounded-lg flex items-center justify-center text-zinc-700 hover:text-red-500 hover:bg-red-950/20 transition-all border border-transparent hover:border-red-900/30"
                  title="Delete Rate"
                >
                  <Trash2 size={16} />
                </button>
              </div>
            </div>

            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <div className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: accent }} />
                <span className="text-[10px] font-black text-zinc-500 uppercase tracking-[0.2em]">{rate.name}</span>
              </div>
              <div className="flex items-baseline gap-1">
                <span className="text-3xl font-black text-white font-mono tracking-tighter">
                  {rate.price}
                </span>
                <span className="text-[11px] font-bold text-zinc-600 uppercase tracking-widest">{rate.unit}</span>
              </div>
            </div>

            <div className="mt-8 pt-6 border-t border-zinc-900/50 flex items-center justify-between">
              <div className="flex flex-col">
                <span className="text-[8px] font-bold text-zinc-700 uppercase tracking-[0.3em] mb-1">Status</span>
                <div className="flex items-center gap-2">
                  <div className="w-1 h-1 rounded-full bg-emerald-500 animate-pulse" />
                  <span className="text-[9px] font-bold text-zinc-400 uppercase tracking-widest">Active Pool</span>
                </div>
              </div>
              
              <div className="h-8 w-24 bg-zinc-950 rounded-lg border border-zinc-900 flex items-center justify-center">
                 <div className="w-full h-1 bg-zinc-900 rounded-full mx-2 overflow-hidden">
                    <motion.div 
                      className="h-full" 
                      style={{ backgroundColor: accent }}
                      initial={{ width: 0 }}
                      animate={{ width: '65%' }}
                    />
                 </div>
              </div>
            </div>

            {/* Accent light effect */}
            <div 
              className="absolute -bottom-1 -right-1 w-24 h-24 blur-[60px] opacity-[0.03] pointer-events-none rounded-full"
              style={{ backgroundColor: accent }}
            />
          </div>
        ))}

        {(!settings.computerRates || settings.computerRates.length === 0) && (
          <div className="col-span-full py-20 flex flex-col items-center justify-center bg-zinc-950/20 border border-dashed border-zinc-800/50 rounded-3xl">
            <DollarSign size={48} className="text-zinc-800 mb-4 opacity-20" />
            <p className="text-zinc-600 font-bold uppercase tracking-[0.3em] text-[10px]">No rates detected in system</p>
          </div>
        )}
      </div>
    </div>
  )
}

export function SocialSection() {
  const { settings, updateSettings } = useStore()
  const [newSocial, setNewSocial] = useState({ name: '', url: '', iconUrl: '' })

  const addSocial = () => {
    if (!newSocial.name || !newSocial.url) return toast.error('Name and URL required')
    const updated = [...(settings.socialLinks || []), { ...newSocial, id: Date.now().toString() }]
    updateSettings({ socialLinks: updated })
    setNewSocial({ name: '', url: '', iconUrl: '' })
    toast.success('Social link added')
  }

  const deleteSocial = (id) => {
    const updated = settings.socialLinks.filter(l => l.id !== id)
    updateSettings({ socialLinks: updated })
    toast.success('Social link removed')
  }

  const updateLink = (id, updates) => {
    const updated = settings.socialLinks.map(l => l.id === id ? { ...l, ...updates } : l)
    updateSettings({ socialLinks: updated })
  }

  return (
    <div className="space-y-8">
      <SectionTitle title="Social & Links" count={settings.socialLinks?.length} />
      
      <Panel title="Add Social Link" subtitle="Connect your community handles">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-6 items-end">
          <Field label="Platform Name">
            <Input 
              value={newSocial.name} 
              onChange={e => setNewSocial(s => ({ ...s, name: e.target.value }))} 
              placeholder="e.g. Discord" 
            />
          </Field>
          <Field label="Link URL">
            <Input 
              value={newSocial.url} 
              onChange={e => setNewSocial(s => ({ ...s, url: e.target.value }))} 
              placeholder="https://..." 
            />
          </Field>
          <Field label="Icon URL">
            <Input 
              value={newSocial.iconUrl || ''} 
              onChange={e => setNewSocial(s => ({ ...s, iconUrl: e.target.value }))} 
              placeholder="https://..." 
              upload
            />
          </Field>
          <PrimaryBtn onClick={addSocial}>Add Link</PrimaryBtn>
        </div>
      </Panel>

      <div className="grid grid-cols-1 gap-6">
        {settings.socialLinks?.map(link => (
          <Panel key={link.id} title={link.name} subtitle="External connection endpoint" 
            action={
              <button onClick={() => deleteSocial(link.id)} className="text-zinc-500 hover:text-red-400 transition-colors">
                <Trash2 size={16} />
              </button>
            }
          >
            <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
              <Field label="Link URL">
                <Input 
                  value={link.url} 
                  onChange={e => updateLink(link.id, { url: e.target.value })} 
                  placeholder="https://..." 
                />
              </Field>
              <Field label="Icon URL">
                <Input 
                  value={link.iconUrl || ''} 
                  onChange={e => updateLink(link.id, { iconUrl: e.target.value })} 
                  placeholder="https://..." 
                  upload
                />
              </Field>
              <Field label="Status">
                <div className="flex items-center gap-4 py-2">
                  <Toggle 
                    checked={!link.disabled} 
                    onChange={v => updateLink(link.id, { disabled: !v })} 
                  />
                  <span className="text-sm font-medium text-zinc-400">
                    {link.disabled ? 'Disabled' : 'Enabled'}
                  </span>
                </div>
              </Field>
            </div>
          </Panel>
        ))}
      </div>
    </div>
  )
}

export function PCGroupsSection() {
  const { settings, updateSettings } = useStore()
  const [newName, setNewName] = useState('')

  const addGroup = () => {
    if (!newName.trim()) return
    const updated = [...(settings.pcGroups || []), { id: Date.now().toString(), name: newName.trim(), pcCount: 0 }]
    updateSettings({ pcGroups: updated })
    setNewName('')
    toast.success('PC Group created')
  }

  const deleteGroup = (id) => {
    const updated = settings.pcGroups.filter(g => g.id !== id)
    updateSettings({ pcGroups: updated })
    toast.success('PC Group removed')
  }

  return (
    <div className="space-y-12">
      <SectionTitle title="Network Topology" count={settings.pcGroups?.length} />
      
      <Panel title="Station Management" subtitle="Define logical groups for networked client machines">
        <div className="flex gap-4 items-end">
          <div className="flex-1">
            <Field label="Designated Group Identifier">
              <Input 
                value={newName} 
                onChange={e => setNewName(e.target.value)} 
                placeholder="e.g. ZONE_BRAVO" 
              />
            </Field>
          </div>
          <PrimaryBtn onClick={addGroup}>Add Groupings</PrimaryBtn>
        </div>
      </Panel>

      <div className="grid grid-cols-1 gap-8">
        {settings.pcGroups?.map(group => (
          <div key={group.id} className="group/group relative bg-[#0A0A0B] border border-zinc-800/50 rounded-2xl p-8 transition-all hover:border-zinc-700/50 shadow-sm">
            <div className="flex flex-col gap-6">
              <div className="flex justify-between items-center">
                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <div className="w-1.5 h-1.5 rounded-full bg-zinc-700 group-hover/group:bg-white transition-colors" />
                    <h4 className="font-bold text-white text-xs tracking-wider uppercase">{group.name}</h4>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="flex items-center gap-1.5 px-3 py-1 bg-zinc-900/50 border border-zinc-800/50 rounded-lg text-[9px] font-black text-zinc-500 uppercase tracking-widest">
                      <Network size={10} />
                      {(group.ips?.length || 0)} Stations
                    </div>
                    <span className="text-[9px] font-black text-zinc-700 uppercase tracking-widest">Active</span>
                  </div>
                </div>
                <button 
                  onClick={() => deleteGroup(group.id)} 
                  className="w-10 h-10 flex items-center justify-center text-zinc-700 hover:text-red-400 hover:bg-red-400/5 rounded-xl border border-transparent hover:border-red-400/10 transition-all"
                >
                  <Trash2 size={16} />
                </button>
              </div>

              <div className="pt-4 border-t border-zinc-900">
                <Field label="Client IP Addresses" hint="Enter IPs separated by commas">
                  <div className="flex gap-2">
                    <Input 
                      value={group.ips?.join(', ') || ''} 
                      onChange={e => {
                        const ips = e.target.value.split(',').map(s => s.trim()).filter(Boolean)
                        const updated = settings.pcGroups.map(g => g.id === group.id ? { ...g, ips } : g)
                        updateSettings({ pcGroups: updated })
                      }} 
                      placeholder="192.168.1.10, 192.168.1.11" 
                    />
                  </div>
                </Field>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export function SettingsSection() {
  const { settings, updateSettings } = useStore()

  return (
    <div className="space-y-8">
      <SectionTitle title="System Settings" />
      
      <Panel title="General" subtitle="Primary launcher identifiers">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
          <Field label="Launcher Name" hint="Displayed on the main screen">
            <Input 
              value={settings.launcherName || ''} 
              onChange={e => updateSettings({ launcherName: e.target.value })} 
              placeholder="e.g. BALOK LOUNGE" 
            />
          </Field>
          <Field label="Launcher Tagline" hint="Secondary brand text">
            <Input 
              value={settings.launcherTagline || ''} 
              onChange={e => updateSettings({ launcherTagline: e.target.value })} 
              placeholder="PLAY. CONNECT. LEVEL UP." 
            />
          </Field>
        </div>
      </Panel>

      <Panel title="Security & Connection" subtitle="Configuration for server and access">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
          <Field label="Admin Password">
            <Input 
              type="password"
              value={settings.secretKey || ''} 
              onChange={e => updateSettings({ secretKey: e.target.value })} 
              placeholder="balok123" 
            />
          </Field>
          <Field label="Save and Load Server" hint="Synchronization endpoint for player progress">
            <Input 
              value={settings.saveLoadServerUrl || ''} 
              onChange={e => updateSettings({ saveLoadServerUrl: e.target.value })} 
              placeholder="Auto-detecting..." 
            />
          </Field>
        </div>
      </Panel>

      <Panel title="Media & Branding" subtitle="Third-party service configuration">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
          <div className="md:col-span-2">
            <Field label="IPTV Playlist URL (.m3u)" hint="Direct link to your television channel list">
              <Input 
                value={settings.iptvLink || ''} 
                onChange={e => updateSettings({ iptvLink: e.target.value })} 
                placeholder="https://example.com/playlist.m3u" 
              />
            </Field>
          </div>
          
          <Field label="IGDB Client ID" hint="Twitch Developer Client ID for game data">
            <Input 
              value={settings.igdbClientId || ''} 
              onChange={e => updateSettings({ igdbClientId: e.target.value })} 
              placeholder="10v1tjvitc8..." 
            />
          </Field>
          <Field label="IGDB Client Secret" hint="Twitch Developer Client Secret">
            <Input 
              type="password"
              value={settings.igdbClientSecret || ''} 
              onChange={e => updateSettings({ igdbClientSecret: e.target.value })} 
              placeholder="••••••••" 
            />
          </Field>

          <Field label="Powered By Text" hint="Brand attribution in footer/sidebars">
            <Input 
              value={settings.poweredBy || ''} 
              onChange={e => updateSettings({ poweredBy: e.target.value })} 
              placeholder="e.g. DENFI SYSTEMS" 
            />
          </Field>
          <div className="flex items-center justify-between p-6 bg-[#0A0A0B] border border-zinc-800/50 rounded-2xl">
            <div>
              <h5 className="text-[10px] font-black text-white uppercase tracking-widest">Show IPTV Tile</h5>
              <p className="text-[10px] text-zinc-500 uppercase font-medium mt-1">Enable TV preview in sidebar</p>
            </div>
            <Toggle 
              checked={!!settings.showIPTV} 
              onChange={v => updateSettings({ showIPTV: v })} 
            />
          </div>
        </div>
      </Panel>

      <Panel title="Behavior" subtitle="Execution parameters">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
          <div className="flex items-center justify-between p-6 bg-[#0A0A0B] border border-zinc-800/50 rounded-2xl">
            <div>
              <h5 className="text-[10px] font-black text-white uppercase tracking-widest">Kiosk Mode</h5>
              <p className="text-[10px] text-zinc-500 uppercase font-medium mt-1">Lock application to full-screen</p>
            </div>
            <Toggle 
              checked={!!settings.kioskMode} 
              onChange={v => updateSettings({ kioskMode: v })} 
            />
          </div>
          <div className="flex items-center justify-between p-6 bg-[#0A0A0B] border border-zinc-800/50 rounded-2xl">
            <div>
              <h5 className="text-[10px] font-black text-white uppercase tracking-widest">Auto-Close</h5>
              <p className="text-[10px] text-zinc-500 uppercase font-medium mt-1">Close launcher when game starts</p>
            </div>
            <Toggle 
              checked={!!settings.autoCloseOnLaunch} 
              onChange={v => updateSettings({ autoCloseOnLaunch: v })} 
            />
          </div>
        </div>
      </Panel>
    </div>
  )
}

export function AppearanceSection() {
  const { settings, updateSettings } = useStore()
  const accent = settings.accentColor || getDefaultAccent()

  return (
    <div className="space-y-8">
      <SectionTitle title="Branding & Design" />
      
      <Panel title="System Colors" subtitle="Manage primary branding colors">
        <div className="space-y-8">
          {/* Accent Color */}
          <div className="flex flex-col md:flex-row items-start md:items-center gap-8">
            <div className="w-20 h-20 rounded-2xl border border-zinc-800 p-2 bg-black shadow-inner flex-shrink-0">
              <div className="w-full h-full rounded-lg" style={{ backgroundColor: accent }} />
            </div>
            <div className="flex-1 space-y-4 w-full">
              <div className="flex justify-between items-center">
                <span className="text-[10px] font-black text-zinc-500 uppercase tracking-[0.2em]">Primary Accent</span>
                <div className="flex gap-2">
                  {['#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899'].map(c => (
                    <button 
                      key={c} 
                      onClick={() => updateSettings({ accentColor: c })}
                      className="w-6 h-6 rounded-md border border-zinc-800 hover:scale-110 hover:border-zinc-400 transition-all"
                      style={{ backgroundColor: c }}
                    />
                  ))}
                </div>
              </div>
              <div className="flex gap-4">
                <div className="flex-1">
                  <Input 
                    value={accent} 
                    onChange={e => updateSettings({ accentColor: e.target.value })} 
                    placeholder="#FF0000" 
                  />
                </div>
                <input 
                  type="color" 
                  value={accent} 
                  onChange={e => updateSettings({ accentColor: e.target.value })}
                  className="w-10 h-10 rounded-lg bg-zinc-900 border border-zinc-800 cursor-pointer overflow-hidden"
                />
              </div>
            </div>
          </div>
        </div>
      </Panel>

      <Panel title="System Assets" subtitle="Customize core interface imagery">
        <div className="grid grid-cols-1 gap-12">
          {/* Logo Field */}
          <div className="flex flex-col md:flex-row gap-8 items-start">
            <div className="relative group w-32 h-32 rounded-3xl bg-black border border-zinc-800 flex-shrink-0 flex items-center justify-center p-4 transition-all hover:border-zinc-700 shadow-2xl">
              {settings.logo ? (
                <img src={settings.logo} alt="" className="max-w-full max-h-full object-contain" />
              ) : (
                <ImageIcon size={32} className="text-zinc-800 group-hover:text-zinc-600 transition-colors" />
              )}
              <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex items-end justify-center pb-2 rounded-3xl">
                <span className="text-[8px] font-black text-white uppercase tracking-widest">Logo Preview</span>
              </div>
            </div>
            
            <div className="flex-1 space-y-3 w-full">
              <div className="flex justify-between items-center px-1">
                <span className="text-[10px] font-black text-zinc-500 uppercase tracking-[0.2em]">Launcher Logo URL</span>
                <span className="text-[9px] font-bold text-zinc-700 uppercase italic">SVG / PNG recommended</span>
              </div>
              <Input 
                value={settings.logo || ''} 
                onChange={e => updateSettings({ logo: e.target.value })} 
                placeholder="https://..." 
                upload
                className="!py-4"
              />
            </div>
          </div>

          {/* Background Field */}
          <div className="flex flex-col md:flex-row gap-8 items-start">
            <div className="relative group w-32 h-32 rounded-3xl bg-black border border-zinc-800 overflow-hidden flex-shrink-0 transition-all hover:border-zinc-700 shadow-2xl">
              {settings.background ? (
                <img src={settings.background} alt="" className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-zinc-800 group-hover:text-zinc-600 transition-colors">
                  <ImageIcon size={32} />
                </div>
              )}
              <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex items-end justify-center pb-2">
                <span className="text-[8px] font-black text-white uppercase tracking-widest">BG Preview</span>
              </div>
            </div>

            <div className="flex-1 space-y-3 w-full">
              <div className="flex justify-between items-center px-1">
                <span className="text-[10px] font-black text-zinc-500 uppercase tracking-[0.2em]">Global Background</span>
                <span className="text-[9px] font-bold text-zinc-700 uppercase italic">High resolution wallpaper</span>
              </div>
              <Input 
                value={settings.background || ''} 
                onChange={e => updateSettings({ background: e.target.value })} 
                placeholder="https://..." 
                upload
                className="!py-4"
              />
            </div>
          </div>

          {/* Hero Banner Field */}
          <div className="flex flex-col md:flex-row gap-8 items-start">
            <div className="relative group w-32 h-32 rounded-3xl bg-black border border-zinc-800 overflow-hidden flex-shrink-0 transition-all hover:border-zinc-700 shadow-2xl">
              {settings.heroBanner ? (
                <img src={settings.heroBanner} alt="" className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-zinc-800 group-hover:text-zinc-600 transition-colors">
                  <ImageIcon size={32} />
                </div>
              )}
              <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex items-end justify-center pb-2">
                <span className="text-[8px] font-black text-white uppercase tracking-widest">Banner Preview</span>
              </div>
            </div>

            <div className="flex-1 space-y-3 w-full">
              <div className="flex justify-between items-center px-1">
                <span className="text-[10px] font-black text-zinc-500 uppercase tracking-[0.2em]">Hero Banner URL</span>
                <span className="text-[9px] font-bold text-zinc-700 uppercase italic">Main featured display image</span>
              </div>
              <Input 
                value={settings.heroBanner || ''} 
                onChange={e => updateSettings({ heroBanner: e.target.value })} 
                placeholder="https://..." 
                upload
                className="!py-4"
              />
            </div>
          </div>
        </div>
      </Panel>
    </div>
  )
}

export function OfficeSection() {
  const { settings, updateSettings } = useStore()
  const [newApp, setNewApp] = useState({ name: '', exePath: '', iconUrl: '', color: 'from-zinc-500 to-zinc-600' })

  const addApp = () => {
    if (!newApp.name) return toast.error('App Name required')
    const updated = [...(settings.officeApps || []), { ...newApp, id: Date.now().toString() }]
    updateSettings({ officeApps: updated })
    setNewApp({ name: '', exePath: '', iconUrl: '', color: 'from-zinc-500 to-zinc-600' })
    toast.success('App added')
  }

  const deleteApp = (id) => {
    const updated = settings.officeApps.filter(a => a.id !== id)
    updateSettings({ officeApps: updated })
    toast.success('App removed')
  }

  const updateApp = (id, updates) => {
    const updated = settings.officeApps.map(a => a.id === id ? { ...a, ...updates } : a)
    updateSettings({ officeApps: updated })
  }

  return (
    <div className="space-y-8">
      <SectionTitle title="Apps & Tools" count={settings.officeApps?.length} />

      <Panel title="Add Application" subtitle="Register utility software to the launcher">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-6 items-end">
          <Field label="App Name">
            <Input 
              value={newApp.name} 
              onChange={e => setNewApp(a => ({ ...a, name: e.target.value }))} 
              placeholder="e.g. Chrome" 
            />
          </Field>
          <Field label="Executable Path">
            <Input 
              value={newApp.exePath} 
              onChange={e => setNewApp(a => ({ ...a, exePath: e.target.value }))} 
              placeholder="C:\..." 
              browse="file"
            />
          </Field>
          <Field label="Icon URL">
            <Input 
              value={newApp.iconUrl || ''} 
              onChange={e => setNewApp(a => ({ ...a, iconUrl: e.target.value }))} 
              placeholder="https://..." 
              upload
            />
          </Field>
          <PrimaryBtn onClick={addApp}>Add App</PrimaryBtn>
        </div>
      </Panel>

      <div className="grid grid-cols-1 gap-6">
        {settings.officeApps?.map(app => (
          <Panel key={app.id} title={app.name} subtitle="Configure utility software"
            action={
              <div className="flex items-center gap-4">
                <div className="w-10 h-10 rounded-lg bg-black border border-zinc-800 overflow-hidden flex items-center justify-center">
                  {app.iconUrl ? (
                    <img src={app.iconUrl} alt="" className="w-full h-full object-cover" />
                  ) : (
                    <ImageIcon size={18} className="text-zinc-700" />
                  )}
                </div>
                <button onClick={() => deleteApp(app.id)} className="text-zinc-500 hover:text-red-400 transition-colors">
                  <Trash2 size={16} />
                </button>
              </div>
            }
          >
            <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
              <Field label="Path to Executable">
                <Input 
                  value={app.exePath || ''} 
                  onChange={e => updateApp(app.id, { exePath: e.target.value })} 
                  placeholder="C:\..." 
                  browse="file"
                />
              </Field>
              <Field label="Icon URL">
                <Input 
                  value={app.iconUrl || ''} 
                  onChange={e => updateApp(app.id, { iconUrl: e.target.value })} 
                  placeholder="https://..." 
                  upload
                />
              </Field>
              <Field label="App Status">
                <div className="flex items-center gap-4 py-2">
                  <Toggle 
                    checked={!app.disabled} 
                    onChange={v => updateApp(app.id, { disabled: !v })} 
                  />
                  <span className="text-sm font-medium text-zinc-400">
                    {app.disabled ? 'Hidden' : 'Visible'}
                  </span>
                </div>
              </Field>
            </div>
          </Panel>
        ))}
      </div>
    </div>
  )
}

export function AnnouncementSection() {
  const { settings, updateSettings } = useStore()

  const addImage = () => {
    const updated = [...(settings.announcementImages || []), '']
    updateSettings({ announcementImages: updated })
  }

  const removeImage = (index) => {
    const updated = settings.announcementImages.filter((_, i) => i !== index)
    updateSettings({ announcementImages: updated })
  }

  const updateImage = (index, val) => {
    const updated = [...settings.announcementImages]
    updated[index] = val
    updateSettings({ announcementImages: updated })
  }

  const getRandomColor = () => {
    const colors = ['#F97316', '#EF4444', '#10B981', '#3B82F6', '#8B5CF6', '#EC4899', '#06B6D4']
    return colors[Math.floor(Math.random() * colors.length)]
  }

  const addNews = () => {
    const newPost = { 
      id: Date.now().toString(), 
      title: 'New Announcement', 
      content: '', 
      date: new Date().toLocaleDateString(),
      color: getRandomColor()
    }
    updateSettings({ announcementsList: [...(settings.announcementsList || []), newPost] })
  }

  const deleteNews = (id) => {
    updateSettings({ announcementsList: settings.announcementsList.filter(n => n.id !== id) })
  }

  const updateNews = (id, updates) => {
    updateSettings({ announcementsList: settings.announcementsList.map(n => n.id === id ? { ...n, ...updates } : n) })
  }

  return (
    <div className="space-y-8">
      <SectionTitle title="News & Announcements" />
      
      <Panel title="Hero Slider" subtitle="Upload images for the main display slider" 
        action={<PrimaryBtn onClick={addImage} noIcon>Add Slide</PrimaryBtn>}>
        <div className="grid grid-cols-1 gap-6">
          {settings.announcementImages?.map((img, i) => (
            <div key={i} className="flex gap-6 items-start">
              {img ? (
                <div className="w-32 h-20 rounded-xl bg-zinc-950 border border-zinc-800 overflow-hidden flex-shrink-0">
                  <img src={img} alt="" className="w-full h-full object-cover" />
                </div>
              ) : (
                <div className="w-32 h-20 rounded-xl bg-zinc-950 border border-zinc-800 flex items-center justify-center flex-shrink-0 text-zinc-800">
                  <ImageIcon size={24} />
                </div>
              )}
              <Field label={`Slide ${i + 1} Image URL`} className="flex-1">
                <Input 
                  value={img} 
                  onChange={e => updateImage(i, e.target.value)} 
                  placeholder="https://..." 
                  upload
                />
              </Field>
              <button onClick={() => removeImage(i)} className="mt-8 text-zinc-500 hover:text-red-400 p-2 bg-zinc-950 border border-zinc-800 rounded-lg transition-colors">
                <Trash2 size={16} />
              </button>
            </div>
          ))}
          <div className="pt-4 border-t border-zinc-800/50">
            <Field label="Slide Interval (Seconds)">
              <Input 
                type="number"
                value={settings.announcementSlideInterval || 5} 
                onChange={e => updateSettings({ announcementSlideInterval: parseInt(e.target.value) || 5 })} 
              />
            </Field>
          </div>
        </div>
      </Panel>


      <Panel title="Announcements List" subtitle="Manage detailed news posts" 
        action={<PrimaryBtn onClick={addNews} noIcon>New Post</PrimaryBtn>}>
        <div className="grid grid-cols-1 gap-6">
          {settings.announcementsList?.map(post => (
            <div key={post.id} className="p-8 rounded-2xl bg-[#0A0A0B] border border-zinc-800/50 space-y-6 shadow-sm">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                <Field label="Title">
                  <Input 
                    value={post.title} 
                    onChange={e => updateNews(post.id, { title: e.target.value })} 
                  />
                </Field>
                <Field label="Date Label">
                  <Input 
                    value={post.date || ''} 
                    onChange={e => updateNews(post.id, { date: e.target.value })} 
                    placeholder="e.g. 15 AUG 2026"
                  />
                </Field>
                <div className="flex gap-4 items-end">
                  <Field label="Accent Color" className="flex-1">
                    <div className="flex gap-3 items-center">
                      <input 
                        type="color" 
                        value={post.color || '#F97316'} 
                        onChange={e => updateNews(post.id, { color: e.target.value })}
                        className="w-10 h-10 rounded-lg bg-zinc-900 border border-zinc-800 cursor-pointer overflow-hidden"
                      />
                      <Input 
                        value={post.color || '#F97316'} 
                        onChange={e => updateNews(post.id, { color: e.target.value })}
                        placeholder="#HEX"
                        className="flex-1"
                      />
                    </div>
                  </Field>
                  <button onClick={() => deleteNews(post.id)} className="w-10 h-10 flex items-center justify-center text-zinc-600 hover:text-red-400 bg-zinc-900 border border-zinc-800 rounded-lg transition-colors mb-[2px]">
                    <Trash2 size={16} />
                  </button>
                </div>
              </div>
              <Field label="Content">
                <textarea 
                  className="w-full bg-black border border-zinc-800 rounded-2xl p-4 text-sm text-white focus:outline-none focus:border-zinc-700 focus:ring-1 focus:ring-zinc-700/50 transition-all min-h-[140px] placeholder:text-zinc-800 font-medium"
                  value={post.content || ''}
                  onChange={e => updateNews(post.id, { content: e.target.value })}
                  placeholder="Write your announcement content here..."
                />
              </Field>
            </div>
          ))}
        </div>
      </Panel>
    </div>
  )
}

export function BackupSection() {
  const { games, settings, importState } = useStore()
  const [isExporting, setIsExporting] = useState(false)
  const [isImporting, setIsImporting] = useState(false)
  const importInputRef = useRef(null)

  const exportData = async () => {
    setIsExporting(true)
    const toastId = toast.loading('Preparing backup package...')
    
    try {
      // Use Electron IPC if available for a more robust backup (handles local filesystem)
      if (window.electronAPI?.backupExport) {
        const result = await window.electronAPI.backupExport()
        if (result.success) {
          toast.success(`Complete backup (${result.brand}.zip) exported to ${result.filePath}`, { id: toastId })
        } else if (!result.canceled) {
          throw new Error(result.error || 'Export failed')
        } else {
          toast('Backup export canceled', { id: toastId })
        }
        return
      }

      // Web Fallback: Generate ZIP in the browser
      const zip = new JSZip()
      const brandName = settings.launcherName || 'Balok'
      const cleanBrandName = brandName.replace(/[^a-z0-9]/gi, '_').toLowerCase()
      
      const data = JSON.stringify({ games, settings }, null, 2)
      zip.file(`${cleanBrandName}-data.json`, data)
      zip.file(`backup.json`, data)

      const assetsFolder = zip.folder("assets")
      const assetPromises = []

      const addAssetToZip = async (url) => {
        if (!url || url.startsWith('http') || url.startsWith('/api/') || url.startsWith('data:')) return
        try {
          const fileName = url.split('/').pop()
          // Ensure we don't try to fetch a path that isn't accessible or is already just a filename
          // In web preview, we usually only have blob URLs or API URLs which are filtered above.
          // In Electron, we might have file paths.
          const response = await fetch(url)
          if (response.ok) {
            const blob = await response.blob()
            assetsFolder.file(fileName, blob)
          }
        } catch (e) {
          console.warn(`Failed to include asset ${url} in backup:`, e)
        }
      }

      const localAssets = new Set()
      if (settings.background) localAssets.add(settings.background)
      if (settings.logo) localAssets.add(settings.logo)
      if (settings.bannerImage) localAssets.add(settings.bannerImage)
      if (settings.panelBanner) localAssets.add(settings.panelBanner)
      
      games.forEach(g => {
        if (g.icon) localAssets.add(g.icon)
        if (g.bannerImage) localAssets.add(g.bannerImage)
      })

      for (const assetPath of localAssets) {
        assetPromises.push(addAssetToZip(assetPath))
      }

      await Promise.all(assetPromises)
      
      const content = await zip.generateAsync({ type: 'blob' })
      const url = URL.createObjectURL(content)
      const a = document.createElement('a')
      a.href = url
      a.download = `${cleanBrandName}-backup-${new Date().toISOString().split('T')[0]}.zip`
      a.click()
      
      toast.success(`Complete backup (${cleanBrandName}.zip) exported`, { id: toastId })
    } catch (err) {
      console.error(err)
      toast.error('Failed to create backup package: ' + err.message, { id: toastId })
    } finally {
      setIsExporting(false)
    }
  }

  const handleImport = async (e) => {
    const hasElectronImport = typeof window !== 'undefined' && Boolean(window.electronAPI?.backupImport)
    const file = !hasElectronImport ? e?.target?.files?.[0] : null
    if (!hasElectronImport && !file) return
    
    setIsImporting(true)
    const toastId = toast.loading('Processing backup...')
    
    try {
      // Use Electron IPC if available
      if (hasElectronImport) {
        const result = await window.electronAPI.backupImport()
        if (result.success) {
          importState(result.games, result.settings)
          toast.success(`System restored: ${result.gameCount} games and ${result.assetCount} assets imported`, { id: toastId })
        } else if (!result.canceled) {
          throw new Error(result.error || 'Import failed')
        } else {
          toast('Backup import canceled', { id: toastId })
        }
        setIsImporting(false)
        if (e && e.target) e.target.value = ''
        return
      }

      if (file.name.endsWith('.zip')) {
        const zip = await JSZip.loadAsync(file)
        
        // Search for any JSON file in the archive, prioritizing common names
        const allFiles = Object.keys(zip.files)
        const jsonFiles = allFiles.filter(name => name.endsWith('.json') && !name.includes('/'))
        
        let jsonFile = null
        if (jsonFiles.length > 0) {
          // Priority: 1. data.json variants, 2. backup.json, 3. settings.json, 4. anything else
          jsonFile = zip.file(jsonFiles.find(n => n.includes('data.json'))) || 
                     zip.file("backup.json") || 
                     zip.file("settings.json") || 
                     zip.file(jsonFiles[0])
        }
        
        if (!jsonFile) throw new Error("Invalid backup: Missing data JSON file in archive")
        
        const content = await jsonFile.async("string")
        const parsed = JSON.parse(content)
        
        // 3. Extract assets if they exist
        const assetsFolder = zip.folder("assets")
        const assetMap = {}
        if (assetsFolder) {
          const assetFiles = Object.keys(zip.files).filter(name => name.startsWith('assets/') && !zip.files[name].dir)
          
          for (const assetPath of assetFiles) {
            const fileName = assetPath.split('/').pop()
            const assetData = await zip.files[assetPath].async("blob")
            
            // In browser preview, use Object URL
            assetMap[fileName] = URL.createObjectURL(assetData)
          }
        }

        // 4. Handle different possible structures (standard: {games, settings}, or nested in {state: {games, settings}})
        let g = parsed.games || (parsed.state && parsed.state.games)
        let s = parsed.settings || (parsed.state && parsed.state.settings)
        
        if (!g && !s && Array.isArray(parsed.state?.games)) {
          g = parsed.state.games
          s = parsed.state.settings
        }
        
        if (!g && !s) {
           throw new Error("Invalid backup: Could not find games or settings data")
        }
        
        importState(g, s, assetMap)
        toast.success(`System restored: ${g?.length || 0} games and ${Object.keys(assetMap).length} assets imported`, { id: toastId })
      } else if (file.name.endsWith('.json')) {
        const reader = new FileReader()
        reader.onload = (ev) => {
          try {
            const parsed = JSON.parse(ev.target.result)
            let g = parsed.games || (parsed.state && parsed.state.games)
            let s = parsed.settings || (parsed.state && parsed.state.settings)
            
            if (!g && !s) throw new Error("Could not find data in JSON")
            
            importState(g, s)
            toast.success(`Imported ${g?.length || 0} games successfully`, { id: toastId })
          } catch (err) {
            toast.error('Invalid backup file: ' + err.message, { id: toastId })
          }
        }
        reader.readAsText(file)
      } else {
        toast.error('Unsupported file format', { id: toastId })
      }
    } catch (err) {
      console.error(err)
      toast.error(err.message || 'Import failed', { id: toastId })
    } finally {
      setIsImporting(false)
      if (e && e.target) e.target.value = ''
    }
  }

  return (
    <div className="space-y-8">
      <SectionTitle title="System Persistence" />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
        <Panel 
          title="Full Archive" 
          subtitle="Generate a compressed .zip package containing all library data and configuration"
        >
          <PrimaryBtn 
            onClick={exportData} 
            disabled={isExporting}
            className="w-full md:w-auto"
          >
            {isExporting ? 'Packaging...' : 'Generate Backup (.zip)'}
          </PrimaryBtn>
        </Panel>
        
        <Panel 
          title="Restore System" 
          subtitle="Restore your launcher from a .zip package or legacy .json file"
        >
          <PrimaryBtn 
            onClick={() => {
              if (window.electronAPI?.backupImport) {
                handleImport()
              } else {
                importInputRef.current?.click()
              }
            }}
            disabled={isImporting}
            className="w-full md:w-auto"
          >
            {isImporting ? 'Restoring...' : 'Restore from Backup'}
          </PrimaryBtn>
          <input 
            type="file" 
            ref={importInputRef}
            onChange={handleImport}
            accept=".zip,.json"
            className="hidden"
          />
        </Panel>
      </div>
    </div>
  )
}

export function FeaturedSection() {
  const { games, updateGame } = useStore()
  const [search, setSearch] = useState('')
  const featured = games.filter(g => g.isFeatured)
  const filteredGames = games.filter(g => g.name.toLowerCase().includes(search.toLowerCase()))

  return (
    <div className="space-y-12">
      <SectionTitle title="Featured Strategy" count={featured.length} />
      <Panel title="Active Shelf" subtitle="Select and rank titles for the high-priority hero banner">
        <div className="space-y-6">
          {/* Search Bar */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" size={16} />
            <input
              type="text"
              placeholder="Search library..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full bg-zinc-950 border border-zinc-800 rounded-lg pl-10 pr-4 py-2.5 text-sm text-white focus:outline-none focus:border-orange-500/50 transition-colors"
            />
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
            {filteredGames.map(g => {
              const isSelected = g.isFeatured;
              return (
                <div
                  key={g.id}
                  onClick={() => updateGame(g.id, { isFeatured: !isSelected, topPickRank: isSelected ? null : null })}
                  className={`
                    flex flex-col items-center text-center p-3 rounded-xl border transition-all relative group cursor-pointer
                    ${isSelected 
                      ? 'bg-orange-500/10 border-orange-500/50 ring-1 ring-orange-500/20' 
                      : 'bg-zinc-900/50 border-zinc-800/50 hover:border-zinc-600'}
                  `}
                >
                  {/* Game Icon */}
                  <div className="w-16 h-16 rounded-xl bg-zinc-950 border border-zinc-800 overflow-hidden mb-3 group-hover:scale-105 transition-transform">
                    {g.icon ? (
                      <img src={g.icon} alt="" className="w-full h-full object-cover" />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-zinc-800">
                        <Palette size={24} />
                      </div>
                    )}
                  </div>

                  <div className="w-full">
                    <span className={`text-[10px] font-bold uppercase tracking-wider truncate block ${isSelected ? 'text-orange-400' : 'text-zinc-400'}`}>
                      {g.name}
                    </span>
                    {isSelected && (
                      <div className="mt-1 flex justify-center">
                        <div className="w-1 h-1 rounded-full bg-orange-500 animate-pulse" />
                      </div>
                    )}
                  </div>
                  
                  {isSelected && g.topPickRank && (
                    <div className="absolute top-2 right-2 w-5 h-5 bg-orange-500 text-black text-[10px] font-black flex items-center justify-center rounded-full shadow-lg">
                      {g.topPickRank}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div className="space-y-3">
            <h5 className="text-[10px] font-bold text-zinc-500 uppercase tracking-[0.2em] px-1">Active Rotation (Top 8)</h5>
            <div className="grid grid-cols-1 gap-3">
              {featured.length === 0 ? (
                <p className="text-zinc-500 text-[10px] font-bold uppercase tracking-widest p-4 bg-zinc-950/20 border border-dashed border-zinc-800/50 rounded-lg text-center">
                  No games are currently featured.
                </p>
              ) : (
                featured.sort((a, b) => (a.topPickRank || 99) - (b.topPickRank || 99)).map((g, i) => (
                  <div key={g.id} className="group/featured relative overflow-hidden p-4 rounded-xl bg-zinc-900/40 border border-zinc-800/50 hover:border-zinc-700 transition-all flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
                    <div className="flex items-center gap-4 min-w-0 w-full md:w-auto">
                      <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-black border border-zinc-800 flex-shrink-0">
                        <span className="text-[10px] font-black text-orange-500">{i + 1}</span>
                      </div>
                      
                      {/* Icon in list */}
                      <div className="w-12 h-12 rounded-lg bg-black border border-zinc-800 overflow-hidden flex-shrink-0">
                        {g.icon ? (
                          <img src={g.icon} alt="" className="w-full h-full object-cover" />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center text-zinc-800">
                            <Palette size={20} />
                          </div>
                        )}
                      </div>

                      <div className="flex-1 min-w-0">
                        <span className="font-bold text-white text-xs uppercase tracking-wider truncate block">{g.name}</span>
                        <span className="text-[9px] font-bold text-zinc-600 uppercase tracking-widest block mt-0.5">{g.category || 'General'}</span>
                      </div>
                    </div>
                    
                    <div className="flex items-center gap-4 w-full md:w-auto mt-2 md:mt-0 pt-3 md:pt-0 border-t border-zinc-800 md:border-t-0">
                      <div className="flex items-center gap-1.5 p-1 bg-black rounded-lg border border-zinc-800">
                        {[1, 2, 3].map(rank => (
                          <button
                            key={rank}
                            onClick={() => updateGame(g.id, { topPickRank: g.topPickRank === rank ? null : rank })}
                            className={`
                              w-10 h-8 flex items-center justify-center text-[10px] font-black rounded-md transition-all
                              ${g.topPickRank === rank 
                                ? 'bg-orange-500 text-black shadow-[0_0_15px_rgba(249,115,22,0.4)]' 
                                : 'bg-zinc-900 text-zinc-500 hover:text-white hover:bg-zinc-800'}
                            `}
                          >
                            {rank}{rank === 1 ? 'ST' : rank === 2 ? 'ND' : 'RD'}
                          </button>
                        ))}
                      </div>

                      <button 
                        onClick={() => updateGame(g.id, { isFeatured: false, topPickRank: null })} 
                        className="px-4 py-2 text-[10px] font-bold uppercase tracking-widest text-zinc-500 hover:text-red-400 hover:bg-red-400/5 rounded-lg border border-zinc-800 hover:border-red-400/20 transition-all"
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </Panel>
    </div>
  )
}

export function EventsSection() {
  const { settings, updateSettings } = useStore()

  const getRandomColor = () => {
    const colors = ['#F97316', '#EF4444', '#10B981', '#3B82F6', '#8B5CF6', '#EC4899', '#06B6D4']
    return colors[Math.floor(Math.random() * colors.length)]
  }

  const addEvent = () => {
    const newEvent = { 
      id: Date.now().toString(), 
      title: 'New Event', 
      date: new Date().toISOString().split('T')[0], 
      dateLabel: new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase(),
      description: '',
      color: getRandomColor()
    }
    updateSettings({ upcomingEventsList: [...(settings.upcomingEventsList || []), newEvent] })
  }

  const deleteEvent = (id) => {
    updateSettings({ upcomingEventsList: settings.upcomingEventsList.filter(e => e.id !== id) })
  }

  const updateEvent = (id, updates) => {
    updateSettings({ upcomingEventsList: settings.upcomingEventsList.map(e => e.id === id ? { ...e, ...updates } : e) })
  }

  return (
    <div className="space-y-8">
      <SectionTitle title="Upcoming Events" count={settings.upcomingEventsList?.length} />
      <Panel title="Schedule" subtitle="Manage cafe events" action={<PrimaryBtn onClick={addEvent} noIcon>New Event</PrimaryBtn>}>
        <div className="grid grid-cols-1 gap-6">
          {(!settings.upcomingEventsList || settings.upcomingEventsList.length === 0) && (
            <div className="p-8 text-center rounded-xl border border-dashed border-zinc-800 text-zinc-500 text-sm">
              No events scheduled yet.
            </div>
          )}
          {settings.upcomingEventsList?.map(event => (
            <div key={event.id} className="p-6 rounded-2xl border border-zinc-800/50 bg-black space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                <Field label="Event Title">
                  <Input value={event.title} onChange={e => updateEvent(event.id, { title: e.target.value })} />
                </Field>
                <Field label="Date Label">
                  <Input 
                    value={event.dateLabel || event.date || ''} 
                    onChange={e => updateEvent(event.id, { dateLabel: e.target.value })} 
                    placeholder="e.g. 20 AUG 2026"
                  />
                </Field>
                <div className="flex gap-4 items-end">
                  <Field label="Accent Color" className="flex-1">
                    <div className="flex gap-3 items-center">
                      <input 
                        type="color" 
                        value={event.color || '#F97316'} 
                        onChange={e => updateEvent(event.id, { color: e.target.value })}
                        className="w-10 h-10 rounded-lg bg-zinc-900 border border-zinc-800 cursor-pointer overflow-hidden"
                      />
                      <Input 
                        value={event.color || '#F97316'} 
                        onChange={e => updateEvent(event.id, { color: e.target.value })}
                        placeholder="#HEX"
                        className="flex-1"
                      />
                    </div>
                  </Field>
                  <button onClick={() => deleteEvent(event.id)} className="w-10 h-10 flex items-center justify-center text-zinc-600 hover:text-red-400 bg-zinc-900 border border-zinc-800 rounded-lg transition-colors mb-[2px]">
                    <Trash2 size={16} />
                  </button>
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Field label="System Date (Sort Order)">
                  <Input type="date" value={event.date} onChange={e => updateEvent(event.id, { date: e.target.value })} />
                </Field>
                <Field label="Description">
                  <Input value={event.description} onChange={e => updateEvent(event.id, { description: e.target.value })} placeholder="Details about the event..." />
                </Field>
              </div>
            </div>
          ))}
        </div>
      </Panel>
    </div>
  )
}

export function NotificationsSection() {
  const { settings, updateSettings } = useStore()
  const [newPc, setNewPc] = useState({ name: '', ip: '' })
  const pcMappings = Array.isArray(settings.pcMappings) ? settings.pcMappings : []

  const addPcMapping = () => {
    const name = newPc.name.trim()
    const ip = newPc.ip.trim()
    if (!name || !ip) return toast.error('Enter both a PC name and IP address')
    if (pcMappings.some(entry => String(entry.ip || '').trim() === ip)) {
      return toast.error('That IP address already has a PC name')
    }
    updateSettings({ pcMappings: [...pcMappings, { name, ip }] })
    setNewPc({ name: '', ip: '' })
  }

  const updatePcMapping = (index, field, value) => {
    updateSettings({
      pcMappings: pcMappings.map((entry, entryIndex) =>
        entryIndex === index ? { ...entry, [field]: value } : entry
      ),
    })
  }

  return (
    <div className="space-y-8">
      <SectionTitle title="Game Launch Alerts" />

      <Panel title="Telegram Connection" subtitle="Sends game-open alerts directly from this BALOK launcher">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <Field label="Telegram Bot Token" hint="From @BotFather. Stored on this computer only.">
            <Input
              type="password"
              value={settings.telegramBotToken || ''}
              onChange={e => updateSettings({ telegramBotToken: e.target.value.trim() })}
              placeholder="123456:ABC-DEF..."
              autoComplete="off"
            />
          </Field>
          <Field label="Telegram Chat ID" hint="Your private chat, group, or channel chat ID.">
            <Input
              value={settings.telegramChatId || ''}
              onChange={e => updateSettings({ telegramChatId: e.target.value.trim() })}
              placeholder="-1001234567890"
              autoComplete="off"
            />
          </Field>
        </div>
      </Panel>

      <Panel title="PC Name & IP Map" subtitle="The launcher matches its detected local IP to the PC name below">
        <div className="grid grid-cols-1 md:grid-cols-[1fr_1fr_auto] gap-3 items-end">
          <Field label="PC Name">
            <Input value={newPc.name} onChange={e => setNewPc({ ...newPc, name: e.target.value })} placeholder="PC 1" />
          </Field>
          <Field label="IP Address">
            <Input value={newPc.ip} onChange={e => setNewPc({ ...newPc, ip: e.target.value })} placeholder="10.10.10.1" />
          </Field>
          <PrimaryBtn onClick={addPcMapping} className="h-[42px]">
            <Plus size={15} /> Add PC
          </PrimaryBtn>
        </div>

        <div className="mt-5 space-y-2">
          {pcMappings.length === 0 ? (
            <p className="rounded-xl border border-dashed border-zinc-800 px-4 py-3 text-xs text-zinc-500">
              Add every diskless PC here. When a game opens, this launcher uses the name assigned to its current IP.
            </p>
          ) : pcMappings.map((entry, index) => (
            <div key={`${entry.ip || 'pc'}-${index}`} className="grid grid-cols-1 md:grid-cols-[1fr_1fr_auto] gap-3 items-center rounded-xl border border-zinc-800/60 bg-[#0A0A0B] p-3">
              <Input value={entry.name || ''} onChange={e => updatePcMapping(index, 'name', e.target.value)} placeholder="PC 1" />
              <Input value={entry.ip || ''} onChange={e => updatePcMapping(index, 'ip', e.target.value)} placeholder="10.10.10.1" />
              <button
                type="button"
                onClick={() => updateSettings({ pcMappings: pcMappings.filter((_, entryIndex) => entryIndex !== index) })}
                className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-red-900/40 text-red-400 transition-colors hover:bg-red-950/40"
                title={`Delete ${entry.name || 'PC mapping'}`}
              >
                <Trash2 size={15} />
              </button>
            </div>
          ))}
        </div>
        <p className="mt-4 text-xs text-zinc-500">
          Game alerts go directly to Telegram. The message uses the matching PC name and includes the detected local IP. No monitor server, heartbeat, or PC-status alert is used.
        </p>
      </Panel>

      {/* Master notification toggle */}
      <Panel title="Alert Preferences" subtitle="Only game launches can trigger Telegram alerts">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="flex items-center justify-between p-5 bg-[#0A0A0B] border border-zinc-800/50 rounded-2xl">
            <div>
              <h5 className="text-[10px] font-black text-white uppercase tracking-widest">Enable Notifications</h5>
              <p className="text-[10px] text-zinc-500 uppercase font-medium mt-1">Master toggle — does not affect OTA updates</p>
            </div>
            <Toggle
              checked={settings.notificationEnabled !== false}
              onChange={v => updateSettings({ notificationEnabled: !!v })}
            />
          </div>
          <div className="flex items-center justify-between p-5 bg-[#0A0A0B] border border-zinc-800/50 rounded-2xl">
            <div>
              <h5 className="text-[10px] font-black text-white uppercase tracking-widest">Game Launch Alerts</h5>
              <p className="text-[10px] text-zinc-500 uppercase font-medium mt-1">Alert when a game is started</p>
            </div>
            <Toggle
              checked={settings.notifyGameLaunches !== false}
              onChange={v => updateSettings({ notifyGameLaunches: !!v })}
              disabled={settings.notificationEnabled === false}
            />
          </div>
        </div>
      </Panel>
    </div>
  )
}
