import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { flowFiles } from './server/flows'
import { dataEngine } from './server/engine'

export default defineConfig({
  plugins: [react(), flowFiles('flows'), dataEngine('data/history')],
  server: {
    // Flow files are written while you edit; they're data, not source, so don't reload on change.
    watch: { ignored: ['**/flows/**', '**/data/**'] },
  },
})
