import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { once } from 'node:events';
import http from 'node:http';
import { Session } from 'node:inspector';
// Usage: node scripts/benchmark-local-ws.mjs BASELINE_REF /absolute/new/output-directory
// Uses disposable loopback sockets only. No app, daemon, or engine session is started.
const repo = fileURLToPath(new URL('../..', import.meta.url));
const require = createRequire(join(repo, 'cli/package.json'));
const { WebSocket } = require('ws');
const args = process.argv.slice(2);
if (args[0] === '--worker') {
  const [_, bundle, mode, batchArg, countArg] = args;
  const fixture = mkdtempSync(join(dirname(bundle), 'fixture-'));
  Object.assign(process.env, {
    ADAPTER_DATA_DIR: join(fixture, 'data'), ADAPTER_RUNTIME_DIR: join(fixture, 'runtime'),
    ADAPTER_COMPUTER_ID_FILE: join(fixture, 'computer-id'), ADAPTER_COMPUTER_ID: 'benchmark-machine',
    HARNESS_AUTH_DIR: join(fixture, 'auth'), DSH_DIR: join(fixture, 'dsh'), ZDOTDIR: fixture,
    HARNESS_LESSONS_DIR: join(fixture, 'lessons'), HARNESS_STORE_CATALOG_URL: 'http://127.0.0.1:9/catalog.json',
  });
  const { attachLocalWsServer } = await import(pathToFileURL(bundle));
  const batch = Number(batchArg), count = Number(countArg);
  let sink, expected = 0, batchEnd = 0, dispatchError;
  const backend = {
    registerLocalClient(_id, value) { sink = value; return true; },
    async unregisterLocalClient() {},
    async handleLocalBinary() { throw new Error('unexpected binary'); },
    handleLocalFrame(_id, frame) {
      try {
        assert.equal(frame.payload.sequence, expected);
        assert.equal(frame.type, expected % 2 ? 'terminal_alive' : 'terminal_ack');
        expected++;
        if (expected === batchEnd) sink.sendFrame({ type: 'benchmark_batch', payload: { sequence: expected } });
      } catch (error) { dispatchError = error; throw error; }
    },
  };
  const server = http.createServer((_req, res) => { res.statusCode = 404; res.end(); });
  const local = attachLocalWsServer(server, { machineId: 'benchmark-machine', backend });
  let ws, inspector;
  const deadline = setTimeout(() => { console.error('worker timeout'); process.exit(2); }, 30000);
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/api/local-ws`);
    await once(ws, 'open');
    let reply = once(ws, 'message');
    ws.send(JSON.stringify({ type: 'machine_select', payload: { machineId: 'benchmark-machine', localProtocolVersion: 1 } }));
    assert.equal(JSON.parse((await reply)[0].toString()).type, 'connected');
    async function run(frames) {
      const end = expected + frames;
      while (expected < end) {
        const start = expected;
        batchEnd = Math.min(start + batch, end);
        const completed = once(ws, 'message');
        for (let seq = start; seq < batchEnd; seq++) {
          ws.send(JSON.stringify({ type: seq % 2 ? 'terminal_alive' : 'terminal_ack', payload: {
            streamId: '00112233-4455-6677-8899-aabbccddeeff', sequence: seq, seq,
          } }));
        }
        const received = JSON.parse((await completed)[0].toString());
        if (dispatchError) throw dispatchError;
        assert.equal(received.payload.sequence, batchEnd);
      }
    }
    await run(batch === 1 ? 1500 : 5000);
    let post;
    if (mode === 'allocations') {
      inspector = new Session(); inspector.connect();
      post = (method, params = {}) => new Promise((resolve, reject) => inspector.post(method, params, (error, value) => error ? reject(error) : resolve(value)));
      await post('HeapProfiler.startSampling', { samplingInterval: 4096, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
    }
    const beforeMemory = process.memoryUsage(), beforeCpu = process.cpuUsage(), before = performance.now();
    await run(count);
    const durationMs = performance.now() - before, cpu = process.cpuUsage(beforeCpu), afterMemory = process.memoryUsage();
    let allocationBytes = null;
    if (mode === 'allocations') {
      const { profile } = await post('HeapProfiler.stopSampling');
      function sum(node) { return node.selfSize + node.children.reduce((n, child) => n + sum(child), 0); }
      allocationBytes = sum(profile.head);
    }
    process.stdout.write(JSON.stringify({ mode, batch, count, durationMs, cpuUs: cpu.user + cpu.system, allocationBytes, beforeMemory, afterMemory, dispatched: expected }) + '\n');
  } finally {
    inspector?.disconnect();
    if (ws?.readyState === WebSocket.OPEN) { const closed = once(ws, 'close'); ws.close(); await closed; }
    await local.close(); await new Promise(resolve => server.close(resolve));
    clearTimeout(deadline); rmSync(fixture, { recursive: true, force: true });
  }
} else {
  assert.equal(args.length, 2, 'Expected BASELINE_REF and a new output directory');
  const baselineRef = args[0];
  const baselineSha = execFileSync('git', ['rev-parse', '--verify', baselineRef + '^{commit}'], { cwd: repo, encoding: 'utf8' }).trim();
  const { build } = require('esbuild');
  const out = resolve(args[1]);
  mkdirSync(out);
  symlinkSync(join(repo, 'cli/node_modules'), join(out, 'node_modules'), 'dir');
  const inputs = {
    baseline: execFileSync('git', ['show', baselineSha + ':cli/src/localWsServer.ts'], { cwd: repo, encoding: 'utf8' }),
    candidate: readFileSync(join(repo, 'cli/src/localWsServer.ts'), 'utf8'),
  };
  for (const [variant, source] of Object.entries(inputs)) {
    await build({ stdin: { contents: source, resolveDir: join(repo, 'cli/src'), sourcefile: 'localWsServer.ts', loader: 'ts' }, outfile: join(out, variant + '.mjs'), bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node20', minify: true, logLevel: 'silent' });
  }
  const rows = [];
  for (const mode of ['timing', 'allocations']) {
    for (const batch of [1, 100]) {
      for (let trial = 0; trial < (mode === 'timing' ? 6 : 3); trial++) {
        for (const variant of (trial % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate'])) {
          const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--worker', join(out, variant + '.mjs'), mode, String(batch), String(batch === 1 ? 6000 : 60000)], { encoding: 'utf8', timeout: 35000, maxBuffer: 1024 * 1024, cwd: out });
          if (result.status !== 0) throw new Error(`${variant}/${mode}/${batch}: ${result.stderr}\n${result.stdout}`);
          rows.push({ variant, trial, ...JSON.parse(result.stdout.trim()) });
        }
      }
    }
  }
  const median = values => { const s = values.slice().sort((a,b) => a-b); const m = Math.floor(s.length/2); return s.length % 2 ? s[m] : (s[m-1]+s[m])/2; };
  const summary = [];
  for (const batch of [1, 100]) for (const metric of ['durationMs', 'cpuUs', 'allocationBytes']) {
    const mode = metric === 'allocationBytes' ? 'allocations' : 'timing';
    const group = rows.filter(r => r.batch === batch && r.mode === mode);
    const baseline = median(group.filter(r => r.variant === 'baseline').map(r => r[metric]));
    const candidate = median(group.filter(r => r.variant === 'candidate').map(r => r[metric]));
    summary.push({ batch, metric, baseline, candidate, reductionPercent: (1-candidate/baseline)*100 });
  }
  const result = { baselineSha, sourceSha256: Object.fromEntries(Object.entries(inputs).map(([name, source]) => [name, createHash('sha256').update(source).digest('hex')])), finishedAt: new Date().toISOString(), node: process.version, platform: process.platform, arch: process.arch, scope: 'Real loopback WebSocket, synthetic ACK/alive frames, fake backend. CPU includes client and server. Allocation sampling runs separately. No live daemon or app changed.', rows, summary };
  writeFileSync(join(out, 'results.json'), JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify({ directory: out, summary }, null, 2));
}
