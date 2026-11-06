import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import path from 'path'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'

const configDirectory = path.dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(path.resolve(configDirectory, 'package.json'), 'utf-8'))

// "YYYY-MM-DD HH:mm:ss" in Taiwan time, regardless of the build machine's timezone
const buildTime = new Date()
  .toLocaleString('sv-SE', { timeZone: 'Asia/Taipei', hour12: false })

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_TIME__: JSON.stringify(buildTime)
  },
  plugins: [
    vue()
  ],
  resolve: {
    alias: {
      '@': path.resolve(configDirectory, './src')
    }
  },
  server: {
    port: 5173,
    host: true
  }
})
