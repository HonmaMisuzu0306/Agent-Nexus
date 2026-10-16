import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  main: { plugins: [externalizeDepsPlugin()], build: { rollupOptions: { input: 'apps/desktop/src/main/index.ts' } } },
  preload: { plugins: [externalizeDepsPlugin()], build: { rollupOptions: { input: 'apps/desktop/src/preload/index.ts' } } },
  renderer: {
    root: 'apps/desktop/src/renderer', plugins: [react(), tailwindcss()],
    build: { minify: 'esbuild', rollupOptions: { input: 'apps/desktop/src/renderer/index.html' } }
  }
});
