// A shared, dependency-free preview. Only public files inside the workspace are served.
import { createReadStream, watch } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const mime = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8', '.geojson': 'application/geo+json', '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.mp4': 'video/mp4', '.webm': 'video/webm',
};
const hidden = (path) => path.split(/[\\/]/).some((part) => part.startsWith('.') || part === 'node_modules');

export async function createHtmlViewer(workspace) {
  const root = await realpath(workspace);
  // An opaque-origin sandbox needs CORS to fetch its own data and modules. A secret path
  // grants access to this preview without exposing the workspace to arbitrary null origins.
  const previewPrefix = `/preview/${randomBytes(24).toString('hex')}/`;
  const shell = (await readFile(new URL('preview.html', import.meta.url), 'utf8'))
    .replace('__PREVIEW_PREFIX__', previewPrefix);
  const clients = new Set();
  let pending;
  const watcher = watch(root, { recursive: true }, (_event, name) => {
    if (name && hidden(String(name))) return;
    clearTimeout(pending);
    pending = setTimeout(() => {
      for (const client of clients) client.write('event: change\ndata: reload\n\n');
    }, 80);
  });
  const heartbeat = setInterval(() => {
    for (const client of clients) client.write(': alive\n\n');
  }, 15000);
  heartbeat.unref();

  const server = createServer(async (req, res) => {
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    const end = (status, message) => { res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' }); res.end(message); };
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host ?? '')) return end(403, 'Loopback requests only.');
    if (req.method !== 'GET' && req.method !== 'HEAD') return end(405, 'Read-only preview.');
    let path;
    try { path = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname); }
    catch { return end(400, 'Invalid path.'); }
    if (path === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(req.method === 'HEAD' ? undefined : shell);
    }
    if (path === '/events' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'keep-alive' });
      res.write(': connected\n\n');
      clients.add(res);
      res.on('close', () => clients.delete(res));
      return;
    }
    const sandboxed = path.startsWith(previewPrefix);
    if (!sandboxed && !path.startsWith('/files/')) return end(404, 'Not found.');
    if (sandboxed) {
      res.setHeader('access-control-allow-origin', 'null');
      res.setHeader('vary', 'Origin');
    }
    const requested = path.slice(sandboxed ? previewPrefix.length : '/files/'.length);
    if (!requested || isAbsolute(requested) || hidden(requested)) return end(404, 'Not found.');
    try {
      const file = await realpath(join(root, requested));
      const inside = relative(root, file);
      if (isAbsolute(inside) || inside.startsWith('..') || hidden(inside)) return end(404, 'Not found.');
      const info = await stat(file);
      if (!info.isFile()) return end(404, 'Not found.');
      const extension = extname(file).toLowerCase();
      // Godot's standard single-threaded WASM engine is already larger than 32 MiB.
      const limitMiB = ['.wasm', '.pck'].includes(extension) ? 128 : 32;
      if (info.size > limitMiB * 1024 * 1024) return end(413, 'Preview files must be smaller than ' + limitMiB + ' MiB.');
      res.writeHead(200, { 'content-type': mime[extension] ?? 'application/octet-stream' });
      if (req.method === 'HEAD') return res.end();
      createReadStream(file).on('error', () => res.destroy()).pipe(res);
    } catch { end(404, 'No preview yet. Ask the agent to create index.html.'); }
  });
  watcher.on('error', () => {
    for (const client of clients) client.write('event: watch-error\ndata: Use Reload to see changes.\n\n');
  });
  server.on('close', () => {
    watcher.close();
    clearTimeout(pending);
    clearInterval(heartbeat);
    for (const client of clients) client.end();
  });
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.env.HARNESS_WORKSPACE) throw new Error('HARNESS_WORKSPACE is required.');
  const port = Number(process.env.HARNESS_VIEWER_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('HARNESS_VIEWER_PORT must be a valid port.');
  const server = await createHtmlViewer(process.env.HARNESS_WORKSPACE);
  server.listen(port, '127.0.0.1', () => console.log(`[web-viewer] http://127.0.0.1:${port}/`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    server.closeAllConnections();
    server.close();
  });
}
