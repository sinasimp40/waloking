import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { readFileSync } from 'fs'
import igdbPlugin from './vite-igdb-plugin.js'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url)))

export default defineConfig({
  plugins: [react(), igdbPlugin()],
  define: {
    // Available as a global constant in all source files.
    // In packaged builds the real version comes from electronAPI.getOtaConfig();
    // this serves as the browser-preview fallback.
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src')
    }
  },
  server: {
    port: 5174,
    host: '0.0.0.0',
    allowedHosts: true
  },
  base: './'
})
