import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, readlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FINDER_FILES, linkModel, remoteModels, sshBase } from '../lib/remoteModels.mjs';

/** A fake `ssh`: records each call and its stdin, and answers the run with `reply(remoteCommand)`. */
function fakeSsh(reply) {
  const calls = [];
  const spawnImpl = (file, args) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    child.kill = () => {};
    const call = { file, args, input: '' };
    calls.push(call);
    child.stdin.on('data', chunk => { call.input += chunk; });
    child.stdin.on('finish', () => {
      const out = reply(args.at(-1));
      child.stdout.end(out.stdout ?? ''); child.stderr.end(out.stderr ?? '');
      setImmediate(() => child.emit('close', out.code ?? 0));
    });
    return child;
  };
  return { calls, spawnImpl };
}

const machine = { id: 'box', name: 'box', transport: 'ssh', host: 'me@box', port: 2222 };

test('the finder is copied to the machine and run by its own Node', async () => {
  const ssh = fakeSsh(remote => (remote.startsWith('if ') ? { stdout: 'machine   Intel Xeon · linux/x64\n' } : {}));
  const result = await remoteModels(machine, { spawnImpl: ssh.spawnImpl });
  assert.equal(result.full, true);
  assert.match(result.text, /^machine\s+Intel Xeon/);
  assert.deepEqual(ssh.calls.slice(0, 3).map(c => c.args.at(-1).split('/').pop()), FINDER_FILES);
  assert.match(ssh.calls[0].input, /export async function inventory/, 'the real finder source is sent');
  assert.match(ssh.calls.at(-1).args.at(-1), /exec node \.cache\/grid-harness\/finder\/finderMain\.mjs --summary/);
  assert.deepEqual(ssh.calls[0].args.slice(0, 9), sshBase(machine).slice(0, 9));
  assert.ok(ssh.calls.every(c => c.file === 'ssh' && c.args.includes('BatchMode=yes') && c.args.includes('StrictHostKeyChecking=yes')));
});

test('without Node there it still lists the model files, and says what is missing', async () => {
  const ssh = fakeSsh(remote => (remote.startsWith('if ')
    ? { stdout: '__GRID_FINDER_NO_NODE__\nLinux x86_64\n/root/.ollama/models/manifests/registry.ollama.ai/library/qwen/0.5b\n' } : {}));
  const result = await remoteModels(machine, { spawnImpl: ssh.spawnImpl });
  assert.equal(result.full, false);
  assert.match(result.text, /Linux x86_64 \(me@box\) — Node 18\+ is not installed there/);
  assert.match(result.text, /manifests\/registry\.ollama\.ai\/library\/qwen\/0\.5b/);
});

test('a machine that cannot be reached, or is linked through Harness, fails with the reason', async () => {
  const down = fakeSsh(() => ({ code: 255, stderr: 'ssh: connect to host box port 2222: Connection refused\n' }));
  await assert.rejects(remoteModels(machine, { spawnImpl: down.spawnImpl }), /Could not copy the finder to me@box: .*Connection refused/);
  await assert.rejects(remoteModels({ id: 'air', name: 'MacBook-Air', transport: 'harness', machineId: 'x' }),
    /Harness, which runs Grid commands only.*device-info/);
});

test('a model on this machine is linked into Grid\'s folder once, and a taken name is never replaced', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'link-'));
  const model = join(dir, 'lfm.gguf'), mmproj = join(dir, 'mmproj-lfm.gguf'), other = join(dir, 'other.gguf');
  for (const file of [model, mmproj, other]) await writeFile(file, 'GGUF');
  const env = { GRID_HOME: join(dir, 'grid') }, local = { id: 'local', transport: 'local' };

  const first = await linkModel(local, model, 'LFM.gguf', { projector: mmproj, env });
  assert.match(first.text, /linked .*LFM\.gguf -> .*lfm\.gguf/);
  assert.equal(await readlink(join(dir, 'grid', 'models', 'LFM.gguf')), model);
  assert.equal(await readlink(join(dir, 'grid', 'models', 'LFM.mmproj.gguf')), mmproj, 'the projector name --serve looks for');
  assert.match(first.text, /NOT READY: Grid's engine \(llama\.cpp\) is not installed.*run -- engine install llama\.cpp/,
    'a join would die at start without the engine, so the link says so');
  assert.match((await linkModel(local, model, 'LFM.gguf', { env })).text, /already linked/);
  await assert.rejects(linkModel(local, other, 'LFM.gguf', { env }), /already exists and is not a link/);
  await assert.rejects(linkModel(local, join(dir, 'missing.gguf'), 'M.gguf', { env }), /No file at/);
  await assert.rejects(linkModel(local, 'relative.gguf', 'M.gguf', { env }), /full paths/);
  await assert.rejects(linkModel(local, model, 'bad name.gguf', { env }), /plain file name/);
});

test('on an SSH machine the link is made there, with every path quoted', async () => {
  const ssh = fakeSsh(() => ({ stdout: 'linked /root/.grid/models/LFM.gguf -> /root/my models/lfm.gguf\n' }));
  const result = await linkModel(machine, "/root/my models/lfm.gguf", 'LFM.gguf', { spawnImpl: ssh.spawnImpl });
  assert.match(result.text, /^linked /);
  const script = ssh.calls[0].args.at(-1);
  assert.match(script, /link '\/root\/my models\/lfm\.gguf' 'LFM\.gguf'/);
  assert.match(script, /ln -s "\$1" "\$d\/\$2"/);
  assert.match(script, /bin\/llama-server".*command -v llama-server.*NOT READY.*--machine box -- engine install llama\.cpp/);
  assert.match(script, /err="\$\("\$e" --version 2>&1\)".*does not start/, 'installed is not enough: it has to run');
  await assert.rejects(linkModel({ id: 'air', transport: 'harness', machineId: 'x' }, '/m.gguf', 'M.gguf'), /catalog/);
});
