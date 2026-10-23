// A static server for a Flutter web build that answers unknown paths with
// index.html, as the production host does for /s/… links.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png',
  '.ico': 'image/x-icon', '.otf': 'font/otf', '.ttf': 'font/ttf', '.svg': 'image/svg+xml',
};

export function serve(root, port = 0) {
  const server = createServer(async (req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname));
    const file = join(root, path.endsWith('/') ? 'index.html' : path);
    const body = await readFile(file).catch(() => readFile(join(root, 'index.html')));
    const type = TYPES[extname(file)] ?? 'text/html';
    res.writeHead(200, { 'content-type': type });
    res.end(body);
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve({
        origin: `http://127.0.0.1:${server.address().port}`,
        close: () => server.close(),
      });
    });
  });
}
