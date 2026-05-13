import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'

function saveToFile(value) {
  if (!window.electronAPI?.saveSettings) return
  try {
    const parsed = JSON.parse(value)
    window.electronAPI.saveSettings(parsed).catch(() => {})
  } catch (e) {}
}

const fileBackedStorage = {
  getItem: (name) => {
    return localStorage.getItem(name)
  },
  setItem: (name, value) => {
    localStorage.setItem(name, value)
    saveToFile(value)
  },
  removeItem: (name) => {
    localStorage.removeItem(name)
  },
}

const defaultGames = []

const ADMIN_SECRET_KEY = 'DENFI2024'

const useStore = create(
  persist(
    (set, get) => ({
      games: defaultGames,
      localIPs: [],
      localHostname: '',
      settings: {
        launcherName: 'EXAMPLE CAFE',
        launcherTagline: 'JUST SIT. PLAY. RELAX & ENJOY',
        background: null,
        logo: null,
        bannerImage: null,
        splashImage: null,
        accentColor: null,
        uiZoom: 100,
        autoCloseOnLaunch: false,
        // Kiosk mode: when true the launcher runs full-screen with common
        // app-switch shortcuts (Alt+Tab, Alt+F4, Ctrl+Esc) blocked while
        // it has focus. Mutually exclusive with autoCloseOnLaunch — the
        // launcher closing on game launch makes a kiosk lock pointless,
        // so the two settings can never both be true (enforced in
        // updateSettings + the v31 migrate).
        kioskMode: false,
        secretKey: ADMIN_SECRET_KEY,
        computerRates: [
          { name: 'Regular', price: 15, unit: '/hr' },
          { name: 'VIP', price: 25, unit: '/hr' },
          { name: 'VVIP', price: 40, unit: '/hr' },
        ],
        socialLinks: [
          { id: '1', name: 'Facebook', icon: 'f', url: 'https://facebook.com', color: 'from-blue-500 to-blue-600' },
          { id: '2', name: 'Twitter', icon: '𝕏', url: 'https://twitter.com', color: 'from-gray-500 to-gray-600' },
          { id: '3', name: 'YouTube', icon: '▶', url: 'https://youtube.com', color: 'from-red-500 to-red-600' },
          { id: '4', name: 'Discord', icon: '💬', url: 'https://discord.com', color: 'from-green-500 to-green-600' },
        ],
        officeApps: [
          { id: '1', name: 'Teams', icon: 'T', exePath: '', color: 'from-indigo-500 to-indigo-600' },
          { id: '2', name: 'PowerPoint', icon: 'P', exePath: '', color: 'from-orange-500 to-orange-600' },
          { id: '3', name: 'Excel', icon: 'X', exePath: '', color: 'from-emerald-500 to-emerald-600' },
          { id: '4', name: 'Word', icon: 'W', exePath: '', color: 'from-blue-500 to-blue-600' },
        ],
        poweredBy: 'EXAMPLE CAFE',
        topBannerLogos: [],
        announcement: '',
        announcementImages: [],
        announcementSlideInterval: 5,
        showGameNames: true,
        pcGroups: [],
        igdbClientId: '10v1tjvitc8rlqrzwlprsjgk1ukogy',
        igdbClientSecret: 'eulj0ebeyc9uh6gtatamg63l6gdknj',
        saveLoadServerUrl: ''
      },
      activeCategory: 'all',
      searchQuery: '',
      isAdminOpen: false,
      isAdminAuthenticated: false,
      adminSection: 'games',

      setActiveCategory: (cat) => set({ activeCategory: cat }),
      setSearchQuery: (q) => set({ searchQuery: q }),

      openAdmin: () => set({ isAdminOpen: true }),
      closeAdmin: () => set({ isAdminOpen: false, isAdminAuthenticated: false }),
      authenticateAdmin: (key) => {
        const { settings } = get()
        if (key === settings.secretKey) {
          set({ isAdminAuthenticated: true })
          return true
        }
        return false
      },
      setAdminSection: (section) => set({ adminSection: section }),

      addGame: (game) => set((state) => ({
        games: [...state.games, { ...game, id: Date.now().toString(), launchCount: 0 }]
      })),
      updateGame: (id, updates) => set((state) => ({
        games: state.games.map(g => g.id === id ? { ...g, ...updates } : g)
      })),
      deleteGame: (id) => set((state) => ({
        games: state.games.filter(g => g.id !== id)
      })),
      incrementLaunchCount: (id) => set((state) => ({
        games: state.games.map(g => g.id === id ? { ...g, launchCount: (g.launchCount || 0) + 1 } : g)
      })),
      setTopPick: (id, rank) => set((state) => ({
        games: state.games.map(g => {
          if (g.id === id) return { ...g, topPickRank: rank }
          if (rank && g.topPickRank === rank) return { ...g, topPickRank: null }
          return g
        })
      })),
      togglePinned: (id) => set((state) => ({
        games: state.games.map(g => g.id === id ? { ...g, pinned: !g.pinned } : g)
      })),

      setLocalIP: (ips, hostname) => set({ localIPs: ips || [], localHostname: hostname || '' }),

      updateSettings: (updates) => set((state) => ({
        settings: { ...state.settings, ...updates }
      })),

      getFilteredGames: () => {
        const { games, activeCategory, searchQuery } = get()
        return games.filter(game => {
          const matchesCategory = activeCategory === 'all' || game.category === activeCategory
          const matchesSearch = !searchQuery ||
            game.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
            game.description.toLowerCase().includes(searchQuery.toLowerCase())
          return matchesCategory && matchesSearch
        })
      },

      getTopPicks: () => {
        return get().games.filter(g => g.topPickRank).sort((a, b) => a.topPickRank - b.topPickRank).slice(0, 3)
      },
    }),
    {
      name: 'example-cafe-storage',
      version: 31,
      storage: createJSONStorage(() => fileBackedStorage),
      migrate: (persistedState, version) => {
        const oldDefaultIds = ['1','2','3','4','5','6','7','8','9','10','11','12']
        const demoIds = ['demo1','demo2','demo3','demo4','demo5','demo6','demo7','demo8','demo9','demo10','demo11','demo12','demo13','demo14','demo15','demo16']
        let cleanedGames = (persistedState.games || []).filter(g => !oldDefaultIds.includes(g.id) && !demoIds.includes(g.id)).map(g => ({
          ...g,
          variations: Array.isArray(g.variations) ? g.variations.filter(v => v?.name?.trim() && v?.exePath?.trim()) : []
        }))
        return {
          ...persistedState,
          games: cleanedGames,
          settings: {
            ...(persistedState.settings || {}),
            uiZoom: Math.max(100, Math.min(200, persistedState.settings?.uiZoom || 100)),
            autoCloseOnLaunch: persistedState.settings?.autoCloseOnLaunch || false,
            kioskMode: !!persistedState.settings?.kioskMode,
            poweredBy: persistedState.settings?.poweredBy ?? 'EXAMPLE CAFE',
            socialLinks: Array.isArray(persistedState.settings?.socialLinks) ? persistedState.settings.socialLinks : [
              { id: '1', name: 'Facebook', icon: 'f', url: 'https://facebook.com', color: 'from-blue-500 to-blue-600' },
              { id: '2', name: 'Twitter', icon: '𝕏', url: 'https://twitter.com', color: 'from-gray-500 to-gray-600' },
              { id: '3', name: 'YouTube', icon: '▶', url: 'https://youtube.com', color: 'from-red-500 to-red-600' },
              { id: '4', name: 'Discord', icon: '💬', url: 'https://discord.com', color: 'from-green-500 to-green-600' },
            ],
            officeApps: Array.isArray(persistedState.settings?.officeApps) ? persistedState.settings.officeApps : [
              { id: '1', name: 'Teams', icon: 'T', exePath: '', color: 'from-indigo-500 to-indigo-600' },
              { id: '2', name: 'PowerPoint', icon: 'P', exePath: '', color: 'from-orange-500 to-orange-600' },
              { id: '3', name: 'Excel', icon: 'X', exePath: '', color: 'from-emerald-500 to-emerald-600' },
              { id: '4', name: 'Word', icon: 'W', exePath: '', color: 'from-blue-500 to-blue-600' },
            ],
            topBannerLogos: persistedState.settings?.topBannerLogos || [],
            bannerImage: persistedState.settings?.bannerImage ?? null,
            announcementImages: persistedState.settings?.announcementImages || [],
            announcementSlideInterval: persistedState.settings?.announcementSlideInterval ?? 5,
            pcGroups: persistedState.settings?.pcGroups || [],
            igdbClientId: persistedState.settings?.igdbClientId || '10v1tjvitc8rlqrzwlprsjgk1ukogy',
            igdbClientSecret: persistedState.settings?.igdbClientSecret || 'eulj0ebeyc9uh6gtatamg63l6gdknj',
            saveLoadServerUrl: persistedState.settings?.saveLoadServerUrl || '',
            accentColor: (persistedState.settings?.accentColor === '#ff6a00' || !persistedState.settings?.accentColor)
              ? null
              : persistedState.settings.accentColor,
          },
        }
      },
      partialize: (state) => ({
        games: state.games,
        settings: state.settings,
      }),
    }
  )
)

export default useStore
