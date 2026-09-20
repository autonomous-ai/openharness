import http from 'node:http';

// Multiple views of one workspace share one controller and job queue. The native
// host assigns a fresh viewer port; this loopback relay serves that port without
// opening a second writer against the workspace's history.
export function createViewerRelay(targetPort) {
  if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) throw new Error('Invalid local service port.');
  const server = http.createServer((req, res) => {
    const port = server.address().port;
    const host = req.headers.host;
    const reject = (status, message) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: message })); };
    if (![`localhost:${port}`, `127.0.0.1:${port}`].includes(host)) return reject(403, 'Local requests only.');
    if (req.headers.origin && req.headers.origin !== `http://${host}` || req.headers['sec-fetch-site'] === 'cross-site') return reject(403, 'Cross-origin control is disabled.');
    if (!req.url.startsWith('/') || req.url.startsWith('//')) return reject(400, 'Invalid local path.');
    const headers = { ...req.headers, host: `127.0.0.1:${targetPort}` };
    if (headers.origin) headers.origin = `http://127.0.0.1:${targetPort}`;
    const upstream = http.request({ hostname: '127.0.0.1', port: targetPort, path: req.url, method: req.method, headers }, response => {
      res.writeHead(response.statusCode || 502, response.headers); response.pipe(res);
    });
    upstream.on('error', () => { if (!res.headersSent) reject(502, 'The workspace service stopped. Reopen this viewer to reconnect.'); else res.end(); });
    req.on('aborted', () => upstream.destroy()); res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  });
  server.requestTimeout = 30000;
  return server;
}
