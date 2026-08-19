import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import igdbPlugin from './vite-igdb-plugin.js'

export default defineConfig({
  plugins: [react(), igdbPlugin()],
  resolve: {
    alias: {
      '@assets': path.resolve(__dirname, 'attached_assets'),
      '@': path.resolve(__dirname, 'src')
    }
  },
  server: {
    port: 5000,
    host: '0.0.0.0',
    allowedHosts: true
  },
  base: './'
})
