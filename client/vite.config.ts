import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    rollupOptions: {
      output: {
        // Split the heavy 3D/physics engines into their own chunk. They
        // change far less often than app code, so on a low-end PC a
        // redeploy only re-downloads the small app chunk instead of the
        // whole bundle every time — the vendor chunk stays cached.
        manualChunks(id) {
          if (
            id.includes('node_modules') &&
            /[\\/](three|@react-three|postprocessing)[\\/]/.test(id)
          ) {
            return 'vendor';
          }
        },
      },
    },
  },
})
