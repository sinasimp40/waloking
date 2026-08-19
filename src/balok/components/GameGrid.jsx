import React, { useMemo } from 'react'
import { Gamepad2 } from 'lucide-react'
import useStore from '../store/useStore'
import GameCard from './GameCard'

export default function GameGrid() {
  const { games, activeCategory, searchQuery, settings, localIPs } = useStore()

  const filteredGames = useMemo(() => {
    const pcGroups = settings.pcGroups || []
    const hasIPDetection = localIPs.length > 0
    const myGroupIds = hasIPDetection
      ? pcGroups.filter(g => (g.ips || []).some(ip => localIPs.includes(ip))).map(g => g.id)
      : []
    const pcIsInAGroup = myGroupIds.length > 0

    return games.filter(game => {
      const matchesCategory = activeCategory === 'all' || game.category === activeCategory
      const matchesSearch = !searchQuery ||
        game.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (game.description || '').toLowerCase().includes(searchQuery.toLowerCase())
      let matchesPCGroup = true
      // A game with NO groups assigned is global — it shows on every PC.
      // Only group-restricted games are filtered by this PC's groups.
      const assigned = game.pcGroups || []
      if (pcIsInAGroup && assigned.length > 0) matchesPCGroup = assigned.some(gId => myGroupIds.includes(gId))
      return matchesCategory && matchesSearch && matchesPCGroup
    }).sort((a, b) => {
      if ((b.pinned ? 1 : 0) !== (a.pinned ? 1 : 0)) return (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0)
      return a.name.localeCompare(b.name)
    })
  }, [games, activeCategory, searchQuery, settings.pcGroups, localIPs])

  // Card size is user-controlled from the Game List zoom control.
  const cardSize = settings.cardSize || 130
  const zoom = settings.uiZoom || 100
  const minCardWidth = Math.round(cardSize * 1.4 * (zoom / 100))
  const gap = 12

  if (filteredGames.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4 px-6 py-8">
        <div
          className="w-20 h-20 rounded-2xl flex items-center justify-center"
          style={{ background: 'rgba(139,92,246,0.06)', border: '1px solid rgba(139,92,246,0.12)' }}
        >
          <Gamepad2 size={32} style={{ color: 'rgba(139,92,246,0.3)' }} />
        </div>
        <p className="font-syne font-bold text-white/30 text-sm uppercase tracking-widest">
          {searchQuery ? 'No results found' : 'No games added yet'}
        </p>
        <p className="font-jakarta text-white/20 text-xs text-center max-w-xs">
          {searchQuery ? 'Try a different search term' : 'Open the admin panel to add your first game'}
        </p>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto scroll-thin px-3 py-3">
      <div
        className="grid"
        style={{
          gridTemplateColumns: `repeat(auto-fill, minmax(${minCardWidth}px, 1fr))`,
          gap: `${gap}px`,
        }}
      >
        {filteredGames.map((game) => (
          <GameCard key={game.id} game={game} />
        ))}
      </div>
    </div>
  )
}
