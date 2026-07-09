import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// Replit (and most PaaS targets) assign the port to listen on via $PORT at runtime.
// This only matters for `npm run dev` / `npm run preview` — the recommended production
// deployment for this app is Replit's Static target, which serves dist/ directly with
// no long-running server process and therefore no port to bind. See REPLIT_DEPLOYMENT.md.
const PORT = Number(process.env.PORT) || Number(process.env.VITE_PORT) || 5173;

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'Truck Ranch — Final QC',
        short_name: 'Final QC',
        description: 'Truck Ranch FRPS Final QC — offline-first vehicle quality-control inspection app',
        theme_color: '#262220',
        background_color: '#E7E1DA',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
            handler: 'CacheFirst',
            options: { cacheName: 'google-fonts-stylesheets' },
          },
          {
            urlPattern: /^https:\/\/fonts\.gstatic\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts-webfonts',
              cacheableResponse: { statuses: [0, 200] },
              expiration: { maxAgeSeconds: 60 * 60 * 24 * 365, maxEntries: 30 },
            },
          },
        ],
      },
    }),
  ],
  server: {
    host: '0.0.0.0',
    port: PORT,
    strictPort: true,
    // Replit serves the dev server behind a proxy on a *.replit.dev host.
    allowedHosts: true,
    hmr: { clientPort: 443 },
  },
  preview: {
    host: '0.0.0.0',
    port: PORT,
    strictPort: true,
    allowedHosts: true,
  },
});
