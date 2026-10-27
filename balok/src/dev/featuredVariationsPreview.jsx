import React from 'react'
import ReactDOM from 'react-dom/client'
import App from '../App'
import useStore from '../store/useStore'
import '../index.css'

if (!import.meta.env.DEV || window.electronAPI) {
  throw new Error('This sample library is only available in the browser development preview.')
}

// Never write test games or launch counts into the customer's persisted library.
useStore.persist.setOptions({
  storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
})
useStore.setState({
  games: [
    {
      id: 'preview-featured-variations',
      name: 'Rules of Survival : Legacy',
      variationTitle: 'Rules of Survival',
      description: 'Click Play Now: the heading is Rules of Survival, with Legacy and ros reborn as separate choices. Browser launches are simulated.',
      category: 'offline',
      isFeatured: true,
      topPickRank: 1,
      exePath: 'C:\\Preview\\base.exe',
      icon: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="80" height="80" viewBox="0 0 80 80"%3E%3Crect width="80" height="80" fill="%232f3c52"/%3E%3Ctext x="40" y="53" font-size="40" text-anchor="middle" fill="white"%3EL%3C/text%3E%3C/svg%3E',
      variations: [
        { label: 'Rules of Survival : Reborn', path: 'C:\\Preview\\reborn.exe', icon: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="80" height="80" viewBox="0 0 80 80"%3E%3Crect width="80" height="80" fill="%232a5348"/%3E%3Ctext x="40" y="53" font-size="40" text-anchor="middle" fill="white"%3ER%3C/text%3E%3C/svg%3E' },
        { label: 'Incomplete entry (hidden)', path: '' },
      ],
    },
    {
      id: 'preview-variations-only',
      name: 'Variations Only Test',
      description: 'No base executable: Play Now still lets you choose either variation.',
      category: 'offline',
      isFeatured: true,
      topPickRank: 2,
      variations: [
        { label: 'Version A', path: 'C:\\Preview\\a.exe' },
        { name: 'Version B', exePath: 'C:\\Preview\\b.exe' },
      ],
    },
    {
      id: 'preview-single-game',
      name: 'Single Game Test',
      description: 'No variations: Play Now launches directly in preview mode.',
      category: 'offline',
      isFeatured: true,
      topPickRank: 3,
      exePath: 'C:\\Preview\\single.exe',
    },
  ],
  settings: {
    ...useStore.getState().settings,
    featuredRotationInterval: 30,
    autoCloseOnLaunch: false,
    kioskMode: false,
  },
})

ReactDOM.createRoot(document.getElementById('root')).render(<App />)
