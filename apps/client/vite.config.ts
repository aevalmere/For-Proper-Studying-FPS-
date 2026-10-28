import { defineConfig } from 'vite';

export default defineConfig({
  // Plain static build (deployed as Cloudflare static assets): relative asset
  // URLs so it works at the domain root or under a sub-path.
  base: './',
  server: { port: 5173, host: true },
  // three.js alone is ~640 kB minified; one chunk is fine for a game client.
  build: { chunkSizeWarningLimit: 1000 },
});
