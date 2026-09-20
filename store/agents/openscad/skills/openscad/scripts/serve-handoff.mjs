// A loopback-only download page. Never serves a workspace directory listing or
// arbitrary source files; the user-selected source bundle is an explicit export.
import {createServer} from 'node:http';
import {lstat, readFile, realpath} from 'node:fs/promises';
import {join, resolve, sep, extname} from 'node:path';
import {fileURLToPath} from 'node:url';

const allowed = /^(?:part\.stl|handoff\/(?:index\.html|app\.js|checks\.json|project\.zip|parts\/[a-z0-9-]+\.stl|views\/[a-z0-9-]+\.svg|source-previews\/[a-z0-9-]+\.scad))$/;
const types = {'.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.scad':'text/plain; charset=utf-8', '.json':'application/json; charset=utf-8', '.svg':'image/svg+xml', '.zip':'application/zip', '.step':'model/step', '.stl':'model/stl', '.FCStd':'application/octet-stream'};

export async function serve(workspace, port=0) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Port must be an integer from 0 to 65535');
  const root = await realpath(resolve(workspace));
  const server = createServer(async (request, response) => {
    const actualPort = server.address().port;
    if (![`127.0.0.1:${actualPort}`, `localhost:${actualPort}`].includes(request.headers.host)) {
      response.writeHead(403).end('Loopback host required'); return;
    }
    if (!['GET','HEAD'].includes(request.method)) { response.writeHead(405, {Allow:'GET, HEAD'}).end(); return; }
    try {
      const path = decodeURIComponent(new URL(request.url, `http://127.0.0.1:${actualPort}`).pathname);
      if (path === '/') { response.writeHead(302, {Location:'/handoff/index.html'}).end(); return; }
      const name = path.slice(1);
      if (!allowed.test(name)) { response.writeHead(404).end('Not a handoff artifact'); return; }
      let target = root;
      for (const component of name.split('/')) {
        target = join(target, component);
        if ((await lstat(target)).isSymbolicLink()) throw new Error('Symlink artifacts are not served');
      }
      if (!(await realpath(target)).startsWith(root + sep)) throw new Error('Artifact is outside the workspace');
      const bytes = await readFile(target);
      const extension = extname(name);
      const headers = {
        'Content-Type':types[extension], 'Content-Length':bytes.length, 'Cache-Control':'no-store',
        'X-Content-Type-Options':'nosniff', 'Cross-Origin-Resource-Policy':'same-origin',
        'Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      };
      if (!['.html','.svg','.js'].includes(extension)) headers['Content-Disposition'] = `attachment; filename="${name.split('/').at(-1)}"`;
      response.writeHead(200, headers).end(request.method === 'HEAD' ? undefined : bytes);
    } catch (error) {
      response.writeHead(404).end('Handoff artifact unavailable');
    }
  });
  await new Promise((resolveReady,reject) => { server.once('error',reject); server.listen(port,'127.0.0.1',resolveReady); });
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const workspace = process.argv[2] || process.env.HARNESS_WORKSPACE || process.cwd();
    const server = await serve(workspace, Number(process.argv[3] || 0));
    console.log(`Saved OpenSCAD handoff: http://127.0.0.1:${server.address().port}/handoff/index.html`);
    console.log('This page describes the last successful build. Rebuild after edits. Ctrl-C stops this local server.');
    const close = () => server.close(() => process.exit(0));
    process.on('SIGINT', close); process.on('SIGTERM', close);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
