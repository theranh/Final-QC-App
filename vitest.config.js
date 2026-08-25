import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': path.resolve(import.meta.dirname, 'shared'),
      'virtual:pwa-register': path.resolve(import.meta.dirname, 'src/test/pwaRegisterMock.js'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: false,
    include: ['src/**/*.test.{js,jsx}', 'server/**/*.test.ts'],
    setupFiles: ['src/test/setup.js'],
  },
});
