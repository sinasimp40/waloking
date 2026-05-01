import React from 'react'
import ReactDOM from 'react-dom/client'
import '@fontsource/orbitron/400.css'
import '@fontsource/orbitron/500.css'
import '@fontsource/orbitron/600.css'
import '@fontsource/orbitron/700.css'
import '@fontsource/orbitron/800.css'
import '@fontsource/orbitron/900.css'
import '@fontsource/rajdhani/300.css'
import '@fontsource/rajdhani/400.css'
import '@fontsource/rajdhani/500.css'
import '@fontsource/rajdhani/600.css'
import '@fontsource/rajdhani/700.css'
import App from './App.jsx'
import useStore from './store/useStore'
import './index.css'

async function boot() {
  const legacyKeys = ['xyberzone-storage', 'denfi-storage', 'pikakz-storage', 'gamerzspot-storage', 'jahel-gamers-storage', 'nextreme-gaming-hub-storage']
  const newKey = 'o-brien-cafe-storage'
  if (!localStorage.getItem(newKey)) {
    for (const oldKey of legacyKeys) {
      if (localStorage.getItem(oldKey)) {
        localStorage.setItem(newKey, localStorage.getItem(oldKey))
        localStorage.removeItem(oldKey)
        break
      }
    }
  }

  if (window.electronAPI?.loadSettings) {
    try {
      const fileData = await window.electronAPI.loadSettings()
      if (fileData) {
        const current = localStorage.getItem('o-brien-cafe-storage')
        const fileStr = JSON.stringify(fileData)
        if (current !== fileStr) {
          localStorage.setItem('o-brien-cafe-storage', fileStr)
        }
        const state = fileData?.state || fileData
        if (state?.games) {
          useStore.setState({ games: state.games })
        }
        if (state?.settings) {
          useStore.setState({ settings: { ...useStore.getState().settings, ...state.settings } })
        }
      }
    } catch (e) {}
  }

  try {
    if (document.fonts && typeof document.fonts.load === 'function') {
      const loads = [
        document.fonts.load('300 1em "Rajdhani"'),
        document.fonts.load('400 1em "Rajdhani"'),
        document.fonts.load('500 1em "Rajdhani"'),
        document.fonts.load('600 1em "Rajdhani"'),
        document.fonts.load('700 1em "Rajdhani"'),
        document.fonts.load('400 1em "Orbitron"'),
        document.fonts.load('500 1em "Orbitron"'),
        document.fonts.load('600 1em "Orbitron"'),
        document.fonts.load('700 1em "Orbitron"'),
        document.fonts.load('800 1em "Orbitron"'),
        document.fonts.load('900 1em "Orbitron"'),
      ]
      await Promise.race([
        Promise.allSettled(loads),
        new Promise((resolve) => setTimeout(resolve, 1500)),
      ])
    }
  } catch (e) {}

  ReactDOM.createRoot(document.getElementById('root')).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  )

  requestAnimationFrame(() => {
    document.body.classList.add('app-ready')
  })
}

boot()
