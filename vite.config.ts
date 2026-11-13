import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import { viteStaticCopy } from 'vite-plugin-static-copy'

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    ...viteStaticCopy({
      targets: ['Workers', 'Assets', 'Widgets', 'ThirdParty'].map((directory) => ({
        src: `node_modules/cesium/Build/Cesium/${directory}/**/*`,
        dest: `cesiumStatic/${directory}`,
        rename: { stripBase: 5 },
      })),
    }),
  ],
  define: {
    CESIUM_BASE_URL: JSON.stringify('/cesiumStatic'),
  },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:8000',
    },
  },
})
