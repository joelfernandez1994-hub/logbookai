import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Minimal, STANDALONE vitest config. Deliberately does NOT load vite.config.js
// (and the @base44/vite-plugin), which hangs the test bootstrap. Vitest prefers
// this file over vite.config.js, so the plugin never runs here.
//   Run: npx vitest run
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/lib/**/*.test.js'],
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
    globals: false,
    reporters: ['default'],
  },
});