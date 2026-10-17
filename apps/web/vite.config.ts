import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  build: { rollupOptions: { output: { manualChunks(id) {
    if (id.includes('node_modules/@supabase') || id.includes('node_modules/@realtime') || id.includes('node_modules/@postgrest')) return 'supabase'
    if (id.includes('node_modules/react') || id.includes('node_modules/scheduler')) return 'react'
  } } } }
})
