import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// Dev-only proxy: browsers block cross-origin WebDAV. Electron/Android use native HTTP instead.
const DEV_DAV = process.env.DAV_URL || loadEnv('development', process.cwd(), '').VITE_DAV_ORIGIN || 'http://127.0.0.1:8080'

export default defineConfig({
  base: './',
  plugins: [react()],
  build: { outDir: 'dist', chunkSizeWarningLimit: 2000 },
  server: { port: 5173, proxy: { '/dav': { target: DEV_DAV, changeOrigin: true, rewrite: p => p.replace(/^\/dav/, '') } } },
})
