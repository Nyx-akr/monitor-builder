import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { flowFiles } from './vite-plugin-flows'

export default defineConfig({
  plugins: [react(), flowFiles('flows')],
  server: {
    // Flow files are written while you edit; they're data, not source, so don't reload on change.
    watch: { ignored: ['**/flows/**'] },
  },
})
