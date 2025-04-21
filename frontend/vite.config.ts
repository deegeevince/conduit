import { defineConfig } from 'vite'

export default defineConfig({
  root: './frontend',
  publicDir: '../assets', // Directory containing static assets like GIFs
  build: {
    outDir: '../public', // Output to /public for Express to serve
    emptyOutDir: true // Clean /public before building
  },
  server: {
    port: 5173,
    open: true
  }
})
