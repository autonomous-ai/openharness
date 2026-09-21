// viewer.mjs as Harness runs it: `node viewer.mjs` with HARNESS_WORKSPACE and HARNESS_VIEWER_PORT,
// refusing to start without them, and closing cleanly (open streams included) on SIGTERM or SIGINT. And
// the manifest's commands, viewer.sh and doctor.sh, on a PATH of only what they use: they find Node
// through runtimes.sh — this machine's, or Harness's own under HOME (~/.harness/runtime/current-node),
// the Node a fresh Mac with none on PATH gets.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';

const viewer = fileURLToPath(new URL('../viewer.mjs', import.meta.url));
const pkg = dirname(viewer);
// A bash line tracer's hooks (BASH_ENV sourcing a DEBUG trap that appends to SHCOV_OUT), passed through when set.
const TRACER = Object.fromEntries(['BASH_ENV', 'SHCOV_OUT'].filter((k) => process.env[k]).map((k) => [k, process.env[k]]));
let workspace;
before(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'web-viewer-process-'));
  await writeFile(join(workspace, 'index.html'), '<h1>Hello, process</h1>');
});
after(() => rm(workspace, { recursive: true, force: true }));

const freePort = () => new Promise((resolve) => {
  const probe = createServer().listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});

function start(env) {
  const { HARNESS_WORKSPACE, HARNESS_VIEWER_PORT, ...rest } = process.env;
  const child = spawn(process.execPath, [viewer], { env: { ...rest, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = { stdout: '', stderr: '' };
  child.stdout.on('data', (chunk) => { out.stdout += chunk; });
  child.stderr.on('data', (chunk) => { out.stderr += chunk; });
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal, ...out })));
  return { child, out, exited };
}

test('refuses to start without a workspace', async () => {
  const { code, stderr } = await start({ HARNESS_VIEWER_PORT: '4310' }).exited;
  assert.notEqual(code, 0);
  assert.match(stderr, /HARNESS_WORKSPACE is required\./);
});

test('refuses a port that is not a port', async () => {
  for (const port of [undefined, 'abc', '0', '70000', '43.5']) {
    const env = { HARNESS_WORKSPACE: workspace };
    if (port !== undefined) env.HARNESS_VIEWER_PORT = port;
    const { code, stderr } = await start(env).exited;
    assert.notEqual(code, 0, String(port));
    assert.match(stderr, /HARNESS_VIEWER_PORT must be a valid port\./, String(port));
  }
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  test(`serves on the given loopback port and exits cleanly on ${signal}, ending open streams`, async () => {
    const port = await freePort();
    const run = start({ HARNESS_WORKSPACE: workspace, HARNESS_VIEWER_PORT: String(port) });
    const deadline = Date.now() + 10_000;
    while (!run.out.stdout.includes(`[web-viewer] http://127.0.0.1:${port}/`)) {
      assert.ok(Date.now() < deadline, `the viewer did not start: ${run.out.stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const base = `http://127.0.0.1:${port}`;
    assert.match(await (await fetch(base + '/files/index.html')).text(), /Hello, process/);
    const stream = await fetch(base + '/events');
    const reader = stream.body.getReader();
    await reader.read();
    run.child.kill(signal);
    const { code } = await run.exited;
    assert.equal(code, 0, 'a clean exit, not death by signal');
    const rest = await reader.read().catch(() => ({ done: true }));
    assert.equal(rest.done, true, 'the stream was closed');
  });
}

const scratches = [];
after(() => Promise.all(scratches.map((dir) => rm(dir, { recursive: true, force: true }))));
/** A fresh temp directory, removed after the tests. */
async function scratch(name) {
  const dir = await mkdtemp(join(tmpdir(), `web-viewer-${name}-`));
  scratches.push(dir);
  return dir;
}

/** A PATH of bash, dirname and cat, plus `node` when given (a path to link, or a script body). */
async function binWith(node) {
  const bin = await scratch('bin');
  for (const tool of ['bash', 'dirname', 'cat']) await symlink(['/bin', '/usr/bin'].map((d) => join(d, tool)).find((p) => existsSync(p)), join(bin, tool));
  if (node?.startsWith('#!')) { await writeFile(join(bin, 'node'), node); await chmod(join(bin, 'node'), 0o755); }
  else if (node) await symlink(node, join(bin, 'node'));
  return bin;
}

/** A HOME, with Harness's own Node recorded in it when `node` is given (a path). */
async function homeWith(node) {
  const home = await scratch('home');
  if (node) {
    await mkdir(join(home, '.harness', 'runtime'), { recursive: true });
    await writeFile(join(home, '.harness', 'runtime', 'current-node'), node);
  }
  return home;
}

/** A node that is the real one but says it is 18.20.4. */
async function oldNode() {
  const old = await scratch('old-node');
  const fake = 'Object.defineProperty(process, "versions", { value: { ...process.versions, node: "18.20.4" } })'; // no single quote: it goes inside one
  // `node -v` is answered by the binary before any --import, so the stand-in answers it itself.
  await writeFile(join(old, 'node'), `#!/bin/sh\n[ "$1" = -v ] && { echo v18.20.4; exit 0; }\nexec '${process.execPath}' --import 'data:text/javascript,${encodeURIComponent(fake)}' "$@"\n`);
  await chmod(join(old, 'node'), 0o755);
  assert.equal(spawnSync(join(old, 'node'), ['-p', 'process.versions.node'], { encoding: 'utf8' }).stdout.trim(), '18.20.4', 'the stand-in reports an old Node');
  return join(old, 'node');
}

const noHarnessNode = (home) => `miss node >= 20, and Harness's own Node is not in ${home}/.harness/runtime — run \`harness start\` once to lay it down\n`;

test('the manifest runs doctor.sh and viewer.sh, from the package', async () => {
  const { toolchain, viewer: own } = JSON.parse(await readFile(new URL('../harness.json', import.meta.url), 'utf8'));
  assert.deepEqual([toolchain.doctor, own.command], ['./doctor.sh', './viewer.sh']);
});

test('doctor.sh passes on Node 20 or newer — this machine\'s or Harness\'s own — and fails on an older one or none, run as Harness runs it', async () => {
  const { toolchain } = JSON.parse(await readFile(new URL('../harness.json', import.meta.url), 'utf8'));
  const doctor = async (bin, home) => {
    const r = spawnSync('/bin/sh', ['-c', toolchain.doctor], { cwd: pkg, env: { PATH: bin, HOME: home, ...TRACER }, encoding: 'utf8' });
    return [r.status, r.stdout];
  };
  const ok = [0, `ok   node ${process.version}\n`];
  assert.deepEqual(await doctor(await binWith(process.execPath), await homeWith()), ok, `node ${process.version}`);
  assert.deepEqual(await doctor(await binWith(), await homeWith(process.execPath)), ok, 'no node on PATH, Harness\'s own');
  const bare = await homeWith();
  assert.deepEqual(await doctor(await binWith(await oldNode()), bare), [1, noHarnessNode(bare)]);
  assert.deepEqual(await doctor(await binWith(), bare), [1, noHarnessNode(bare)]);
  const old = await oldNode();
  assert.deepEqual(await doctor(await binWith(old), await homeWith(old)), [1, "miss node >= 20 — this machine's newest is v18.20.4, Harness's own; update Harness\n"]);
});

test('viewer.sh serves from a login shell with no node on PATH on Harness\'s own Node, and exits cleanly on SIGTERM; with no Node at all, a miss', async () => {
  const bin = await binWith();
  const port = await freePort();
  const child = spawn('/bin/sh', ['-c', 'exec ./viewer.sh'], { cwd: pkg, env: { PATH: bin, HOME: await homeWith(process.execPath), HARNESS_WORKSPACE: workspace, HARNESS_VIEWER_PORT: String(port), ...TRACER }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  const deadline = Date.now() + 10_000;
  while (!stdout.includes(`[web-viewer] http://127.0.0.1:${port}/`)) {
    assert.ok(Date.now() < deadline, `the viewer did not start: ${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.match(await (await fetch(`http://127.0.0.1:${port}/files/index.html`)).text(), /Hello, process/);
  child.kill('SIGTERM');
  assert.equal(await exited, 0, 'exec: the signal reaches node, which exits cleanly');

  const home = await homeWith();
  const none = spawnSync('/bin/sh', ['-c', './viewer.sh'], { cwd: pkg, env: { PATH: bin, HOME: home, HARNESS_WORKSPACE: workspace, HARNESS_VIEWER_PORT: String(port), ...TRACER }, encoding: 'utf8' });
  assert.deepEqual([none.status, none.stdout], [1, noHarnessNode(home)]);
});

