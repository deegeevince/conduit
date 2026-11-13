import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import type { Hono } from 'hono';
import { errors } from '../errors';

const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * Serves the built web app from `directory` for everything outside /api.
 * Hashed assets are cached for a year; HTML is never cached.
 */
export function registerStatic(app: Hono, directory: string): void {
  const root = resolve(directory);

  app.get('*', async (c) => {
    let path: string;
    try {
      path = decodeURIComponent(c.req.path);
    } catch {
      throw errors.badRequest('malformed path');
    }
    if (path.endsWith('/')) path += 'index.html';
    const file = resolve(root, `.${path}`);
    if (file !== root && !file.startsWith(root + sep)) throw errors.notFound(c.req.path);

    const info = await stat(file).catch(() => null);
    if (info === null || !info.isFile()) throw errors.notFound(c.req.path);

    const extension = extname(file).toLowerCase();
    const hashed = path.startsWith('/assets/');
    c.header('Content-Type', TYPES[extension] ?? 'application/octet-stream');
    c.header('Cache-Control', extension === '.html' ? 'no-cache' : hashed ? 'public, max-age=31536000, immutable' : 'public, max-age=3600');
    return c.body(new Uint8Array(await readFile(file)));
  });
}
