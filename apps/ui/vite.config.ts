import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev-only proxy to the local nanofish server; in production the server
// serves the built UI itself, so /api is same-origin and needs no proxy.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3470',
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
