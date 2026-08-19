import React from 'react'
import useStore from '../store/useStore'
import GameCard from './GameCard'

export default function GameGrid() {
  const games = useStore(s => s.games)
  const activeCategory = useStore(s => s.activeCategory)
  const searchQuery = useStore(s => s.searchQuery)
  const pcGroups = useStore(s => s.settings.pcGroups)
  const localIPs = useStore(s => s.localIPs)
  const uiZoom = useStore(s => s.settings.uiZoom)
  const showGameNames = useStore(s => s.settings.showGameNames)

  const filteredGames = React.useMemo(() => {
    const groups = pcGroups || []
    const hasIPDetection = localIPs.length > 0
    const myGroupIds = hasIPDetection
      ? groups.filter(g => (g.ips || []).some(ip => localIPs.includes(ip))).map(g => g.id)
      : []
    const pcIsInAGroup = myGroupIds.length > 0
    const filtered = games.filter(game => {
      const matchesCategory = activeCategory === 'all' || game.category === activeCategory
      const matchesSearch = !searchQuery ||
        game.name.toLowerCase().includes(searchQuery.toLowerCase())
      let matchesPCGroup = true
      if (pcIsInAGroup) {
        matchesPCGroup = (game.pcGroups || []).some(gId => myGroupIds.includes(gId))
      }
      return matchesCategory && matchesSearch && matchesPCGroup
    })
    return filtered.sort((a, b) => {
      if ((b.pinned ? 1 : 0) !== (a.pinned ? 1 : 0)) return (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0)
      return a.name.localeCompare(b.name)
    })
  }, [games, activeCategory, searchQuery, pcGroups, localIPs])

  const zoom = uiZoom || 100
  const minCardWidth = Math.round(130 * (zoom / 100))
  const gap = Math.round(12 * (zoom / 100))

  return (
    <div className="flex-1 overflow-y-auto px-2 md:px-3 lg:px-4 py-2 lg:py-3">
      {filteredGames.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-full gap-4">
          <div className="w-20 h-20 rounded-2xl border border-white/20 flex items-center justify-center bg-dark-400/50">
            <span className="text-4xl">🎮</span>
          </div>
          <p className="font-orbitron text-neon-orange/70 text-sm uppercase tracking-[0.2em]">
            {searchQuery ? 'No results found' : 'No games added yet'}
          </p>
          <p className="font-rajdhani text-white/50 text-xs">
            {searchQuery ? 'Try a different search term' : 'Open the admin panel to add games'}
          </p>
        </div>
      ) : (
        <div
          className="grid auto-rows-fr"
          style={{
            gridTemplateColumns: `repeat(auto-fill, minmax(${minCardWidth}px, 1fr))`,
            gap: `${gap}px`,
          }}
        >
          {filteredGames.map((game) => (
            <GameCard key={game.id} game={game} />
          ))}
        </div>
      )}
    </div>
  )
}
