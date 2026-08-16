import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        'service-worker': resolve(__dirname, 'src/service-worker/index.ts'),
        popup: resolve(__dirname, 'popup.html'),
        offscreen: resolve(__dirname, 'offscreen.html'),
      },
      output: {
        // The manifest names the service worker file directly; everything else can use
        // content-hashed names like a normal multi-page build.
        entryFileNames: (chunk) =>
          chunk.name === 'service-worker' ? 'service-worker.js' : 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});
