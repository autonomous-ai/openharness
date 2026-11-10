// The Files pane: a folder's files listed, Markdown and text read and edited, pictures and PDFs shown.
// One Node file with no dependencies. It serves the workspace and nothing outside it, hides dot-files and
// node_modules, and writes only text files, atomically, refusing a save over a change it has not seen.
// Every request but the page itself carries the page's token, so another page in a browser on this
// computer cannot read or write through this port.
import { createReadStream, watch } from 'node:fs';
import { mkdir, readdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { basename, dirname, extname, isAbsolute, join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export const TEXT = new Set(['.md', '.markdown', '.txt', '.log', '.json', '.csv', '.tsv', '.yaml', '.yml', '.toml',
  '.ini', '.cfg', '.conf', '.xml', '.html', '.htm', '.css', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.sh',
  '.rb', '.go', '.rs', '.java', '.c', '.h', '.cpp', '.sql', '.srt', '.vtt', '.tex', '.rst', '.org']);
export const MARKDOWN = new Set(['.md', '.markdown']);
const IMAGE = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.avif': 'image/avif',
};
const PDF = 'application/pdf';
/** The largest text the editor opens or saves; a larger file is shown as a file, not edited. */
export const TEXT_LIMIT = 2 * 1024 * 1024;
/** The largest file the pane sends at all. */
const RAW_LIMIT = 256 * 1024 * 1024;
const LIST_LIMIT = 2000;

const hiddenPart = (part) => part.startsWith('.') || part === 'node_modules';
const hidden = (rel) => rel.split(/[\\/]/).some((part) => part && hiddenPart(part));

/** What the pane does with a file of this name. */
export function kindOf(name) {
  const ext = extname(name).toLowerCase();
  if (MARKDOWN.has(ext)) return 'markdown';
  if (TEXT.has(ext)) return 'text';
  if (IMAGE[ext]) return 'image';
  if (ext === '.pdf') return 'pdf';
  return 'other';
}

function textMime(ext) {
  return ext === '.json' ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8';
}

export async function createFilesViewer(workspace, options = {}) {
  const root = await realpath(workspace);
  const token = options.token ?? randomBytes(24).toString('hex');
  const page = (await readFile(new URL('app/index.html', import.meta.url), 'utf8')).replace('__FILES_TOKEN__', token);
  const clients = new Set();

  /** A path inside the workspace, as the person names it ("notes/a.md"), or null for anything else. */
  async function inside(rel, { mustExist = true } = {}) {
    if (typeof rel !== 'string' || rel.length > 4096 || rel.includes('\0')) return null;
    const clean = rel.replace(/^\/+/, '');
    if (isAbsolute(clean) || clean.split(/[\\/]/).includes('..') || hidden(clean)) return null;
    const full = join(root, clean);
    try {
      // An existing name is followed to what it is (a link out of the folder is refused below); a new one is
      // judged by the folder it goes in.
      const real = await realpath(full).catch(async (error) => {
        if (mustExist || error.code !== 'ENOENT') throw error;
        return join(await realpath(dirname(full)), basename(full));
      });
      const within = relative(root, real);
      if (within.startsWith('..') || isAbsolute(within) || hidden(within)) return null;
      return { full: real, rel: within.split(sep).join('/') };
    } catch {
      return null;
    }
  }

  const watcher = watch(root, { recursive: true }, (_event, name) => {
    const rel = name ? String(name).split(sep).join('/') : '';
    if (rel && hidden(rel)) return;
    for (const client of clients) client.write(`event: change\ndata: ${JSON.stringify({ path: rel })}\n\n`);
  });
  watcher.on('error', () => {
    for (const client of clients) client.write('event: watch-error\ndata: {}\n\n');
  });
  const heartbeat = setInterval(() => { for (const client of clients) client.write(': alive\n\n'); }, 15000);
  heartbeat.unref();

  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const fail = (res, status, error) => json(res, status, { error });

  async function body(req, limit) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) throw Object.assign(new Error('too large'), { status: 413 });
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  async function list(res, rel) {
    const dir = rel ? await inside(rel) : { full: root, rel: '' };
    if (!dir) return fail(res, 404, 'No such folder.');
    let names;
    try { names = await readdir(dir.full, { withFileTypes: true }); } catch { return fail(res, 404, 'No such folder.'); }
    const entries = [];
    for (const entry of names) {
      if (hiddenPart(entry.name) || entries.length >= LIST_LIMIT) continue;
      const path = dir.rel ? `${dir.rel}/${entry.name}` : entry.name;
      try {
        const info = await stat(join(dir.full, entry.name));
        const isDir = info.isDirectory();
        if (!isDir && !info.isFile()) continue;
        entries.push({ name: entry.name, path, dir: isDir, size: isDir ? null : info.size, mtime: info.mtimeMs,
          kind: isDir ? 'folder' : kindOf(entry.name) });
      } catch { /* gone, or not ours to read */ }
    }
    entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.dir ? -1 : 1));
    return json(res, 200, { dir: dir.rel, name: dir.rel ? basename(dir.rel) : basename(root), entries });
  }

  async function readText(res, rel) {
    const file = await inside(rel);
    if (!file) return fail(res, 404, 'No such file.');
    const info = await stat(file.full).catch(() => null);
    if (!info?.isFile()) return fail(res, 404, 'No such file.');
    if (kindOf(file.rel) !== 'markdown' && kindOf(file.rel) !== 'text') return fail(res, 415, 'Not a text file.');
    if (info.size > TEXT_LIMIT) return fail(res, 413, 'Too large to edit here.');
    return json(res, 200, { path: file.rel, text: await readFile(file.full, 'utf8'), version: info.mtimeMs, size: info.size });
  }

  async function writeText(req, res, rel) {
    if (kindOf(rel ?? '') !== 'markdown' && kindOf(rel ?? '') !== 'text') return fail(res, 415, 'Only text files are written here.');
    const file = await inside(rel, { mustExist: false });
    if (!file) return fail(res, 404, 'Not a place in this folder.');
    let input;
    try { input = JSON.parse(await body(req, TEXT_LIMIT * 2)); } catch (error) {
      return fail(res, error.status ?? 400, error.status ? 'Too large to save here.' : 'Not a save.');
    }
    if (typeof input?.text !== 'string') return fail(res, 400, 'Not a save.');
    if (Buffer.byteLength(input.text) > TEXT_LIMIT) return fail(res, 413, 'Too large to save here.');
    const info = await stat(file.full).catch(() => null);
    if (info && !info.isFile()) return fail(res, 409, 'A folder has that name.');
    // A save names the version it was made from; one made from another, or a new file where one now is, waits.
    if (input.version === null ? info : !info || info.mtimeMs !== input.version) {
      return json(res, 409, { error: 'The file changed since it was opened.', version: info?.mtimeMs ?? null });
    }
    const temp = join(dirname(file.full), `.${basename(file.full)}.${randomBytes(6).toString('hex')}.tmp`);
    try {
      await writeFile(temp, input.text, { mode: info ? info.mode & 0o777 : 0o644 });
      await rename(temp, file.full);
    } catch {
      await unlink(temp).catch(() => {});
      return fail(res, 500, 'Could not save.');
    }
    const saved = await stat(file.full);
    return json(res, 200, { path: file.rel, version: saved.mtimeMs, size: saved.size });
  }

  async function makeFolder(res, rel) {
    const dir = await inside(rel, { mustExist: false });
    if (!dir) return fail(res, 404, 'Not a place in this folder.');
    try { await mkdir(dir.full); } catch { return fail(res, 409, 'Could not make that folder.'); }
    return json(res, 200, { path: dir.rel });
  }

  async function raw(req, res, rel) {
    const file = await inside(rel);
    if (!file) return fail(res, 404, 'No such file.');
    const info = await stat(file.full).catch(() => null);
    if (!info?.isFile()) return fail(res, 404, 'No such file.');
    if (info.size > RAW_LIMIT) return fail(res, 413, 'Too large to show here.');
    const ext = extname(file.full).toLowerCase();
    const type = IMAGE[ext] ?? (ext === '.pdf' ? PDF : TEXT.has(ext) ? textMime(ext) : 'application/octet-stream');
    const headers = {
      'content-type': type, 'content-length': info.size, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
      'content-disposition': `${type === 'application/octet-stream' ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(basename(file.full))}`,
    };
    // A file opened on its own never runs as a page of this origin (an SVG's script, an HTML file); a PDF keeps the
    // browser's own reader.
    if (type !== PDF) headers['content-security-policy'] = "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'";
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    createReadStream(file.full).on('error', () => res.destroy()).pipe(res);
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname;
      if (path === '/' && (req.method === 'GET' || req.method === 'HEAD')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
          'content-security-policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'unsafe-inline'; frame-src 'self'; object-src 'self'; base-uri 'none'; form-action 'none'" });
        return res.end(req.method === 'HEAD' ? undefined : page);
      }
      // The token: a header on what the page fetches, the query on what it loads as an image, a frame or events.
      const sent = req.headers['x-files-token'] ?? url.searchParams.get('t');
      if (sent !== token) return fail(res, 403, 'Open the Files pane to use this.');
      const rel = url.searchParams.get('path');
      if (path === '/events' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write(': ready\n\n');
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      if (path === '/api/list' && req.method === 'GET') return await list(res, rel ?? '');
      if (path === '/api/text' && req.method === 'GET') return await readText(res, rel);
      if (path === '/api/text' && req.method === 'PUT') return await writeText(req, res, rel);
      if (path === '/api/folder' && req.method === 'POST') return await makeFolder(res, rel);
      if (path === '/raw' && (req.method === 'GET' || req.method === 'HEAD')) return await raw(req, res, rel);
      return fail(res, 404, 'Not found.');
    } catch {
      if (!res.headersSent) fail(res, 500, 'Something went wrong.');
      else res.destroy();
    }
  });

  return {
    server,
    token,
    close() {
      watcher.close();
      clearInterval(heartbeat);
      for (const client of clients) client.end();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.HARNESS_VIEWER_PORT);
  const workspace = process.env.HARNESS_WORKSPACE;
  if (!Number.isInteger(port) || port <= 0 || !workspace) {
    console.error('HARNESS_VIEWER_PORT and HARNESS_WORKSPACE are required');
    process.exit(1);
  }
  const viewer = await createFilesViewer(workspace);
  viewer.server.listen(port, '127.0.0.1', () => console.log(`[files] http://127.0.0.1:${port}/`));
  const stop = () => { viewer.close().finally(() => process.exit(0)); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
