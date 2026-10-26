// A release build of the web app, served the way the website serves one
// (website/next.config.js headers(), website/scripts/fetch-harness-web.mjs):
// the page at /harness-web/ with no-store, rewritten by the website's own
// configureReleaseAssets to load the app from a folder named for this build,
// which is cached as immutable; the unversioned copy beside it revalidated
// every time; everything brotli-compressed at the level Cloudflare uses, with
// ETags. Any other path without an extension gets the page, as /s/… links do.
//
//   node tool/web_ux/serve-release.mjs <release-build-dir> [port]
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants } from 'node:zlib';
import { createHash } from 'node:crypto';
import { configureReleaseAssets, releaseAssetBase } from '../../../website/scripts/harness-web-assets.mjs';

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.webp': 'image/webp', '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon', '.bin': 'application/octet-stream', '.svg': 'image/svg+xml',
};

// The website's Cache-Control for each kind of path (next.config.js headers()).
const NO_STORE = 'no-store';
const IMMUTABLE = 'public, max-age=31536000, immutable';
const REVALIDATE = 'public, max-age=0, must-revalidate';

/// The release as the website publishes it: the page rewritten to load the
/// app from a folder named for this build, which is never reused.
async function release(root) {
  const main = await readFile(join(root, 'main.dart.js'));
  const meta = JSON.parse(await readFile(join(root, 'release.json'), 'utf8').catch(() => '{}'));
  const sha256 = createHash('sha256').update(main).digest('hex');
  const published = { version: meta.version ?? '0.0.0', sha256 };
  const page = configureReleaseAssets(await readFile(join(root, 'index.html'), 'utf8'), published);
  return { page, base: releaseAssetBase(published) };
}

export async function serveRelease(root, port = 0) {
  const { page, base } = await release(root);
  const files = new Map();
  async function file(path) {
    if (!files.has(path)) {
      const raw = await readFile(join(root, path)).catch(() => null);
      files.set(path, raw && {
        body: brotliCompressSync(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 3 } }),
        etag: `"${createHash('sha1').update(raw).digest('hex')}"`,
      });
    }
    return files.get(path);
  }
  const server = createServer(async (req, res) => {
    const pathname = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!pathname.startsWith('/harness-web/')) { res.writeHead(404); return res.end(); }
    let path = pathname.slice('/harness-web/'.length);
    let cacheControl = REVALIDATE;
    if (pathname.startsWith(base)) {
      path = pathname.slice(base.length);
      cacheControl = IMMUTABLE;
    }
    // The page, and any unknown path as /s/… links get it, is the versioned page.
    const entry = extname(path) === '' || path === 'index.html' ? null : await file(path);
    if (!entry && extname(path) !== '' && path !== 'index.html') { res.writeHead(404); return res.end(); }
    const body = entry ? entry.body : brotliCompressSync(page);
    const headers = {
      'content-type': TYPES[extname(path)] ?? 'text/html',
      'content-encoding': 'br',
      'cache-control': entry ? cacheControl : NO_STORE,
    };
    if (entry) headers.etag = entry.etag;
    if (entry && req.headers['if-none-match'] === entry.etag) {
      res.writeHead(304, { 'cache-control': headers['cache-control'], etag: entry.etag });
      return res.end();
    }
    res.writeHead(200, headers);
    res.end(body);
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () =>
    resolve({ origin: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [root, port] = process.argv.slice(2);
  const { origin } = await serveRelease(root, Number(port ?? 0));
  console.log(`${origin}/harness-web/`);
}
