import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { flowFiles } from './server/flows'
import { dataEngine } from './server/engine'

export default defineConfig(({ mode }) => {
  // The engine's keys live in .env (COINGECKO_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID): Vite doesn't put
  // them in process.env for server code on its own. Anything already set in the shell wins.
  for (const [k, v] of Object.entries(loadEnv(mode, process.cwd(), ''))) if (process.env[k] === undefined) process.env[k] = v
  return {
    plugins: [react(), flowFiles('flows'), dataEngine('data/history')],
    server: {
      // Flow files are written while you edit; they're data, not source, so don't reload on change.
      watch: { ignored: ['**/flows/**', '**/data/**'] },
    },
  }
})
