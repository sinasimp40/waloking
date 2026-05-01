import React, { useState, useEffect, useCallback } from 'react'
import { X, LogIn, UserPlus, Download, Upload, Trash2, HardDrive, Clock, FileArchive, User, Lock, Server, RefreshCw, LogOut, Search, Shield, Wifi, WifiOff, ChevronRight, Database, CloudUpload, CloudDownload, AlertTriangle, Eye, EyeOff } from 'lucide-react'
import toast from 'react-hot-toast'
import useStore from '../store/useStore'
import { getDefaultAccent } from '../lib/accent'

export default function SaveLoadModal({ onClose }) {
  const settings = useStore(s => s.settings)
  const games = useStore(s => s.games)
  const accentColor = settings.accentColor || getDefaultAccent()
  const serverUrl = settings.saveLoadServerUrl || ''

  const [authToken, setAuthToken] = useState(() => sessionStorage.getItem('example-cafe-sl-token') || '')
  const [username, setUsername] = useState(() => sessionStorage.getItem('example-cafe-sl-user') || '')
  const [authView, setAuthView] = useState('login')
  const [loginUser, setLoginUser] = useState('')
  const [loginPass, setLoginPass] = useState('')
  const [regUser, setRegUser] = useState('')
  const [regPass, setRegPass] = useState('')
  const [regConfirm, setRegConfirm] = useState('')
  const [loading, setLoading] = useState(false)
  const [saves, setSaves] = useState([])
  const [savesLoading, setSavesLoading] = useState(false)
  const [uploadingGame, setUploadingGame] = useState(null)
  const [downloadingId, setDownloadingId] = useState(null)
  const [searchGames, setSearchGames] = useState('')
  const [searchSaves, setSearchSaves] = useState('')
  const [activeTab, setActiveTab] = useState('save')
  const [showPass, setShowPass] = useState(false)
  const [serverOnline, setServerOnline] = useState(null)

  const isLoggedIn = !!authToken
  const apiUrl = serverUrl.replace(/\/+$/, '')

  useEffect(() => {
    if (!apiUrl) return
    let cancelled = false
    fetch(`${apiUrl}/api/status`).then(r => r.ok ? r.json() : Promise.reject())
      .then(() => { if (!cancelled) setServerOnline(true) })
      .catch(() => { if (!cancelled) setServerOnline(false) })
    return () => { cancelled = true }
  }, [apiUrl])

  const apiFetch = useCallback(async (path, options = {}) => {
    const headers = { ...options.headers }
    if (authToken) headers['Authorization'] = `Bearer ${authToken}`
    if (!(options.body instanceof FormData)) {
      headers['Content-Type'] = 'application/json'
    }
    const res = await fetch(`${apiUrl}${path}`, { ...options, headers })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'Request failed')
    return data
  }, [apiUrl, authToken])

  const fetchSaves = useCallback(async () => {
    if (!authToken || !apiUrl) return
    setSavesLoading(true)
    try {
      const data = await apiFetch('/api/saves')
      setSaves(data.saves || [])
    } catch (err) {
      toast.error('Failed to fetch saves: ' + err.message)
    } finally {
      setSavesLoading(false)
    }
  }, [authToken, apiUrl, apiFetch])

  useEffect(() => {
    if (isLoggedIn) fetchSaves()
  }, [isLoggedIn, fetchSaves])

  const handleLogin = async () => {
    if (!loginUser.trim() || !loginPass.trim()) return toast.error('Fill in all fields')
    if (!apiUrl) return toast.error('Server URL not configured')
    setLoading(true)
    try {
      const data = await apiFetch('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username: loginUser, password: loginPass })
      })
      setAuthToken(data.token)
      setUsername(data.user.username)
      sessionStorage.setItem('example-cafe-sl-token', data.token)
      sessionStorage.setItem('example-cafe-sl-user', data.user.username)
      toast.success(`Welcome back, ${data.user.username}!`)
      setLoginUser('')
      setLoginPass('')
    } catch (err) {
      toast.error(err.message)
    } finally {
      setLoading(false)
    }
  }

  const handleRegister = async () => {
    if (!regUser.trim() || !regPass.trim()) return toast.error('Fill in all fields')
    if (regPass !== regConfirm) return toast.error('Passwords do not match')
    if (regPass.length < 4) return toast.error('Password must be at least 4 characters')
    if (!apiUrl) return toast.error('Server URL not configured')
    setLoading(true)
    try {
      const data = await apiFetch('/api/auth/register', {
        method: 'POST',
        body: JSON.stringify({ username: regUser, password: regPass })
      })
      setAuthToken(data.token)
      setUsername(data.user.username)
      sessionStorage.setItem('example-cafe-sl-token', data.token)
      sessionStorage.setItem('example-cafe-sl-user', data.user.username)
      toast.success('Account created!')
      setRegUser('')
      setRegPass('')
      setRegConfirm('')
    } catch (err) {
      toast.error(err.message)
    } finally {
      setLoading(false)
    }
  }

  const handleLogout = () => {
    setAuthToken('')
    setUsername('')
    sessionStorage.removeItem('example-cafe-sl-token')
    sessionStorage.removeItem('example-cafe-sl-user')
    setSaves([])
    toast.success('Logged out')
  }

  const handleSave = async (game) => {
    if (!game.savePath) {
      return toast.error(`No save path set for ${game.name}`)
    }
    const existingSave = saves.find(s => s.game_name === game.name)
    if (existingSave) {
      const confirmed = window.confirm(`Replace existing save for "${game.name}"?`)
      if (!confirmed) return
    }
    setUploadingGame(game.id)
    try {
      if (window.electronAPI?.zipAndUploadSave) {
        const result = await window.electronAPI.zipAndUploadSave(game.savePath, game.name, apiUrl, authToken)
        if (result.success) {
          toast.success(`${game.name} save uploaded!`)
          fetchSaves()
        } else {
          toast.error(result.error || 'Upload failed')
        }
      } else {
        toast.error('Save upload requires the desktop app')
      }
    } catch (err) {
      toast.error('Save failed: ' + err.message)
    } finally {
      setUploadingGame(null)
    }
  }

  const handleLoad = async (save) => {
    const game = games.find(g => g.name === save.game_name)
    if (!game?.savePath) {
      return toast.error(`No save path configured for ${save.game_name}`)
    }
    setDownloadingId(save.id)
    try {
      if (window.electronAPI?.downloadAndExtractSave) {
        const result = await window.electronAPI.downloadAndExtractSave(save.id, game.savePath, apiUrl, authToken)
        if (result.success) {
          toast.success(`${save.game_name} save restored!`)
        } else {
          toast.error(result.error || 'Download failed')
        }
      } else {
        toast.error('Save download requires the desktop app')
      }
    } catch (err) {
      toast.error('Load failed: ' + err.message)
    } finally {
      setDownloadingId(null)
    }
  }

  const handleDelete = async (save) => {
    if (!window.confirm(`Delete save for "${save.game_name}"? This cannot be undone.`)) return
    try {
      await apiFetch(`/api/saves/${save.id}`, { method: 'DELETE' })
      toast.success('Save deleted')
      fetchSaves()
    } catch (err) {
      toast.error('Delete failed: ' + err.message)
    }
  }

  const formatSize = (bytes) => {
    if (!bytes) return '0 B'
    const mb = bytes / (1024 * 1024)
    if (mb >= 1) return mb.toFixed(1) + ' MB'
    return (bytes / 1024).toFixed(0) + ' KB'
  }

  const formatDate = (d) => {
    if (!d) return '-'
    return new Date(d + 'Z').toLocaleString()
  }

  const gamesWithSavePath = games.filter(g => g.savePath)
  const filteredGames = searchGames
    ? gamesWithSavePath.filter(g => g.name.toLowerCase().includes(searchGames.toLowerCase()))
    : gamesWithSavePath
  const filteredSaves = searchSaves
    ? saves.filter(s => s.game_name.toLowerCase().includes(searchSaves.toLowerCase()))
    : saves

  const inputClass = `w-full pl-10 pr-3 py-3 bg-black/40 border border-white/[0.08] rounded-lg text-white text-sm font-rajdhani focus:outline-none focus:border-[${accentColor}]/50 transition-colors placeholder:text-white/20`

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ backgroundColor: 'rgba(0,0,0,0.92)' }}>
      <div
        className="relative w-full max-w-[480px] max-h-[88vh] overflow-hidden flex flex-col"
        style={{
          background: 'linear-gradient(180deg, rgba(18,18,22,0.98) 0%, rgba(10,10,14,0.99) 100%)',
          borderRadius: '16px',
          border: `1px solid ${accentColor}15`,
        }}
      >
        <div className="absolute top-0 left-0 right-0 h-[1px]" style={{ background: `linear-gradient(90deg, transparent 0%, ${accentColor} 50%, transparent 100%)`, opacity: 0.6 }} />
        <div className="absolute bottom-0 left-0 right-0 h-[1px]" style={{ background: `linear-gradient(90deg, transparent 0%, ${accentColor} 50%, transparent 100%)`, opacity: 0.15 }} />
        <div className="absolute top-0 left-0 bottom-0 w-[1px]" style={{ background: `linear-gradient(180deg, ${accentColor}40 0%, transparent 50%)` }} />
        <div className="absolute top-0 right-0 bottom-0 w-[1px]" style={{ background: `linear-gradient(180deg, ${accentColor}40 0%, transparent 50%)` }} />

        <div className="absolute top-0 left-0 w-[60px] h-[60px] pointer-events-none" style={{ borderTop: `2px solid ${accentColor}60`, borderLeft: `2px solid ${accentColor}60`, borderRadius: '16px 0 0 0' }} />
        <div className="absolute top-0 right-0 w-[60px] h-[60px] pointer-events-none" style={{ borderTop: `2px solid ${accentColor}60`, borderRight: `2px solid ${accentColor}60`, borderRadius: '0 16px 0 0' }} />

        <div className="flex items-center justify-between px-6 py-4 flex-shrink-0 relative">
          <div className="flex items-center gap-3">
            <div className="relative w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: `linear-gradient(135deg, ${accentColor}20, ${accentColor}05)`, border: `1px solid ${accentColor}30` }}>
              <Database size={18} style={{ color: accentColor }} />
              <div className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2" style={{
                borderColor: 'rgb(18,18,22)',
                backgroundColor: serverOnline === true ? '#22c55e' : serverOnline === false ? '#ef4444' : '#6b7280',
              }} />
            </div>
            <div>
              <h2 className="font-orbitron font-bold text-base tracking-[0.2em]" style={{ color: accentColor, textShadow: `0 0 20px ${accentColor}30` }}>SAVE & LOAD</h2>
              <div className="flex items-center gap-2 mt-0.5">
                {serverOnline === true && <span className="font-rajdhani text-[10px] text-emerald-400/70 uppercase tracking-wider flex items-center gap-1"><Wifi size={8} />Server Online</span>}
                {serverOnline === false && <span className="font-rajdhani text-[10px] text-red-400/70 uppercase tracking-wider flex items-center gap-1"><WifiOff size={8} />Server Offline</span>}
                {serverOnline === null && !apiUrl && <span className="font-rajdhani text-[10px] text-white/30 uppercase tracking-wider">Not Configured</span>}
                {isLoggedIn && (
                  <span className="font-rajdhani text-[10px] text-white/40 uppercase tracking-wider flex items-center gap-1">
                    <span style={{ color: `${accentColor}80` }}>|</span>
                    <User size={8} className="text-white/30" />{username}
                  </span>
                )}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1">
            {isLoggedIn && (
              <button onClick={handleLogout} className="p-2.5 rounded-lg transition-colors hover:bg-white/5 group" title="Logout">
                <LogOut size={15} className="text-white/30 group-hover:text-red-400 transition-colors" />
              </button>
            )}
            <button onClick={onClose} className="p-2.5 rounded-lg transition-colors hover:bg-white/5 group" title="Close">
              <X size={15} className="text-white/30 group-hover:text-white transition-colors" />
            </button>
          </div>
        </div>

        <div className="h-[1px] mx-6" style={{ background: `linear-gradient(90deg, transparent, ${accentColor}15, transparent)` }} />

        <div className="flex-1 overflow-y-auto min-h-0">
          {!apiUrl ? (
            <div className="flex flex-col items-center justify-center py-16 px-6">
              <div className="w-20 h-20 rounded-2xl flex items-center justify-center mb-6" style={{ background: `linear-gradient(135deg, ${accentColor}10, transparent)`, border: `1px solid ${accentColor}15` }}>
                <Server size={32} style={{ color: `${accentColor}40` }} />
              </div>
              <p className="font-orbitron text-sm tracking-[0.2em] mb-2" style={{ color: `${accentColor}60` }}>SERVER NOT CONFIGURED</p>
              <p className="font-rajdhani text-white/35 text-sm text-center max-w-xs leading-relaxed">
                Set the Save & Load Server URL in<br/>
                <span className="text-white/50">Admin Panel</span> <ChevronRight size={10} className="inline text-white/20" /> <span className="text-white/50">Settings</span>
              </p>
              <div className="mt-6 px-4 py-2 rounded-lg bg-white/[0.02] border border-white/[0.06]">
                <p className="font-rajdhani text-white/25 text-xs flex items-center gap-2">
                  <AlertTriangle size={10} style={{ color: `${accentColor}50` }} />
                  Example: http://192.168.1.100:3456
                </p>
              </div>
            </div>
          ) : !isLoggedIn ? (
            <div className="px-6 py-8">
              <div className="max-w-[340px] mx-auto">
                <div className="flex mb-8 rounded-xl overflow-hidden border border-white/[0.06] bg-black/20 p-1">
                  <button
                    onClick={() => setAuthView('login')}
                    className="flex-1 py-2.5 rounded-lg font-orbitron text-[11px] tracking-[0.15em] transition-all flex items-center justify-center gap-2"
                    style={authView === 'login' ? {
                      background: `linear-gradient(135deg, ${accentColor}, ${accentColor}cc)`,
                      color: '#000',
                      fontWeight: 700,
                      boxShadow: `0 0 20px ${accentColor}30`,
                    } : {
                      color: 'rgba(255,255,255,0.35)',
                    }}
                  >
                    <LogIn size={12} />LOGIN
                  </button>
                  <button
                    onClick={() => setAuthView('register')}
                    className="flex-1 py-2.5 rounded-lg font-orbitron text-[11px] tracking-[0.15em] transition-all flex items-center justify-center gap-2"
                    style={authView === 'register' ? {
                      background: `linear-gradient(135deg, ${accentColor}, ${accentColor}cc)`,
                      color: '#000',
                      fontWeight: 700,
                      boxShadow: `0 0 20px ${accentColor}30`,
                    } : {
                      color: 'rgba(255,255,255,0.35)',
                    }}
                  >
                    <UserPlus size={12} />REGISTER
                  </button>
                </div>

                {authView === 'login' ? (
                  <div className="space-y-4">
                    <div className="text-center mb-6">
                      <div className="w-16 h-16 rounded-2xl mx-auto mb-4 flex items-center justify-center" style={{ background: `linear-gradient(135deg, ${accentColor}15, transparent)`, border: `1px solid ${accentColor}20` }}>
                        <Shield size={28} style={{ color: `${accentColor}70` }} />
                      </div>
                      <p className="font-orbitron text-xs tracking-[0.2em]" style={{ color: `${accentColor}70` }}>WELCOME BACK</p>
                      <p className="font-rajdhani text-white/30 text-xs mt-1">Sign in to access your saves</p>
                    </div>

                    <div>
                      <label className="block text-[10px] text-white/30 mb-1.5 font-orbitron uppercase tracking-[0.15em] ml-1">Username</label>
                      <div className="relative">
                        <User size={14} className="absolute left-3.5 top-1/2 -translate-y-1/2" style={{ color: `${accentColor}40` }} />
                        <input
                          value={loginUser}
                          onChange={e => setLoginUser(e.target.value)}
                          onKeyDown={e => e.key === 'Enter' && handleLogin()}
                          className={inputClass}
                          placeholder="Enter username"
                          autoFocus
                        />
                      </div>
                    </div>
                    <div>
                      <label className="block text-[10px] text-white/30 mb-1.5 font-orbitron uppercase tracking-[0.15em] ml-1">Password</label>
                      <div className="relative">
                        <Lock size={14} className="absolute left-3.5 top-1/2 -translate-y-1/2" style={{ color: `${accentColor}40` }} />
                        <input
                          type={showPass ? 'text' : 'password'}
                          value={loginPass}
                          onChange={e => setLoginPass(e.target.value)}
                          onKeyDown={e => e.key === 'Enter' && handleLogin()}
                          className={inputClass}
                          style={{ paddingRight: '40px' }}
                          placeholder="Enter password"
                        />
                        <button onClick={() => setShowPass(!showPass)} className="absolute right-3 top-1/2 -translate-y-1/2 text-white/20 hover:text-white/40 transition-colors" type="button">
                          {showPass ? <EyeOff size={14} /> : <Eye size={14} />}
                        </button>
                      </div>
                    </div>
                    <button
                      onClick={handleLogin}
                      disabled={loading}
                      className="w-full py-3.5 rounded-xl font-orbitron font-bold text-sm tracking-[0.15em] disabled:opacity-40 transition-all active:scale-[0.98]"
                      style={{
                        background: `linear-gradient(135deg, ${accentColor}, ${accentColor}bb)`,
                        color: '#000',
                        boxShadow: `0 4px 20px ${accentColor}25`,
                      }}
                    >
                      {loading ? (
                        <span className="flex items-center justify-center gap-2">
                          <RefreshCw size={14} className="animate-spin" />SIGNING IN...
                        </span>
                      ) : 'SIGN IN'}
                    </button>
                  </div>
                ) : (
                  <div className="space-y-4">
                    <div className="text-center mb-6">
                      <div className="w-16 h-16 rounded-2xl mx-auto mb-4 flex items-center justify-center" style={{ background: `linear-gradient(135deg, ${accentColor}15, transparent)`, border: `1px solid ${accentColor}20` }}>
                        <UserPlus size={28} style={{ color: `${accentColor}70` }} />
                      </div>
                      <p className="font-orbitron text-xs tracking-[0.2em]" style={{ color: `${accentColor}70` }}>CREATE ACCOUNT</p>
                      <p className="font-rajdhani text-white/30 text-xs mt-1">Register to start saving your games</p>
                    </div>

                    <div>
                      <label className="block text-[10px] text-white/30 mb-1.5 font-orbitron uppercase tracking-[0.15em] ml-1">Username</label>
                      <div className="relative">
                        <User size={14} className="absolute left-3.5 top-1/2 -translate-y-1/2" style={{ color: `${accentColor}40` }} />
                        <input
                          value={regUser}
                          onChange={e => setRegUser(e.target.value)}
                          className={inputClass}
                          placeholder="Choose username (3-30 chars)"
                          autoFocus
                        />
                      </div>
                    </div>
                    <div>
                      <label className="block text-[10px] text-white/30 mb-1.5 font-orbitron uppercase tracking-[0.15em] ml-1">Password</label>
                      <div className="relative">
                        <Lock size={14} className="absolute left-3.5 top-1/2 -translate-y-1/2" style={{ color: `${accentColor}40` }} />
                        <input
                          type={showPass ? 'text' : 'password'}
                          value={regPass}
                          onChange={e => setRegPass(e.target.value)}
                          className={inputClass}
                          placeholder="Choose password (min 4 chars)"
                        />
                        <button onClick={() => setShowPass(!showPass)} className="absolute right-3 top-1/2 -translate-y-1/2 text-white/20 hover:text-white/40 transition-colors" type="button">
                          {showPass ? <EyeOff size={14} /> : <Eye size={14} />}
                        </button>
                      </div>
                    </div>
                    <div>
                      <label className="block text-[10px] text-white/30 mb-1.5 font-orbitron uppercase tracking-[0.15em] ml-1">Confirm Password</label>
                      <div className="relative">
                        <Lock size={14} className="absolute left-3.5 top-1/2 -translate-y-1/2" style={{ color: `${accentColor}40` }} />
                        <input
                          type={showPass ? 'text' : 'password'}
                          value={regConfirm}
                          onChange={e => setRegConfirm(e.target.value)}
                          onKeyDown={e => e.key === 'Enter' && handleRegister()}
                          className={inputClass}
                          placeholder="Confirm password"
                        />
                      </div>
                    </div>
                    <button
                      onClick={handleRegister}
                      disabled={loading}
                      className="w-full py-3.5 rounded-xl font-orbitron font-bold text-sm tracking-[0.15em] disabled:opacity-40 transition-all active:scale-[0.98]"
                      style={{
                        background: `linear-gradient(135deg, ${accentColor}, ${accentColor}bb)`,
                        color: '#000',
                        boxShadow: `0 4px 20px ${accentColor}25`,
                      }}
                    >
                      {loading ? (
                        <span className="flex items-center justify-center gap-2">
                          <RefreshCw size={14} className="animate-spin" />CREATING...
                        </span>
                      ) : 'CREATE ACCOUNT'}
                    </button>
                  </div>
                )}

                <div className="mt-6 flex items-center justify-center gap-2">
                  <div className="h-[1px] flex-1" style={{ background: `linear-gradient(90deg, transparent, ${accentColor}10)` }} />
                  <p className="font-rajdhani text-[10px] text-white/20 flex items-center gap-1.5">
                    <Shield size={8} style={{ color: `${accentColor}30` }} />Secured Connection
                  </p>
                  <div className="h-[1px] flex-1" style={{ background: `linear-gradient(90deg, ${accentColor}10, transparent)` }} />
                </div>
              </div>
            </div>
          ) : (
            <div className="px-6 py-5">
              <div className="flex mb-5 rounded-xl overflow-hidden border border-white/[0.06] bg-black/20 p-1">
                <button
                  onClick={() => setActiveTab('save')}
                  className="flex-1 py-2.5 rounded-lg font-orbitron text-[11px] tracking-[0.15em] transition-all flex items-center justify-center gap-2"
                  style={activeTab === 'save' ? {
                    background: `linear-gradient(135deg, ${accentColor}20, ${accentColor}08)`,
                    color: accentColor,
                    fontWeight: 700,
                    border: `1px solid ${accentColor}30`,
                  } : {
                    color: 'rgba(255,255,255,0.35)',
                  }}
                >
                  <CloudUpload size={13} />SAVE GAMES
                  {gamesWithSavePath.length > 0 && (
                    <span className="text-[9px] px-1.5 py-0.5 rounded-md font-rajdhani" style={activeTab === 'save' ? { background: `${accentColor}20`, color: accentColor } : { background: 'rgba(255,255,255,0.05)', color: 'rgba(255,255,255,0.3)' }}>
                      {gamesWithSavePath.length}
                    </span>
                  )}
                </button>
                <button
                  onClick={() => setActiveTab('load')}
                  className="flex-1 py-2.5 rounded-lg font-orbitron text-[11px] tracking-[0.15em] transition-all flex items-center justify-center gap-2"
                  style={activeTab === 'load' ? {
                    background: `linear-gradient(135deg, ${accentColor}20, ${accentColor}08)`,
                    color: accentColor,
                    fontWeight: 700,
                    border: `1px solid ${accentColor}30`,
                  } : {
                    color: 'rgba(255,255,255,0.35)',
                  }}
                >
                  <CloudDownload size={13} />LOAD SAVES
                  {saves.length > 0 && (
                    <span className="text-[9px] px-1.5 py-0.5 rounded-md font-rajdhani" style={activeTab === 'load' ? { background: `${accentColor}20`, color: accentColor } : { background: 'rgba(255,255,255,0.05)', color: 'rgba(255,255,255,0.3)' }}>
                      {saves.length}
                    </span>
                  )}
                </button>
              </div>

              {activeTab === 'save' ? (
                <div>
                  {gamesWithSavePath.length > 3 && (
                    <div className="relative mb-3">
                      <Search size={13} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-white/20" />
                      <input
                        value={searchGames}
                        onChange={e => setSearchGames(e.target.value)}
                        placeholder="Search games..."
                        className="w-full pl-10 pr-3 py-2.5 bg-black/30 border border-white/[0.06] rounded-xl text-white text-xs font-rajdhani focus:outline-none focus:border-white/15 transition-colors placeholder:text-white/15"
                      />
                    </div>
                  )}

                  {gamesWithSavePath.length === 0 ? (
                    <div className="text-center py-12">
                      <div className="w-16 h-16 rounded-2xl mx-auto mb-4 flex items-center justify-center" style={{ background: `${accentColor}08`, border: `1px solid ${accentColor}10` }}>
                        <HardDrive size={24} style={{ color: `${accentColor}30` }} />
                      </div>
                      <p className="font-orbitron text-xs tracking-[0.15em] mb-1" style={{ color: `${accentColor}50` }}>NO SAVE PATHS</p>
                      <p className="font-rajdhani text-white/30 text-xs">
                        Configure save paths in <span className="text-white/50">Admin Panel</span> <ChevronRight size={8} className="inline" /> <span className="text-white/50">Games</span>
                      </p>
                    </div>
                  ) : (
                    <div className="space-y-1.5 max-h-[52vh] overflow-y-auto pr-1 scrollbar-thin">
                      {filteredGames.map(game => {
                        const hasSave = saves.some(s => s.game_name === game.name)
                        const isUploading = uploadingGame === game.id
                        return (
                          <button
                            key={game.id}
                            onClick={() => handleSave(game)}
                            disabled={isUploading}
                            className="w-full flex items-center gap-3 px-3.5 py-3 rounded-xl border transition-all disabled:opacity-40 text-left group"
                            style={{
                              background: isUploading ? `${accentColor}08` : 'rgba(255,255,255,0.015)',
                              borderColor: isUploading ? `${accentColor}30` : 'rgba(255,255,255,0.04)',
                            }}
                            onMouseEnter={e => { if (!isUploading) { e.currentTarget.style.borderColor = `${accentColor}25`; e.currentTarget.style.background = `${accentColor}06` }}}
                            onMouseLeave={e => { if (!isUploading) { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.04)'; e.currentTarget.style.background = 'rgba(255,255,255,0.015)' }}}
                          >
                            {game.icon ? (
                              <img src={game.icon} alt="" className="w-10 h-[52px] rounded-lg object-cover flex-shrink-0" style={{ border: '1px solid rgba(255,255,255,0.06)' }} />
                            ) : (
                              <div className="w-10 h-[52px] rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: `${accentColor}10`, border: `1px solid ${accentColor}15` }}>
                                <HardDrive size={14} style={{ color: `${accentColor}40` }} />
                              </div>
                            )}
                            <div className="min-w-0 flex-1">
                              <p className="font-rajdhani text-white/80 text-sm font-bold truncate">{game.name}</p>
                              <p className="font-rajdhani text-white/20 text-[10px] truncate mt-0.5">{game.savePath}</p>
                            </div>
                            {hasSave && (
                              <span className="font-rajdhani text-[9px] uppercase tracking-wider flex-shrink-0 px-2 py-1 rounded-md" style={{ background: `${accentColor}10`, color: `${accentColor}70`, border: `1px solid ${accentColor}15` }}>
                                Replace
                              </span>
                            )}
                            <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 transition-colors" style={{ background: isUploading ? `${accentColor}20` : 'transparent' }}>
                              {isUploading ? (
                                <RefreshCw size={14} className="animate-spin" style={{ color: accentColor }} />
                              ) : (
                                <Upload size={14} className="text-white/15 group-hover:text-white/40 transition-colors" />
                              )}
                            </div>
                          </button>
                        )
                      })}
                      {filteredGames.length === 0 && searchGames && (
                        <p className="text-center py-8 font-rajdhani text-white/25 text-xs">No games match "{searchGames}"</p>
                      )}
                    </div>
                  )}
                </div>
              ) : (
                <div>
                  <div className="flex items-center justify-between mb-3">
                    {saves.length > 3 && (
                      <div className="relative flex-1 mr-2">
                        <Search size={13} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-white/20" />
                        <input
                          value={searchSaves}
                          onChange={e => setSearchSaves(e.target.value)}
                          placeholder="Search saves..."
                          className="w-full pl-10 pr-3 py-2.5 bg-black/30 border border-white/[0.06] rounded-xl text-white text-xs font-rajdhani focus:outline-none focus:border-white/15 transition-colors placeholder:text-white/15"
                        />
                      </div>
                    )}
                    <button
                      onClick={fetchSaves}
                      className="p-2.5 rounded-xl border border-white/[0.06] hover:border-white/10 bg-black/20 hover:bg-black/30 transition-all flex-shrink-0 group"
                      title="Refresh saves"
                    >
                      <RefreshCw size={13} className={`text-white/30 group-hover:text-white/50 transition-colors ${savesLoading ? 'animate-spin' : ''}`} />
                    </button>
                  </div>

                  {savesLoading ? (
                    <div className="flex flex-col items-center justify-center py-12">
                      <RefreshCw size={24} className="animate-spin mb-3" style={{ color: `${accentColor}50` }} />
                      <p className="font-rajdhani text-white/25 text-xs">Loading saves...</p>
                    </div>
                  ) : saves.length === 0 ? (
                    <div className="text-center py-12">
                      <div className="w-16 h-16 rounded-2xl mx-auto mb-4 flex items-center justify-center" style={{ background: `${accentColor}08`, border: `1px solid ${accentColor}10` }}>
                        <FileArchive size={24} style={{ color: `${accentColor}30` }} />
                      </div>
                      <p className="font-orbitron text-xs tracking-[0.15em] mb-1" style={{ color: `${accentColor}50` }}>NO SAVES YET</p>
                      <p className="font-rajdhani text-white/30 text-xs">Upload a game save to get started</p>
                    </div>
                  ) : (
                    <div className="space-y-1.5 max-h-[52vh] overflow-y-auto pr-1 scrollbar-thin">
                      {filteredSaves.map(save => {
                        const matchingGame = games.find(g => g.name === save.game_name)
                        const isDownloading = downloadingId === save.id
                        return (
                          <div
                            key={save.id}
                            className="flex items-center gap-3 px-3.5 py-3 rounded-xl border transition-all"
                            style={{
                              background: isDownloading ? `${accentColor}08` : 'rgba(255,255,255,0.015)',
                              borderColor: isDownloading ? `${accentColor}30` : 'rgba(255,255,255,0.04)',
                            }}
                          >
                            {matchingGame?.icon ? (
                              <img src={matchingGame.icon} alt="" className="w-11 h-[56px] rounded-lg object-cover flex-shrink-0" style={{ border: '1px solid rgba(255,255,255,0.06)' }} />
                            ) : (
                              <div className="w-11 h-[56px] rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: `${accentColor}10`, border: `1px solid ${accentColor}15` }}>
                                <FileArchive size={16} style={{ color: `${accentColor}40` }} />
                              </div>
                            )}
                            <div className="min-w-0 flex-1">
                              <p className="font-rajdhani text-white/85 text-sm font-bold truncate">{save.game_name}</p>
                              <div className="flex items-center gap-3 mt-1">
                                <span className="font-rajdhani text-[10px] text-white/25 flex items-center gap-1">
                                  <Clock size={9} className="text-white/15" />{formatDate(save.updated_at)}
                                </span>
                                <span className="font-rajdhani text-[10px] flex items-center gap-1" style={{ color: `${accentColor}50` }}>
                                  <HardDrive size={9} />{formatSize(save.archive_size)}
                                </span>
                              </div>
                            </div>
                            <div className="flex items-center gap-1 flex-shrink-0">
                              <button
                                onClick={() => handleLoad(save)}
                                disabled={isDownloading}
                                className="px-3 py-2 rounded-lg font-orbitron text-[10px] tracking-wider font-bold transition-all disabled:opacity-40 active:scale-95 flex items-center gap-1.5"
                                style={{
                                  background: `linear-gradient(135deg, ${accentColor}20, ${accentColor}10)`,
                                  color: accentColor,
                                  border: `1px solid ${accentColor}25`,
                                }}
                              >
                                {isDownloading ? <RefreshCw size={11} className="animate-spin" /> : <Download size={11} />}
                                {isDownloading ? 'LOADING' : 'LOAD'}
                              </button>
                              <button
                                onClick={() => handleDelete(save)}
                                className="p-2 rounded-lg border border-white/[0.04] hover:border-red-500/20 hover:bg-red-500/5 transition-all group"
                                title="Delete save"
                              >
                                <Trash2 size={12} className="text-white/15 group-hover:text-red-400/70 transition-colors" />
                              </button>
                            </div>
                          </div>
                        )
                      })}
                      {filteredSaves.length === 0 && searchSaves && (
                        <p className="text-center py-8 font-rajdhani text-white/25 text-xs">No saves match "{searchSaves}"</p>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="h-[1px] mx-6" style={{ background: `linear-gradient(90deg, transparent, ${accentColor}08, transparent)` }} />
        <div className="px-6 py-3 flex items-center justify-center flex-shrink-0">
          <p className="font-rajdhani text-[10px] text-white/15 tracking-wider">EXAMPLE CAFE SAVE SYSTEM</p>
        </div>
      </div>
    </div>
  )
}
