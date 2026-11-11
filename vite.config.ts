import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  build: {
    target: 'safari16',
    rollupOptions: { input: { main: 'index.html', check: 'check.html' } },
  },
});
