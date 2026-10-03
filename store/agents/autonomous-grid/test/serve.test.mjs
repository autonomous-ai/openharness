import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordedPid, runFiles, serve, stop } from '../lib/serve.mjs';

const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('an engine started with serve leads its own process group, logs, records its PID, and stop ends only it', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'serve-'));
  const started = await serve(workspace, 'probe', [process.execPath, '-e', 'console.log(process.env.PROBE); setTimeout(() => {}, 60000)'], { env: { PROBE: 'ready' } });
  try {
    assert.equal(await recordedPid(workspace, 'probe'), started.pid);
    assert.ok(alive(started.pid));
    const group = Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(started.pid)], { encoding: 'utf8' }).trim());
    assert.equal(group, started.pid, 'its own process group, so the starting shell cannot take it down');
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.match(await readFile(runFiles(workspace, 'probe').log, 'utf8'), /ready/);
    await assert.rejects(serve(workspace, 'probe', [process.execPath, '-e', '']), /already running/);
  } finally {
    const stopped = await stop(workspace, 'probe', { graceMs: 2_000 });
    assert.equal(stopped.stopped, true);
  }
  assert.equal(alive(started.pid), false);
  assert.equal(await recordedPid(workspace, 'probe'), null);
  assert.equal((await stop(workspace, 'probe')).stopped, false, 'nothing recorded, nothing killed');
});

test('names cannot reach outside run/', () => {
  assert.throws(() => runFiles('/tmp/x', '../escape'), /engine name/);
  assert.throws(() => runFiles('/tmp/x', ''), /engine name/);
});
