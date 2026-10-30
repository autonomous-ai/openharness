import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// The pages agents read: /agents (public/agents/index.html, through the rewrite in next.config.js) and
// /llms.txt. No unit test runs the rewrites or headers, so this checks the built server, as check-os-site.mjs
// does for /os.
const base = new URL(process.argv[2] || 'http://127.0.0.1:3000');
const requests = { signal: AbortSignal.timeout(20_000) };
const page = await readFile(new URL('../public/agents/index.html', import.meta.url), 'utf8');
const llms = await readFile(new URL('../public/llms.txt', import.meta.url), 'utf8');
const mcpAuth = await readFile(new URL('../public/.well-known/mcp-registry-auth', import.meta.url), 'utf8');

for (const [route, expected, type] of [
  ['/agents', page, /text\/html/],
  ['/agents/', page, /text\/html/],
  ['/agents/index.html', page, /text\/html/],
  ['/llms.txt', llms, /text\/plain/],
  // Next serves the dotfile as octet-stream, not text/plain; the MCP registry reads its body, so
  // only require the route to serve the bytes unchanged and keep the no-cache/nosniff headers.
  ['/.well-known/mcp-registry-auth', mcpAuth, null],
]) {
  const response = await fetch(new URL(route, base), requests);
  assert.equal(response.status, 200, route);
  if (type) assert.match(response.headers.get('content-type'), type, route);
  assert.match(response.headers.get('cache-control'), /no-transform/, route);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff', route);
  assert.equal(await response.text(), expected, `${route} must serve the file unchanged`);
}
console.log('Harness /agents, /llms.txt and /.well-known/mcp-registry-auth: every entry path serves the static source unchanged.');
