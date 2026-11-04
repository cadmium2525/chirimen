import { defineConfig } from 'vite';

// GitHub Pages（https://<user>.github.io/<repo>/）でも動くよう相対パスでビルド
export default defineConfig({
  base: './',
  build: { target: 'es2020', chunkSizeWarningLimit: 1000 },
});
