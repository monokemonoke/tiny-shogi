import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        game: resolve(__dirname, 'game.html'),
        explain: resolve(__dirname, 'explain.html'),
        rules: resolve(__dirname, 'rules.html'),
        privacy: resolve(__dirname, 'privacy.html'),
        credits: resolve(__dirname, 'credits.html'),
        boardEditor: resolve(__dirname, 'board_editor.html'),
        sprint: resolve(__dirname, 'sprint.html'),
      },
      output: {
        manualChunks(id) {
          if (id.includes('/node_modules/three/')) {
            return 'three';
          }
          return undefined;
        },
      },
    },
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8788',
        changeOrigin: true,
      },
    },
  },
});
