import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import useStore from './store/useStore'
import './index.css'

async function boot() {
  if (window.electronAPI?.loadSettings) {
    try {
      const fileData = await window.electronAPI.loadSettings()
      if (fileData) {
        localStorage.setItem('balok-storage', JSON.stringify(fileData))
        const state = fileData.state || fileData
        if (Array.isArray(state.games)) useStore.setState({ games: state.games })
        if (state.settings) {
          useStore.setState({ settings: { ...useStore.getState().settings, ...state.settings } })
        }
      }
    } catch (_) {}
  }

  ReactDOM.createRoot(document.getElementById('root')).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  )
}

boot()
