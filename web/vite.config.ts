import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { lessonProgram } from './scripts/lesson-program';

const page = (name: string): string => fileURLToPath(new URL(name, import.meta.url));
/** pages other packages add (the chart bench, the taste page) join the build once they exist */
const optional = (key: string, name: string): Record<string, string> => (existsSync(page(name)) ? { [key]: page(name) } : {});

// Lets parallel work run its own dev server and API without touching 4300/4301.
const devPort = Number(process.env['VITE_PORT'] ?? '4301');
const apiTarget = process.env['VITE_API'] ?? 'http://127.0.0.1:4300';

export default defineConfig({
  plugins: [lessonProgram()],
  server: {
    host: '127.0.0.1',
    port: devPort,
    strictPort: true,
    proxy: {
      '/api': { target: apiTarget, changeOrigin: false },
    },
  },
  preview: {
    host: '127.0.0.1',
    port: 4301,
    strictPort: true,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      input: {
        index: page('index.html'),
        gallery: page('gallery.html'),
        explore: page('explore.html'),
        'bench-painter': page('bench-painter.html'),
        'bench-renderer': page('bench-renderer.html'),
        'bench-ui': page('bench-ui.html'),
        'bench-surface': page('bench-surface.html'),
        ...optional('bench-chart', 'bench-chart.html'),
        ...optional('bench-lesson', 'bench-lesson.html'),
        ...optional('taste', 'taste.html'),
      },
    },
  },
});
