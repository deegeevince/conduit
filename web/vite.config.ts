import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { lessonProgram } from './scripts/lesson-program';
import type { Plugin } from 'vite';

const page = (name: string): string => fileURLToPath(new URL(name, import.meta.url));
/** pages other packages add (the chart bench, the taste page) join the build once they exist */
const optional = (key: string, name: string): Record<string, string> => (existsSync(page(name)) ? { [key]: page(name) } : {});

/** The chat shell is a second page beside the first: `/chat` is its address, in the dev server as the built server serves it. */
const chatAddress = (): Plugin => ({
  name: 'chat-address',
  configureServer(server) {
    server.middlewares.use((request, _response, next) => {
      if (request.url !== undefined && /^\/chat(\?|$)/.test(request.url)) request.url = request.url.replace(/^\/chat/, '/chat.html');
      next();
    });
  },
});

// Lets parallel work run its own dev server and API without touching 4300/4301.
const devPort = Number(process.env['VITE_PORT'] ?? '4301');
const apiTarget = process.env['VITE_API'] ?? 'http://127.0.0.1:4300';

/** The commit the page was built from, for "Report a problem"; empty when git is not there. */
const commit = ((): string => {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return '';
  }
})();

export default defineConfig({
  define: { __BUILD_COMMIT__: JSON.stringify(commit) },
  plugins: [lessonProgram(), chatAddress()],
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
        chat: page('chat.html'),
        gallery: page('gallery.html'),
        explore: page('explore.html'),
        'bench-painter': page('bench-painter.html'),
        'bench-renderer': page('bench-renderer.html'),
        'bench-ui': page('bench-ui.html'),
        'bench-figure': page('bench-figure.html'),
        'bench-surface': page('bench-surface.html'),
        'bench-parity': page('bench-parity.html'),
        ...optional('bench-chart', 'bench-chart.html'),
        ...optional('bench-lesson', 'bench-lesson.html'),
        ...optional('taste', 'taste.html'),
        ...optional('bench-ink', 'bench-ink.html'),
        ...optional('bench-wall', 'bench-wall.html'),
        ...optional('bench-wall-hands', 'bench-wall-hands.html'),
      },
    },
  },
});
