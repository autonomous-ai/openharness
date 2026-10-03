// Engines other than Grid's own, started so they outlive the command that started them. An agent's
// shell tears down what it spawned when the command returns — a `nohup … &` mlx-lm died that way with an
// empty log — so the engine runs as the leader of its own session, logging to run/NAME.log, with its PID
// in run/NAME.pid. Stop kills only a PID this file recorded.
import { spawn } from 'node:child_process';
import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const NAME = /^[a-z0-9][a-z0-9._-]{0,62}$/;

export function runFiles(workspace, name) {
  if (!NAME.test(name || '')) throw new Error('The engine name is lowercase letters, digits, dot, dash or underscore.');
  const dir = join(workspace, 'run');
  return { dir, log: join(dir, `${name}.log`), pid: join(dir, `${name}.pid`) };
}

const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };

export async function recordedPid(workspace, name) {
  const pid = Number((await readFile(runFiles(workspace, name).pid, 'utf8').catch(() => '')).trim());
  return Number.isInteger(pid) && pid > 1 ? pid : null;
}

/** Start `argv` detached: own session and process group, stdio to the log, PID recorded. */
export async function serve(workspace, name, argv, { env = {}, spawnImpl = spawn } = {}) {
  if (!Array.isArray(argv) || !argv.length) throw new Error('Give the engine command after --.');
  const files = runFiles(workspace, name);
  const running = await recordedPid(workspace, name);
  if (running && alive(running)) throw new Error(`${name} is already running as PID ${running}; stop it first.`);
  await mkdir(files.dir, { recursive: true });
  const log = await open(files.log, 'a');
  try {
    await log.write(`\n=== ${new Date().toISOString()} ${argv.join(' ')}\n`);
    const child = spawnImpl(argv[0], argv.slice(1), {
      cwd: workspace, detached: true, stdio: ['ignore', log.fd, log.fd], env: { ...process.env, ...env },
    });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
    await writeFile(files.pid, `${child.pid}\n`);
    return { name, pid: child.pid, log: files.log };
  } finally { await log.close(); }
}

/** Stop the PID recorded for NAME: TERM, then KILL after `graceMs`; never any other process. */
export async function stop(workspace, name, { graceMs = 10_000 } = {}) {
  const files = runFiles(workspace, name);
  const pid = await recordedPid(workspace, name);
  if (!pid) return { name, stopped: false, note: `no PID recorded for ${name}` };
  if (!alive(pid)) { await rm(files.pid, { force: true }); return { name, pid, stopped: true, note: 'already gone' }; }
  process.kill(-pid, 'SIGTERM');
  const deadline = Date.now() + graceMs;
  while (alive(pid) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 250));
  if (alive(pid)) process.kill(-pid, 'SIGKILL');
  await rm(files.pid, { force: true });
  return { name, pid, stopped: true };
}
