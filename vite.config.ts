import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: { include: ['src/**/*.test.ts'], environment: 'node' },
  build: {
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          const path = id.replaceAll('\\', '/');
          if (!path.includes('/node_modules/')) return;
          if (path.includes('/@firebase/') || path.includes('/firebase/')) return 'firebase';
          if (
            path.includes('/recharts/') ||
            path.includes('/d3-') ||
            path.includes('/victory-vendor/')
          )
            return 'charts';
          if (
            path.includes('/react/') ||
            path.includes('/react-dom/') ||
            path.includes('/scheduler/')
          )
            return 'react-vendor';
        },
      },
    },
  },
});
