import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, openSync, closeSync, writeSync, symlinkSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { constants } from 'node:buffer';

// Usage: node cli/scripts/benchmark-session-metadata.mjs BASE_COMMIT /absolute/new/output-directory
// Real disposable files; no live engine, daemon, session or account is used.
const repo = fileURLToPath(new URL('../..', import.meta.url));
const require = createRequire(join(repo, 'cli/package.json'));
const digest = text => createHash('sha256').update(text).digest('hex');
const args = process.argv.slice(2), cwd = '/fixture/metadata';
const header = JSON.stringify({ type: 'session', cwd }) + '\n';
if (args[0] === '--worker') {
  const [_, out, mode, file, expectMissing] = args;
  const fixture = mkdtempSync(join(out, 'worker-'));
  const projects = join(fixture, 'projects');
  mkdirSync(projects);
  Object.assign(process.env, { CLAUDE_PROJECTS_DIR: projects,
    ADAPTER_DATA_DIR: join(fixture, 'data'), ADAPTER_RUNTIME_DIR: join(fixture, 'runtime'),
    ADAPTER_COMPUTER_ID_FILE: join(fixture, 'computer-id'), ADAPTER_COMPUTER_ID: 'metadata-benchmark', HARNESS_AUTH_DIR: join(fixture, 'auth'),
    DSH_DIR: join(fixture, 'dsh'), ZDOTDIR: fixture, HARNESS_LESSONS_DIR: join(fixture, 'lessons'), HARNESS_STORE_CATALOG_URL: 'http://127.0.0.1:9/catalog.json' });
  try {
    const module = await import(pathToFileURL(join(out, `${mode}.mjs`)));
    const path = join(projects, 'session-id.jsonl');
    writeFileSync(path, header);
    for (let i = 0; i < 40; i++) assert.equal((await module.findLiveSession('claude', cwd, 0))?.sessionId, 'session-id');
    rmSync(path);
    symlinkSync(file, path);
    global.gc();
    const before = process.memoryUsage(), cpu = process.cpuUsage(), start = performance.now();
    const result = await module.findLiveSession('claude', cwd, 0);
    const durationMs = performance.now() - start, cpuDelta = process.cpuUsage(cpu), after = process.memoryUsage(), usage = process.resourceUsage();
    const identity = result ? { sessionId: result.sessionId, transcript: basename(result.transcriptPath) } : null;
    assert.deepEqual(identity, expectMissing === 'true' ? null : { sessionId: 'session-id', transcript: 'session-id.jsonl' });
    process.stdout.write(JSON.stringify({ mode, durationMs, cpuUs: cpuDelta.user + cpuDelta.system, before, after, maxRssKiB: usage.maxRSS, identity }) + '\n');
  } finally { rmSync(fixture, { recursive: true, force: true }); }
} else {
  assert.equal(args.length, 2, 'Expected baseline commit and new absolute output directory');
  const [base, out] = args;
  assert(/^[a-f0-9]{7,40}$/.test(base));
  assert(out.startsWith('/'));
  mkdirSync(out);
  symlinkSync(join(repo, 'cli/node_modules'), join(out, 'node_modules'), 'dir');
  const oldSource = execFileSync('git', ['show', `${base}:cli/src/lib/sessionRepair.ts`], { cwd: repo, encoding: 'utf8' });
  const { build } = require('esbuild');
  for (const mode of ['baseline', 'candidate']) {
    await build({ entryPoints: [join(repo, 'cli/src/lib/sessionRepair.ts')], outfile: join(out, `${mode}.mjs`), bundle: true,
      packages: 'external', platform: 'node', format: 'esm', target: 'node20', minify: true, logLevel: 'silent',
      plugins: mode === 'candidate' ? [] : [{ name: 'baseline', setup(build) {
        build.onLoad({ filter: /[/\\]sessionRepair\.ts$/ }, () => ({ contents: oldSource, loader: 'ts', resolveDir: join(repo, 'cli/src/lib') }));
      } }],
    });
  }
  const record = Buffer.from((JSON.stringify({ type: 'tool_result', output: 'x'.repeat(65536) }) + '\n').repeat(16));
  const rows = [], sizes = [0, 1, 64, 256, 513];
  for (const sizeMiB of sizes) {
    const file = join(out, `history-${sizeMiB}.jsonl`), fd = openSync(file, 'wx', 0o600);
    try {
      writeSync(fd, header);
      for (let written = 0; written < sizeMiB * 1048576; written += record.length) writeSync(fd, record);
    } finally { closeSync(fd); }
    const fileBytes = statSync(file).size;
    try {
      for (let trial = 0; trial < 3; trial++) for (const mode of trial % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
        // ASCII file > V8's string limit: the old full-file reader catches RangeError and loses the binding.
        const expectMissing = mode === 'baseline' && fileBytes > constants.MAX_STRING_LENGTH;
        const result = spawnSync(process.execPath, ['--expose-gc', fileURLToPath(import.meta.url), '--worker', out, mode, file, String(expectMissing)],
          { cwd: out, encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024 });
        if (result.status !== 0) throw new Error(`${sizeMiB}/${mode}: ${result.stderr}\n${result.stdout}`);
        const row = { sizeMiB, fileBytes, trial, ...JSON.parse(result.stdout.trim()) }; rows.push(row);
        console.log(JSON.stringify({ sizeMiB, trial, mode, ms: row.durationMs, maxRssMiB: row.maxRssKiB / 1024, found: row.identity !== null }));
      }
    } finally { rmSync(file); }
  }
  const median = values => values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const summary = [];
  for (const sizeMiB of sizes) for (const metric of ['durationMs', 'cpuUs', 'maxRssKiB']) {
    const select = mode => median(rows.filter(x => x.sizeMiB === sizeMiB && x.mode === mode).map(x => x[metric]));
    const baseline = select('baseline'), candidate = select('candidate');
    summary.push({ sizeMiB, metric, baseline, candidate, reductionPercent: (1 - candidate / baseline) * 100 });
  }
  const result = { base, baselineSourceSha256: digest(oldSource), candidateSourceSha256: digest(readFileSync(join(repo, 'cli/src/lib/sessionRepair.ts'))),
    dependencySha256: digest(readFileSync(join(repo, 'cli/package-lock.json'))), finishedAt: new Date().toISOString(),
    node: process.version, platform: process.platform, arch: process.arch, maxStringLength: constants.MAX_STRING_LENGTH,
    scope: 'One public findLiveSession directory scan of a synthetic Claude transcript, fresh minified workers. Peak RSS includes startup/warmup; explicit GC is only before timing in disposable children. No whole-app energy claim.', rows, summary };
  writeFileSync(join(out, 'results.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ directory: out, summary }, null, 2));
}
