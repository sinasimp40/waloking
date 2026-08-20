import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { mockupPreviewPlugin } from './mockupPreviewPlugin';

const port = Number(process.env.PORT || 23636);
const base = process.env.BASE_PATH || '/';

export default defineConfig({
  base,
  plugins: [react(), mockupPreviewPlugin()],
  server: {
    host: '0.0.0.0',
    port,
    strictPort: true,
    allowedHosts: true,
  },
});