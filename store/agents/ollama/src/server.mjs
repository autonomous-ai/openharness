import http from 'node:http';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, dirname, resolve } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Store } from './store.mjs';
import { Controller } from './controller.mjs';
import { createViewerRelay } from './viewer-relay.mjs';

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const assets = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/styles.css': ['styles.css', 'text/css'], '/assets/ollama-icon.svg': ['assets/ollama-icon.svg', 'image/svg+xml'], '/assets/ollama-icon.png': ['assets/ollama-icon.png', 'image/png'], '/favicon.ico': ['assets/ollama-icon.png', 'image/png'], '/assets/mlx-icon.svg': ['assets/mlx-icon.svg', 'image/svg+xml'], '/assets/mlx-icon.png': ['assets/mlx-icon.png', 'image/png'] };
assets['/assets/vllm-icon.png'] = ['assets/vllm-icon.png', 'image/png'];
const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };

async function readBody(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw Object.assign(new Error('Use application/json for control requests.'), { status: 415 });
  if (Number(req.headers['content-length']) > 65536) throw Object.assign(new Error('Request too large.'), { status: 413 });
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 65536) throw Object.assign(new Error('Request too large.'), { status: 413 }); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Object.assign(new Error('Invalid JSON request.'), { status: 400 }); }
}

export function createServer(controller, { assetRoot = join(ROOT, 'dist') } = {}) {
  const token = randomBytes(32).toString('hex');
  const events = new Set();
  const sendEvent = (res, type, data) => { if (res.writableLength > 1024 * 1024) { res.destroy(); events.delete(res); } else if (!res.destroyed) res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`); };
  const onState = state => { for (const res of events) sendEvent(res, 'state', state); };
  const onJob = job => { for (const res of events) sendEvent(res, 'job', job); };
  controller.on('state', onState); controller.on('job', onJob);
  const server = http.createServer(async (req, res) => {
    try {
      const port = server.address()?.port;
      const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
      if (!hosts.includes(req.headers.host)) return json(res, 403, { error: 'Local requests only.' });
      const origin = `http://${req.headers.host}`;
      if (req.headers.origin && req.headers.origin !== origin || req.headers['sec-fetch-site'] === 'cross-site') return json(res, 403, { error: 'Cross-origin control is disabled.' });
      const url = new URL(req.url, origin);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'self'; base-uri 'none'; form-action 'self'");
      if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { application: 'local-ai-harnesses', protocol: 1, workspace: controller.workspace, runtime: controller.profile?.id || 'ollama', pid: process.pid });
      if (req.method === 'POST') {
        const submitted = Buffer.from(String(req.headers['x-harness-token'] || ''));
        const expected = Buffer.from(token);
        if (submitted.length !== expected.length || !timingSafeEqual(submitted, expected)) return json(res, 403, { error: 'Refresh the viewer before sending a control request.' });
        const body = await readBody(req);
        if (!body || typeof body !== 'object' || Array.isArray(body)) return json(res, 400, { error: 'Expected a JSON object.' });
        if (url.pathname === '/api/command') return json(res, 200, await controller.command(body.text, { selectedModel: body.selectedModel, history: body.history }));
        if (url.pathname === '/api/action') return json(res, 202, { kind: 'job', job: await controller.submit(body) });
        if (url.pathname === '/api/cancel') return json(res, 200, { job: await controller.cancel(body.id) });
      }
      if (req.method === 'GET' && url.pathname === '/api/state') { await controller.refresh(); return json(res, 200, { ...controller.snapshot(), token }); }
      if (req.method === 'GET' && url.pathname === '/api/jobs') return json(res, 200, { jobs: controller.snapshot().jobs });
      if (req.method === 'GET' && url.pathname === '/api/events') {
        if (events.size >= 32) return json(res, 503, { error: 'Too many viewer connections.' });
        res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.write('retry: 2000\n\n'); events.add(res); sendEvent(res, 'state', controller.snapshot());
        req.on('close', () => events.delete(res)); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/export') {
        res.setHeader('Content-Disposition', `attachment; filename="${controller.profile?.id || 'ollama'}-benchmarks.json"`);
        return json(res, 200, { exportedAt: new Date().toISOString(), system: controller.system, benchmarks: controller.snapshot().benchmarks, loadTests: controller.snapshot().loadTests });
      }
      if (req.method === 'GET' && Object.hasOwn(assets, url.pathname)) {
        let [file, type] = assets[url.pathname];
        if (url.pathname === '/favicon.ico' && controller.profile?.id === 'mlx-lm') file = 'assets/mlx-icon.png';
        if (url.pathname === '/favicon.ico' && controller.profile?.id === 'vllm') file = 'assets/vllm-icon.png';
        const data = await readFile(join(assetRoot, file));
        res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` }); return res.end(data);
      }
      json(res, 404, { error: 'Not found.' });
    } catch (error) { if (!res.headersSent) json(res, error.status || 400, { error: error.message }); else res.end(); }
  });
  const heartbeat = setInterval(() => { for (const res of events) res.write(': heartbeat\n\n'); }, 15000); heartbeat.unref();
  server.on('close', () => { clearInterval(heartbeat); controller.off('state', onState); controller.off('job', onJob); });
  server.closeEvents = () => { for (const res of events) res.end(); events.clear(); };
  server.requestTimeout = 30000;
  return server;
}

export async function start(port = Number(process.env.HARNESS_VIEWER_PORT || process.env.HARNESS_PORT || 4310), options = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('The viewer port must be between 0 and 65535.');
  const workspace = resolve(process.env.HARNESS_WORKSPACE || options.workspaceRoot || ROOT);
  const runtime = options.profile?.id || 'ollama';
  let marker;
  try { marker = JSON.parse(await readFile(join(workspace, 'local-ai.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (marker?.runtime && marker.runtime !== runtime) throw new Error(`This workspace belongs to ${marker.runtime}. Open a separate ${runtime} workspace.`);
  let existing;
  let conflictingRuntime;
  try {
    const endpoint = JSON.parse(await readFile(join(workspace, '.harness/endpoint.json'), 'utf8'));
    if (endpoint.workspace === workspace && Number.isInteger(endpoint.port) && endpoint.port > 0 && endpoint.port <= 65535) {
      const health = await (await fetch(`http://127.0.0.1:${endpoint.port}/api/health`, { signal: AbortSignal.timeout(1200) })).json();
      if (health.application === 'local-ai-harnesses' && health.workspace === workspace && health.pid === endpoint.pid) {
        if ((health.runtime || 'ollama') === runtime) existing = endpoint;
        else conflictingRuntime = health.runtime || 'ollama';
      }
    }
  } catch {}
  if (conflictingRuntime) throw new Error(`This workspace is already serving ${conflictingRuntime}. Open a separate ${runtime} workspace.`);
  if (existing) {
    if (existing.port === port) throw new Error(`This workspace is already running at http://127.0.0.1:${port}. Open that viewer instead of starting a second copy.`);
    const relay = createViewerRelay(existing.port);
    await new Promise((resolve, reject) => { relay.once('error', reject); relay.listen(port, '127.0.0.1', resolve); });
    console.log(`Local: http://127.0.0.1:${relay.address().port} (shared workspace service)`);
    const stopRelay = () => { relay.closeAllConnections(); relay.close(); };
    process.once('SIGINT', stopRelay); process.once('SIGTERM', stopRelay);
    return { server: relay, controller: null };
  }
  const store = await new Store(join(workspace, '.harness')).init();
  const controller = new Controller(store, options.adapter, options.profile);
  controller.workspace = workspace;
  const server = createServer(controller, options);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const boundPort = server.address().port;
  await writeFile(join(store.directory, 'endpoint.json'), JSON.stringify({ port: boundPort, pid: process.pid, workspace, runtime, startedAt: new Date().toISOString() }), { mode: 0o600 });
  console.log(`Local: http://127.0.0.1:${boundPort}`);
  let verdictWriting = Promise.resolve();
  let lastVerdict;
  const verdict = async snapshot => {
    const last = snapshot.jobs[0];
    const failed = last?.status === 'failed';
    const affected = last?.activeModel || last?.model || last?.models?.join(', ') || controller.profile.name;
    const failure = failed ? `${affected} · ${last.type} failed: ${last.message}` : undefined;
    const data = { spec: 1, ready: snapshot.runtime.online && !failed, summary: failed ? failure : snapshot.runtime.online ? `${snapshot.runtime.models.length} local models · ${controller.profile.name} connected` : `${controller.profile.name} is ready to start`, findings: failed ? [{ severity: 'error', kind: 'runtime', message: failure }] : [], updatedAt: new Date().toISOString() };
    const key = JSON.stringify({ ...data, updatedAt: undefined });
    if (key === lastVerdict) return;
    lastVerdict = key;
    verdictWriting = verdictWriting.catch(() => {}).then(async () => { const temp = join(store.directory, 'verdict.json.tmp'); await writeFile(temp, JSON.stringify(data, null, 2), { mode: 0o600 }); await rename(temp, join(store.directory, 'verdict.json')); });
    await verdictWriting;
  };
  controller.on('state', snapshot => { void verdict(snapshot).catch(() => {}); });
  controller.on('job', () => { void verdict(controller.snapshot()).catch(() => {}); });
  await controller.refresh();
  const poll = setInterval(() => { void controller.refresh().catch(error => console.error('Discovery:', error.message)); }, 5000); poll.unref();
  let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; clearInterval(poll); server.closeEvents(); server.close(); await controller.close(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  return { server, controller };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await start();
