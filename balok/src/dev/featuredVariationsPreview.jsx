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
      name: 'Featured Variation Test',
      description: 'Click Play Now to choose the base game, Standard Edition, or Legacy Edition. Browser launches are simulated.',
      category: 'offline',
      isFeatured: true,
      topPickRank: 1,
      exePath: 'C:\\Preview\\base.exe',
      variations: [
        { label: 'Standard Edition', path: 'C:\\Preview\\standard.exe' },
        { name: 'Legacy Edition', exePath: 'C:\\Preview\\legacy.exe' },
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
