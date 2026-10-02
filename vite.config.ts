import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Mirrored by the desktop static server (src/main/index.ts) in `npm start`.
    proxy: {
      '/api': 'http://localhost:8787',
    },
  },
})
