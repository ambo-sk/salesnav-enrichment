import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.json';

export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    crx({ manifest: manifest as any }),
  ],
  define: {
    __DEV__: JSON.stringify(mode === 'development'),
  },
  base: './',
  build: {
    rollupOptions: {
      input: {
        popup: 'src/popup/popup.html',
        options: 'src/options/options.html',
      },
    },
  },
}));
