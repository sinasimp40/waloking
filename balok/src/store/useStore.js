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
  getItem: (name) => localStorage.getItem(name),
  setItem: (name, value) => {
    localStorage.setItem(name, value)
    saveToFile(value)
  },
  removeItem: (name) => localStorage.removeItem(name),
}

const ADMIN_SECRET_KEY = 'balok123'

const DAY = 86400000
const DEMO_GAMES = [
  { id: 'demo-gta',      name: 'Grand Theft Auto V',    category: 'online',  topPickRank: 1, isFavorite: true, exePath: '', icon: `/api/public/igdb/cover?name=Grand%20Theft%20Auto%20V`,       description: 'Experience the biggest open world adventure in Los Santos. Play now and rule the city.', launchCount: 124, addedAt: Date.now() - 240 * DAY },
  { id: 'demo-val',      name: 'Valorant',               category: 'online',  topPickRank: 2, isFavorite: true, exePath: '', icon: `/api/public/igdb/cover?name=Valorant`,       description: 'A 5v5 character-based tactical shooter. Creativity is your greatest weapon.', launchCount: 98, addedAt: Date.now() - 210 * DAY },
  { id: 'demo-dota',     name: 'DOTA 2',                 category: 'online',  topPickRank: 3, isFavorite: true, exePath: '', icon: `/api/public/igdb/cover?name=DOTA%202`,      description: 'Every day, millions of players worldwide enter the battle as one of over a hundred Dota heroes.', launchCount: 67, addedAt: Date.now() - 300 * DAY },
  { id: 'demo-cod',      name: 'Call of Duty: MW',       category: 'online',  exePath: '', icon: `/api/public/igdb/cover?name=Call%20of%20Duty%3A%20MW`,       launchCount: 52, addedAt: Date.now() - 180 * DAY },
  { id: 'demo-forza',    name: 'Forza Horizon 5',        category: 'offline', exePath: '', icon: `/api/public/igdb/cover?name=Forza%20Horizon%205`,     launchCount: 41, addedAt: Date.now() - 150 * DAY },
  { id: 'demo-cs2',      name: 'Counter-Strike 2',       category: 'online',  exePath: '', icon: `/api/public/igdb/cover?name=Counter-Strike%202`,       launchCount: 88, addedAt: Date.now() - 260 * DAY },
  { id: 'demo-apex',     name: 'Apex Legends',           category: 'online',  exePath: '', icon: `/api/public/igdb/cover?name=Apex%20Legends`,      launchCount: 35, addedAt: Date.now() - 120 * DAY },
  { id: 'demo-pubg',     name: 'PUBG: Battlegrounds',    category: 'online',  exePath: '', icon: `/api/public/igdb/cover?name=PUBG%3A%20Battlegrounds`,      launchCount: 29, addedAt: Date.now() - 90 * DAY },
  { id: 'demo-fc24',     name: 'EA FC 24',               category: 'offline', exePath: '', icon: `/api/public/igdb/cover?name=EA%20FC%2024`,      launchCount: 18, addedAt: Date.now() - 60 * DAY },
  { id: 'demo-rust',     name: 'Rust',                   category: 'online',  exePath: '', icon: `/api/public/igdb/cover?name=Rust`,      launchCount: 14, addedAt: Date.now() - 45 * DAY },
  { id: 'demo-elden',    name: 'Elden Ring',             category: 'offline', exePath: '', icon: `/api/public/igdb/cover?name=Elden%20Ring`,     launchCount: 11, addedAt: Date.now() - 200 * DAY },
  { id: 'demo-mc',       name: 'Minecraft',              category: 'offline', exePath: '', icon: `/api/public/igdb/cover?name=Minecraft`,        launchCount: 22, addedAt: Date.now() - 330 * DAY },
  { id: 'demo-cyberpunk',name: 'Cyberpunk 2077',         category: 'offline', isFavorite: true, exePath: '', icon: `/api/public/igdb/cover?name=Cyberpunk%202077`, description: 'An open-world, action-adventure story set in Night City, a megalopolis obsessed with power, glamour and body modification.', launchCount: 34, addedAt: Date.now() - 2 * DAY },
  { id: 'demo-rdr2',     name: 'Red Dead Redemption 2',  category: 'offline', exePath: '', icon: `/api/public/igdb/cover?name=Red%20Dead%20Redemption%202`,      description: 'America, 1899. Arthur Morgan and the Van der Linde gang are outlaws on the run.', launchCount: 3,  addedAt: Date.now() - 4 * DAY },
  { id: 'demo-r6',       name: 'Rainbow Six Siege',      category: 'online',  exePath: '', icon: `/api/public/igdb/cover?name=Rainbow%20Six%20Siege`,        launchCount: 19, addedAt: Date.now() - 6 * DAY },
  { id: 'demo-hogwarts', name: 'Hogwarts Legacy',        category: 'offline', exePath: '', icon: `/api/public/igdb/cover?name=Hogwarts%20Legacy`,  launchCount: 0,  addedAt: Date.now() - 1 * DAY },
  { id: 'demo-amongus',  name: 'Among Us',               category: 'online',  exePath: '', icon: `/api/public/igdb/cover?name=Among%20Us`,   launchCount: 5,  addedAt: Date.now() - 8 * DAY },
  { id: 'demo-stardew',  name: 'Stardew Valley',         category: 'offline', exePath: '', icon: `/api/public/igdb/cover?name=Stardew%20Valley`,   launchCount: 0,  addedAt: Date.now() - 3 * DAY },
  { id: 'demo-witcher3', name: 'The Witcher 3: Wild Hunt',category:'offline', isFavorite: true, exePath: '', icon: `/api/public/igdb/cover?name=The%20Witcher%203%3A%20Wild%20Hunt`,  description: 'A story-driven, next-generation open world role-playing game set in a visually stunning fantasy universe.', launchCount: 27, addedAt: Date.now() - 5 * DAY },
  { id: 'demo-terraria', name: 'Terraria',               category: 'offline', exePath: '', icon: `/api/public/igdb/cover?name=Terraria`, launchCount: 12, addedAt: Date.now() - 10 * DAY },
  { id: 'demo-fallguys', name: 'Fall Guys',              category: 'online',  exePath: '', icon: `/api/public/igdb/cover?name=Fall%20Guys`, launchCount: 8,  addedAt: Date.now() - 12 * DAY },
  { id: 'demo-l4d2',     name: 'Left 4 Dead 2',          category: 'online',  exePath: '', icon: `/api/public/igdb/cover?name=Left%204%20Dead%202`,     launchCount: 5,  addedAt: Date.now() - 150 * DAY },
  { id: 'demo-ittakestwo',name: 'It Takes Two',          category: 'offline', exePath: '', icon: `/api/public/igdb/cover?name=It%20Takes%20Two`, launchCount: 15, addedAt: Date.now() - 9 * DAY },
  { id: 'demo-sekiro',   name: 'Sekiro: Shadows Die Twice',category:'offline',exePath: '', icon: `/api/public/igdb/cover?name=Sekiro%3A%20Shadows%20Die%20Twice`,   launchCount: 18, addedAt: Date.now() - 100 * DAY },
  { id: 'demo-bg3',      name: "Baldur's Gate 3",        category: 'offline', isFavorite: true, exePath: '', icon: `/api/public/igdb/cover?name=Baldur\'s%20Gate%203`,     description: "Gather your party and return to the Forgotten Realms in a tale of fellowship and betrayal, sacrifice and survival.", launchCount: 145, addedAt: Date.now() - 3 * DAY },
  { id: 'demo-doom',     name: 'DOOM Eternal',           category: 'offline', isFavorite: true, exePath: '', icon: `/api/public/igdb/cover?name=DOOM%20Eternal`, launchCount: 110, addedAt: Date.now() - 5 * DAY },
  { id: 'demo-palworld', name: 'Palworld',               category: 'online',  isFavorite: true, exePath: '', icon: `/api/public/igdb/cover?name=Palworld`, launchCount: 95,  addedAt: Date.now() - 1 * DAY },
  { id: 'demo-destiny2', name: 'Destiny 2',              category: 'online',  exePath: '', icon: `/api/public/igdb/cover?name=Destiny%202`, launchCount: 75,  addedAt: Date.now() - 7 * DAY },
  { id: 'demo-dbd',      name: 'Dead by Daylight',       category: 'online',  exePath: '', icon: `/api/public/igdb/cover?name=Dead%20by%20Daylight`,      launchCount: 60,  addedAt: Date.now() - 11 * DAY },
  { id: 'demo-portal2',  name: 'Portal 2',               category: 'offline', exePath: '', icon: `/api/public/igdb/cover?name=Portal%202`, launchCount: 45,  addedAt: Date.now() - 200 * DAY },
  { id: 'demo-godofwar', name: 'God of War',             category: 'offline', isFavorite: true, exePath: '', icon: `/api/public/igdb/cover?name=God%20of%20War`, description: 'His vengeance against the Gods of Olympus behind him, Kratos now lives as a man in the realm of Norse Gods and monsters.', launchCount: 58, addedAt: Date.now() - 6 * DAY },
  { id: 'demo-sot',      name: 'Sea of Thieves',         category: 'online',  exePath: '', icon: `/api/public/igdb/cover?name=Sea%20of%20Thieves`, launchCount: 22, addedAt: Date.now() - 30 * DAY },
  { id: 'demo-hl2',      name: 'Half-Life 2',            category: 'offline', exePath: '', icon: `/api/public/igdb/cover?name=Half-Life%202`,      launchCount: 9,  addedAt: Date.now() - 400 * DAY },
  { id: 'demo-bf2042',   name: 'Battlefield 2042',       category: 'online',  exePath: '', icon: `/api/public/igdb/cover?name=Battlefield%202042`, launchCount: 31, addedAt: Date.now() - 20 * DAY },
  { id: 'demo-mhw',      name: 'Monster Hunter: World',  category: 'offline', exePath: '', icon: `/api/public/igdb/cover?name=Monster%20Hunter%3A%20World`,      launchCount: 16, addedAt: Date.now() - 40 * DAY },
  { id: 'demo-deathstranding', name: 'Death Stranding',  category: 'offline', exePath: '', icon: `/api/public/igdb/cover?name=Death%20Stranding`, launchCount: 4, addedAt: Date.now() - 14 * DAY },
]

const useStore = create(
  persist(
    (set, get) => ({
      games: [],
      localIPs: [],
      localHostname: '',
      // Branding baked into the customer build (ota-config.json) — loaded at
      // boot via electronAPI.getOtaConfig() or /ota-config.json fetch. Used
      // as the DEFAULT brand name/subtitle/logo; explicit admin-panel values
      // (settings.launcherName etc.) always win. Not persisted.
      otaBranding: null,
      settings: {
        launcherName: 'Balok',
        launcherTagline: 'Gaming Management System',
        background: null,
        logo: null,
        bannerImage: null,
        panelBanner: null,
        accentColor: null,
        uiZoom: 100,
        cardSize: 130,

        autoCloseOnLaunch: false,
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
          { id: '4', name: 'Discord', icon: '💬', url: 'https://discord.com', color: 'from-indigo-500 to-indigo-600' },
        ],
        officeApps: [
          { id: '1', name: 'Teams', icon: 'T', exePath: '', color: 'from-indigo-500 to-indigo-600' },
          { id: '2', name: 'PowerPoint', icon: 'P', exePath: '', color: 'from-orange-500 to-orange-600' },
          { id: '3', name: 'Excel', icon: 'X', exePath: '', color: 'from-emerald-500 to-emerald-600' },
          { id: '4', name: 'Word', icon: 'W', exePath: '', color: 'from-blue-500 to-blue-600' },
        ],
        poweredBy: 'BALOK',
        topBannerLogos: [],
        announcement: '',
        announcementImages: [],
        announcementSlideInterval: 5,
        // How long each Featured (Top Picks) banner slide stays on screen, in seconds.
        featuredRotationInterval: 3,
        // Posts shown in the right panel's Announcements list (distinct from
        // the ticker text above and the slideshow images).
        announcementsList: [],
        // Shown in the right panel's Upcoming Events list.
        upcomingEventsList: [],
        showGameNames: true,
        pcGroups: [],
        igdbClientId: '10v1tjvitc8rlqrzwlprsjgk1ukogy',
        igdbClientSecret: 'eulj0ebeyc9uh6gtatamg63l6gdknj',
        saveLoadServerUrl: '',
        customBrowserEnabled: false,
        customBrowserPath: '',
        iptvLink: 'https://raw.githubusercontent.com/Harleythetech/IPHTV/refs/heads/main/ph.m3u',
        showIPTV: true,

        // ── Telegram / PC-monitor notification settings ──────────────────
        // Direct Telegram game-launch alert settings for this launcher only.
        notificationEnabled:   true,
        notifyGameLaunches:    true,
        pcName:                '',
        pcMappings:            [],
        telegramBotToken:      '',
        telegramChatId:        '',
      },
      activeCategory: 'all',
      searchQuery: '',
      isAdminOpen: false,
      isAdminAuthenticated: false,
      adminSection: 'games',
      isIPTVOpen: false,

      setActiveCategory: (cat) => set({ activeCategory: cat }),
      setSearchQuery: (q) => set({ searchQuery: q }),
      setOtaBranding: (branding) => set({ otaBranding: branding || null }),

      openAdmin: () => set({ isAdminOpen: true }),
      closeAdmin: () => set({ isAdminOpen: false, isAdminAuthenticated: false }),
      authenticateAdmin: (key) => {
        const { settings } = get()
        if (key === settings.secretKey) { set({ isAdminAuthenticated: true }); return true }
        return false
      },
      setAdminSection: (section) => set({ adminSection: section }),

      addGame: (game) => set((state) => ({
        games: [...state.games, { ...game, id: Date.now().toString(), launchCount: 0, addedAt: Date.now() }]
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
      toggleFavorite: (id) => set((state) => ({
        games: state.games.map(g => g.id === id ? { ...g, isFavorite: !g.isFavorite } : g)
      })),

      openIPTV: () => set({ isIPTVOpen: true }),
      closeIPTV: () => set({ isIPTVOpen: false }),
      setLocalIP: (ips, hostname) => set({ localIPs: ips || [], localHostname: hostname || '' }),

      updateSettings: (updates) => set((state) => ({
        // kiosk and auto-close are independent toggles — the post-launch
        // behavior matrix lives in src/lib/afterLaunch.js.
        settings: { ...state.settings, ...updates },
      })),

      importState: (newGames, newSettings, assetMap = {}) => set((state) => {
        // Sanitize paths in games (e.g. converting absolute disk paths from other computers to relative or IGDB fallbacks)
        const sanitizePath = (path) => {
          if (!path) return path
          
          const pathStr = path.toString()

          // The Electron importer returns an absolute URL such as
          // file:///C:/Balok/data/assets/igdb_273041_cover_....jpg. Keep every
          // absolute file URL intact. The previous, overly-specific check only
          // accepted file:///data/assets/... and then corrupted valid Windows
          // URLs into that non-existent drive-root path.
          if (pathStr.startsWith('file://')) return pathStr

          // Normalize path to handle both backslashes and forward slashes
          const normalizedPath = pathStr.replace(/\\/g, '/')
          const parts = normalizedPath.split('/')
          const fileName = parts.pop()
          const fileNameWithoutExt = fileName ? fileName.replace(/\.[^/.]+$/, "") : null

          // 1. Check if the asset was just imported in the ZIP or already present in local assets
          if (fileName) {
            // Priority 1: Check if the asset was just imported in the ZIP assetMap
            if (assetMap[fileName]) return assetMap[fileName]
            
            // Native imports are resolved to absolute file:// URLs by the
            // main process. Do not invent a drive-less file:///data path here.
          }
          
          // 3. Fallback for IGDB-style filenames (igdb_ID_TIMESTAMP.jpg)
          // ONLY if it doesn't look like a local path and we are NOT in electron with a valid filename
          if (fileNameWithoutExt && fileNameWithoutExt.includes('igdb_')) {
            const idMatch = fileNameWithoutExt.match(/igdb_(\d+)/)
            const potentialId = idMatch ? idMatch[1] : null
            
            if (potentialId && /^\d+$/.test(potentialId)) {
              return `/api/public/igdb/cover?name=${potentialId}`
            }
            
            const nameMatch = fileNameWithoutExt.match(/igdb_.*?_(.*?)$/)
            const cleanName = nameMatch ? nameMatch[1] : fileNameWithoutExt.replace('igdb_', '')
            return `/api/public/igdb/cover?name=${encodeURIComponent(cleanName)}`
          }
          
          return pathStr
        }

        const sanitizedGames = Array.isArray(newGames) 
          ? newGames.map(g => ({
              ...g,
              icon: sanitizePath(g.icon),
              bannerImage: sanitizePath(g.bannerImage)
            }))
          : state.games

        const sanitizedSettings = { ...(newSettings || {}) }
        if (sanitizedSettings.background) sanitizedSettings.background = sanitizePath(sanitizedSettings.background)
        if (sanitizedSettings.logo) sanitizedSettings.logo = sanitizePath(sanitizedSettings.logo)
        if (sanitizedSettings.bannerImage) sanitizedSettings.bannerImage = sanitizePath(sanitizedSettings.bannerImage)
        if (sanitizedSettings.panelBanner) sanitizedSettings.panelBanner = sanitizePath(sanitizedSettings.panelBanner)

        // Ensure we don't overwrite the brand name with null if it's missing in the import
        const mergedSettings = { ...state.settings, ...sanitizedSettings }
        if (!sanitizedSettings.launcherName) {
          mergedSettings.launcherName = state.settings.launcherName || 'Balok'
        }

        return {
          games: sanitizedGames,
          settings: mergedSettings,
        }
      }),

      getFilteredGames: () => {
        const { games, activeCategory, searchQuery, localIPs, settings } = get()
        
        // Find if this client belongs to any PC Grouping based on its IP
        const myGroupIds = settings.pcGroups
          ?.filter(group => group.ips?.some(ip => localIPs.includes(ip)))
          ?.map(g => g.id) || []

        return games.filter(game => {
          // If the game has restricted groupings, only show if this client is in one of them
          if (game.pcGroups?.length > 0) {
            const isAllowed = game.pcGroups.some(groupId => myGroupIds.includes(groupId))
            if (!isAllowed) return false
          }

          const matchesCategory = activeCategory === 'all' || game.category === activeCategory
          const matchesSearch = !searchQuery ||
            game.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
            (game.description || '').toLowerCase().includes(searchQuery.toLowerCase())
          return matchesCategory && matchesSearch
        })
      },

      getTopPicks: () => {
        return get().games.filter(g => g.topPickRank).sort((a, b) => a.topPickRank - b.topPickRank).slice(0, 3)
      },
    }),
    {
      name: 'balok-storage',
      version: 27,
      storage: createJSONStorage(() => fileBackedStorage),
      migrate: (persistedState) => {
        // v12: launcherName/launcherTagline become null when still at the
        // old factory defaults, so per-customer OTA branding (otaBranding)
        // can take over as the default. Real admin customizations survive.
        const s = persistedState.settings || {}
        if (s.launcherName === 'BALOK LOUNGE') s.launcherName = null
        if (s.launcherTagline === 'PLAY. CONNECT. LEVEL UP.' || s.launcherTagline === 'COMPUTER SHOP') s.launcherTagline = null
        const demoById = Object.fromEntries(DEMO_GAMES.map(g => [g.id, g]))
        // v14 removes factory demo entries from existing installs as well as
        // new ones; customer-added games never use the reserved demo- prefix.
        const rawGames = (persistedState.games || []).filter(g => !String(g.id || '').startsWith('demo-'))
        // Backfill newly-added demo fields (e.g. cover art) into previously
        // persisted demo games that predate them, without touching user data.
        // Any game missing `addedAt` (persisted before that field existed)
        // gets a far-past fallback so it never wrongly shows a "NEW" badge.
        const games = rawGames.map(g => {
          const demo = demoById[g.id]
          // Preserve absolute file:// URLs created by the Electron backup
          // importer. They point at extracted assets in this installation and
          // must survive hydration; only legacy bundled/drive paths are stale.
          const isStaleIcon = !g.icon || /^(\/game-covers\/|[A-Za-z]:\\)/.test(g.icon)
          const isBlob = typeof g.icon === 'string' && g.icon.startsWith('blob:')
          
          const withIcon = demo 
            ? { ...g, icon: (isStaleIcon && !isBlob) ? demo.icon : g.icon } 
            : g
            
          return {
            ...withIcon,
            addedAt: withIcon.addedAt || demo?.addedAt || (Date.now() - 365 * DAY),
            isFavorite: withIcon.isFavorite !== undefined ? withIcon.isFavorite : (demo?.isFavorite || false),
          }
        })
        // Pick up any brand-new demo games (added to DEMO_GAMES after this
        // library was first persisted) that aren't in the user's saved list yet.
        const existingIds = new Set(games.map(g => g.id))
        const newDemoGames = []
        const allGames = [...games, ...newDemoGames]
        return {
          ...persistedState,
          games: allGames,
          settings: {
            ...(persistedState.settings || {}),
            uiZoom: Math.max(100, Math.min(200, persistedState.settings?.uiZoom || 100)),
            autoCloseOnLaunch: persistedState.settings?.autoCloseOnLaunch || false,
            kioskMode: !!persistedState.settings?.kioskMode,
            igdbClientId: persistedState.settings?.igdbClientId || '10v1tjvitc8rlqrzwlprsjgk1ukogy',
            igdbClientSecret: persistedState.settings?.igdbClientSecret || 'eulj0ebeyc9uh6gtatamg63l6gdknj',
            announcementsList: Array.isArray(persistedState.settings?.announcementsList) ? persistedState.settings.announcementsList : [],
            upcomingEventsList: Array.isArray(persistedState.settings?.upcomingEventsList) ? persistedState.settings.upcomingEventsList : [],
            // v26: direct Telegram game-launch alert settings
            notificationEnabled:    persistedState.settings?.notificationEnabled    ?? true,
            notifyGameLaunches:     persistedState.settings?.notifyGameLaunches     ?? true,
            pcName:                 persistedState.settings?.pcName                 ?? '',
            pcMappings:             Array.isArray(persistedState.settings?.pcMappings) ? persistedState.settings.pcMappings : [],
            telegramBotToken:       persistedState.settings?.telegramBotToken       ?? '',
            telegramChatId:         persistedState.settings?.telegramChatId         ?? '',
          },
        }
      },
      partialize: (state) => ({ games: state.games, settings: state.settings }),
    }
  )
)

if (typeof window !== 'undefined') window.__store = useStore

export default useStore
