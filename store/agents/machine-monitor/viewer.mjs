/**
 * The pane: a read-only loopback server that publishes one observation of the fleet and streams
 * every new one to the page beside the terminal.
 *
 * It serves three files and two endpoints. Everything that changes a machine — a name, a link, a
 * removal — happens in the conversation, through the agent, so the map is a mirror of what Harness
 * reports and not a second control panel.
 *
 * There is exactly ONE write, and it exists for a secret: another machine's remote password. That
 * password is the person's, and typing it to an agent would put it in a transcript, so the row that
 * needs it takes it here instead — straight into `harness link connect`'s stdin, never stored,
 * never logged, never in a snapshot. Nothing else on this server accepts input.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { atomicJson, operations, PACKAGE, recordOperation, stateDir, writeVerdict } from './lib/fleet.mjs';
import { linkMachine } from './lib/ops.mjs';
import { createCollector } from './lib/snapshot.mjs';

const EMPTY = {
  spec: 1, status: 'connecting', message: null, observedAt: null, pollIntervalMs: 15_000,
  account: null, localMachineId: null, thisComputer: null,
  machines: [], projects: [], operations: [], totals: null,
  summary: { machines: 0, online: 0, needsLink: 0, harnesses: 0, open: 0, projects: 0, engines: {} },
  sources: {},
};

export function createViewer({ workspace, port = 0, intervalMs = 15_000, collect = createCollector(workspace, { intervalMs }) }) {
  const clients = new Set();
  let snapshot = { ...EMPTY, pollIntervalMs: intervalMs };
  let stopped = false, pollTimer, opTimer, heartbeat, linking = false;
  // The poll in flight, so close() can wait for it instead of leaving a write racing the exit.
  let polling = null;
  const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };
  const json = (res, code, value) => { res.writeHead(code, { ...headers, 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
  const publish = () => {
    const body = `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`;
    for (const client of clients) {
      if (client.writableLength > 256 * 1024) { client.destroy(); clients.delete(client); }
      else client.write(body);
    }
  };

  const server = createServer(async (req, res) => {
    try {
      const address = server.address();
      const hosts = new Set([`127.0.0.1:${address?.port}`, `localhost:${address?.port}`, `[::1]:${address?.port}`]);
      if (!hosts.has(req.headers.host)) { json(res, 403, { error: 'Loopback requests only.' }); return; }
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (req.headers.origin && req.headers.origin !== url.origin) { json(res, 403, { error: 'Cross-origin requests are not allowed.' }); return; }
      // The one write: a remote password, on its way to `harness link connect` and nowhere else.
      if (req.method === 'POST' && url.pathname === '/api/link') {
        if (linking) { json(res, 409, { error: 'One link at a time.' }); return; }
        let body = '';
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 4096) { json(res, 413, { error: 'Too large.' }); return; }
        }
        let request = {};
        try { request = JSON.parse(body || '{}'); } catch { json(res, 400, { error: 'Send JSON.' }); return; }
        const machineId = String(request.machineId ?? '');
        const password = typeof request.password === 'string' ? request.password : '';
        const machine = snapshot.machines.find(row => row.id === machineId);
        if (!machine) { json(res, 404, { error: 'That machine is not on this account.' }); return; }
        if (!password.trim()) { json(res, 400, { error: 'Enter the remote password set on that machine.' }); return; }
        linking = true;
        try {
          const result = await linkMachine(machineId, password, { displayName: machine.name });
          await recordOperation(workspace, {
            kind: 'link', machineId, machine: machine.name, ok: result.ok,
            detail: result.ok ? `Linked ${machine.name} from the pane` : `Link refused: ${result.error}`,
          });
          if (!result.ok) { json(res, 400, { error: result.error }); return; }
          json(res, 200, { ok: true });
          clearTimeout(pollTimer);
          polling = poll();
        } finally { linking = false; }
        return;
      }
      if (!['GET', 'HEAD'].includes(req.method)) {
        res.setHeader('allow', 'GET, HEAD, POST');
        json(res, 405, { error: 'This pane is read-only. Ask the Machine Monitor agent to change something.' });
        return;
      }
      if (url.pathname === '/health') { json(res, 200, { ok: true }); return; }
      if (url.pathname === '/api/snapshot') { json(res, 200, snapshot); return; }
      if (url.pathname === '/events') {
        if (req.method === 'HEAD') { res.writeHead(200, headers); res.end(); return; }
        if (clients.size >= 32) { json(res, 503, { error: 'Too many viewer connections.' }); return; }
        res.writeHead(200, { ...headers, 'content-type': 'text/event-stream', connection: 'keep-alive', 'x-accel-buffering': 'no' });
        res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
        clients.add(res); res.on('close', () => clients.delete(res));
        return;
      }
      const assets = {
        '/': ['index.html', 'text/html; charset=utf-8'],
        '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
        '/app.css': ['app.css', 'text/css; charset=utf-8'],
      };
      if (!assets[url.pathname]) { json(res, 404, { error: 'Not found' }); return; }
      const [file, contentType] = assets[url.pathname];
      const content = await readFile(join(PACKAGE, 'viewer', file));
      res.writeHead(200, {
        ...headers, 'content-type': contentType,
        'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'",
      });
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch {
      if (!res.headersSent) json(res, 500, { error: 'The pane could not serve this request.' }); else res.end();
    }
  });

  async function poll() {
    try {
      const observed = await collect();
      // A poll that lands after close() has nothing to publish: the workspace may already be gone,
      // and a write from a viewer that is shutting down is a file nobody asked for.
      if (stopped) return;
      snapshot = { ...observed, operations: snapshot.operations ?? [] };
      // The agent reads this file instead of polling Harness a second time; the header reads the verdict.
      await atomicJson(join(stateDir(workspace), 'snapshot.json'), snapshot).catch(() => {});
      await writeVerdict(workspace, snapshot).catch(() => {});
    } catch (error) {
      if (stopped) return;
      snapshot = {
        ...snapshot, status: 'unavailable',
        message: 'The fleet could not be read. Ask the agent to check that Harness is running on this computer.',
        machines: snapshot.machines.map(machine => ({ ...machine, stale: true })),
        sources: { ...snapshot.sources, collector: { ok: false, error: String(error?.message || error).slice(0, 200) } },
      };
      await writeVerdict(workspace, snapshot).catch(() => {});
    }
    if (stopped) return;
    publish();
    pollTimer = setTimeout(() => { polling = poll(); }, intervalMs);
  }

  async function pollOperations() {
    const latest = await operations(workspace).catch(() => []);
    if (!stopped && JSON.stringify(latest) !== JSON.stringify(snapshot.operations)) {
      snapshot = { ...snapshot, operations: latest };
      publish();
    }
    if (!stopped) opTimer = setTimeout(pollOperations, 1500);
  }

  return {
    server,
    start: () => new Promise((ok, fail) => {
      server.once('error', fail);
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', fail);
        polling = poll(); pollOperations();
        heartbeat = setInterval(() => { for (const client of clients) client.write(': pulse\n\n'); }, 20_000);
        ok(server.address().port);
      });
    }),
    close: async () => {
      stopped = true;
      clearTimeout(pollTimer); clearTimeout(opTimer); clearInterval(heartbeat);
      await polling?.catch(() => {});
      for (const client of clients) client.end();
      server.closeAllConnections();
      await new Promise(done => server.close(done));
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const workspace = resolve(process.env.HARNESS_WORKSPACE || process.cwd());
  const port = Number(process.env.HARNESS_VIEWER_PORT || 0);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('HARNESS_VIEWER_PORT must be a port number.');
  const viewer = createViewer({ workspace, port });
  console.log(`[machine-monitor] http://127.0.0.1:${await viewer.start()}/`);
  const close = () => viewer.close().then(() => process.exit(0));
  process.once('SIGINT', close); process.once('SIGTERM', close);
}
