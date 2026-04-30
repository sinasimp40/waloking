import React from 'react'
import { motion } from 'framer-motion'
import { Search } from 'lucide-react'
import useStore from '../store/useStore'

export default function Header() {
  const { games, settings, activeCategory, setActiveCategory, searchQuery, setSearchQuery, localIPs } = useStore()

  const visibleGames = React.useMemo(() => {
    const pcGroups = settings.pcGroups || []
    const hasIPDetection = localIPs.length > 0
    const myGroupIds = hasIPDetection
      ? pcGroups.filter(g => (g.ips || []).some(ip => localIPs.includes(ip))).map(g => g.id)
      : []
    const pcIsInAGroup = myGroupIds.length > 0
    return games.filter(game => {
      if (pcIsInAGroup) {
        return (game.pcGroups || []).some(gId => myGroupIds.includes(gId))
      }
      return true
    })
  }, [games, settings.pcGroups, localIPs])

  const usedCategories = new Set(visibleGames.map(g => g.category))

  const allPossibleCats = [
    { id: 'all', label: 'ALL GAMES', alwaysShow: true },
    { id: 'online', label: 'ONLINE' },
    { id: 'offline', label: 'OFFLINE' },
    { id: 'apps', label: 'APPS' },
  ]

  const defaultCategories = allPossibleCats.filter(c => c.alwaysShow || usedCategories.has(c.id))

  const customCats = [...new Set(
    visibleGames
      .map(g => g.category)
      .filter(c => c && !['online', 'offline', 'apps'].includes(c))
  )].map(c => ({ id: c, label: c.toUpperCase() }))

  const categories = [...defaultCategories, ...customCats]

  return (
    <div className="px-3 lg:px-5 py-2 lg:py-3 bg-dark-400/50 border-b border-neon-orange/10 flex-shrink-0">
      <div className="flex items-center gap-2 lg:gap-4">
        <div className="relative flex-1 max-w-[140px] md:max-w-[180px] lg:max-w-sm group">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-neon-orange/60 group-focus-within:text-neon-orange transition-colors" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search games & apps..."
            className="w-full pl-8 lg:pl-9 pr-3 lg:pr-4 py-1.5 lg:py-2 bg-dark-400/80 border border-neon-orange/35 rounded-lg text-white text-[11px] lg:text-sm font-rajdhani placeholder:text-white/50 focus:outline-none focus:border-neon-orange/80 focus:bg-dark-400 transition-all"
            style={{ boxShadow: '0 0 0 1px rgb(var(--accent-rgb) / 0.05), inset 0 1px 0 rgba(255,255,255,0.03)' }}
          />
          <div className="absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-neon-orange/20 to-transparent rounded-b-lg pointer-events-none" />
        </div>

        <div className="flex items-center gap-1 flex-wrap min-w-0">
          {categories.map((cat) => (
            <motion.button
              key={cat.id}
              whileHover={{ scale: 1.03 }}
              whileTap={{ scale: 0.97 }}
              onClick={() => setActiveCategory(cat.id)}
              className={`
                px-2 md:px-3.5 lg:px-5 py-1 md:py-1.5 lg:py-2 text-[8px] md:text-[9px] lg:text-[11px] font-orbitron font-bold tracking-[0.08em] lg:tracking-[0.15em] transition-all rounded-md whitespace-nowrap flex-shrink-0
                ${activeCategory === cat.id
                  ? 'bg-neon-orange text-black shadow-neon-sm'
                  : 'text-white/60 hover:text-neon-orange border border-white/15 hover:border-neon-orange/50'
                }
              `}
            >
              {cat.label}
            </motion.button>
          ))}
        </div>

        {settings.poweredBy && (
          <div className="ml-auto hidden lg:flex items-center gap-2 flex-shrink-0">
            <span className="text-xs font-rajdhani text-white/65 uppercase tracking-wider">Powered by</span>
            <span className="text-sm font-orbitron text-neon-orange font-bold tracking-wider">{settings.poweredBy}</span>
          </div>
        )}
      </div>
    </div>
  )
}
