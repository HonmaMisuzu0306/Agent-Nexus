import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

// Test-only entry: exercises Electron, the real preload and service without designing a product UI.
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: { outDir: '.runtime/core/main', rollupOptions: { input: 'tests/electron-core-main.ts', output: { entryFileNames: 'index.js' } } }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { outDir: '.runtime/core/preload', rollupOptions: { input: 'apps/desktop/src/preload/index.ts' } }
  }
});
