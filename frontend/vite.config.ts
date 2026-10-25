import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import path from 'path'
import { readFileSync } from 'fs'

const pkg = JSON.parse(readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8'))

// "YYYY-MM-DD HH:mm:ss" in Taiwan time, regardless of the build machine's timezone
const buildTime = new Date()
  .toLocaleString('sv-SE', { timeZone: 'Asia/Taipei', hour12: false })

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_TIME__: JSON.stringify(buildTime)
  },
  plugins: [
    vue({
      template: {
        compilerOptions: {
          // Treat model-viewer as a custom element
          isCustomElement: (tag) => tag === 'model-viewer'
        }
      }
    })
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src')
    }
  },
  server: {
    port: 5173,
    host: true
  }
})
