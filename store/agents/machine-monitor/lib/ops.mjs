/**
 * The operations: the small set of things that actually change a machine.
 *
 * Reads go through the daemon's loopback API (lib/daemon.mjs). The three changes that only the
 * `harness` CLI can make — linking to another machine, dropping that link, and this computer's own
 * remote password — are run here as bounded, non-interactive subprocesses.
 *
 * A remote password is a secret the person owns. It is written to the child's stdin and nowhere
 * else: never an argument (which any `ps` can read), never a file, never a log line, never a
 * returned value. Nothing in this module puts one in a snapshot or an operation record.
 */
import { execFile } from 'node:child_process';

const CLI = process.env.HARNESS_CLI || 'harness';

/** Run the Harness CLI without a shell, with a bound on time and output. `input` goes to stdin. */
export function runCli(args, { input, timeoutMs = 60_000, env = process.env } = {}) {
  return new Promise(resolve => {
    const child = execFile(env.HARNESS_CLI || CLI, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => resolve({
        ok: !error,
        code: error?.code ?? 0,
        stdout: stdout ?? '',
        stderr: stderr ?? '',
        error: error ? (error.killed ? 'The Harness CLI did not finish in time.' : null) : null,
      }));
    child.on('error', () => resolve({ ok: false, code: 127, stdout: '', stderr: '', error: `Could not run \`${CLI}\`. Harness's CLI is not on PATH here.` }));
    if (input !== undefined) { child.stdin.end(input.endsWith('\n') ? input : `${input}\n`); }
    else child.stdin.end();
  });
}

/** The CLI's `--json` commands answer in NDJSON; the last object is the result. */
export function lastJson(stdout) {
  let value = null;
  for (const line of String(stdout).split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try { value = JSON.parse(trimmed); } catch { /* a progress line that is not JSON */ }
  }
  return value;
}

const normalize = value => String(value ?? '').trim().toLowerCase();

/**
 * Find the machine a person named, however they named it: its id, the first characters of its id,
 * its name, its hostname, or a nickname given in this workspace.
 *
 * An ambiguous name is never guessed — a wrong guess here renames or deletes the wrong computer.
 */
export function resolveMachine(machines, query) {
  const wanted = normalize(query);
  if (!wanted) return { error: 'Name a machine — its name, its hostname, or the first characters of its id.' };
  const exact = machines.filter(m => normalize(m.id) === wanted);
  if (exact.length === 1) return { machine: exact[0] };
  const named = machines.filter(m => [m.name, m.givenName, m.nickname, m.hostname].some(value => normalize(value) === wanted));
  if (named.length === 1) return { machine: named[0] };
  if (named.length > 1) return { error: `More than one machine is called "${query}".`, candidates: named };
  const partial = machines.filter(m => normalize(m.id).startsWith(wanted)
    || [m.name, m.givenName, m.nickname, m.hostname].some(value => normalize(value).includes(wanted)));
  if (partial.length === 1) return { machine: partial[0] };
  if (partial.length > 1) return { error: `"${query}" matches ${partial.length} machines.`, candidates: partial };
  return { error: `No machine here matches "${query}".`, candidates: machines };
}

/**
 * Link this computer to another of your machines, proving you know that machine's remote password.
 *
 * The password arrives as an argument to this function and leaves on the child's stdin. Callers
 * must not keep it, print it, or record it; the result says only whether the link was made.
 */
export async function linkMachine(machineId, password, { displayName, env = process.env } = {}) {
  if (!/^[0-9a-f]{8,64}$/i.test(String(machineId))) return { ok: false, error: 'That is not a machine id.' };
  if (typeof password !== 'string' || !password.trim()) return { ok: false, error: 'Enter the remote password set on that machine.' };
  const args = ['link', 'connect', machineId, '--stdin', '--json'];
  if (displayName) args.push(`--name=${String(displayName).slice(0, 80)}`);
  const result = await runCli(args, { input: password, timeoutMs: 120_000, env });
  const payload = lastJson(result.stdout);
  if (payload?.ok === true) return { ok: true, machineId: payload.machineId ?? machineId };
  const reason = payload?.error || result.error || result.stderr.trim().split('\n').pop() || 'The link did not complete.';
  // A wrong password is the common answer here, and it is worth saying plainly rather than as a code.
  return { ok: false, error: /PASSWORD|AUTH/i.test(reason) ? 'That password was not accepted by the other machine.' : reason.slice(0, 200) };
}

export async function unlinkMachine(machineId, { env = process.env } = {}) {
  const result = await runCli(['link', 'unlink', machineId], { env, timeoutMs: 20_000 });
  if (result.ok) return { ok: true };
  return { ok: false, error: (result.error || result.stderr.trim().split('\n').filter(Boolean).pop() || 'Could not unlink that machine.').slice(0, 200) };
}

/** The machines THIS computer trusts, with when each link was made. */
export async function listLinks({ env = process.env } = {}) {
  const result = await runCli(['link', 'list'], { env, timeoutMs: 20_000 });
  return { ok: result.ok, text: (result.stdout || result.stderr).trim() };
}

/** Whether this computer can be linked TO — i.e. whether it has a remote password set. */
export async function remotePasswordStatus({ env = process.env } = {}) {
  const result = await runCli(['remote-password', 'status', '--json'], { env, timeoutMs: 20_000 });
  const payload = lastJson(result.stdout);
  return { ok: result.ok, set: payload?.set === true || payload?.hasPassword === true, raw: payload };
}

export async function setRemotePassword(password, { env = process.env } = {}) {
  if (typeof password !== 'string' || password.trim().length < 8) return { ok: false, error: 'Use at least 8 characters.' };
  const result = await runCli(['remote-password', 'set', '--stdin', '--json'], { input: password, env, timeoutMs: 30_000 });
  const payload = lastJson(result.stdout);
  if (result.ok && payload?.ok !== false) return { ok: true };
  return { ok: false, error: (payload?.error || result.error || 'Could not set the remote password.').slice(0, 200) };
}

export async function clearRemotePassword({ env = process.env } = {}) {
  const result = await runCli(['remote-password', 'clear', '--json'], { env, timeoutMs: 20_000 });
  const payload = lastJson(result.stdout);
  if (result.ok && payload?.ok !== false) return { ok: true };
  return { ok: false, error: (payload?.error || result.error || 'Could not clear the remote password.').slice(0, 200) };
}

/**
 * Wait for a machine that is not on the account yet to appear on it.
 *
 * This is the other half of bringing a computer in: the person installs Harness and signs in over
 * there, and this watches the account until the new machine shows up, so nobody has to keep asking
 * "is it there yet".
 */
export async function watchForNewMachine({ seconds = 300, pollMs = 4000, list, env = process.env, signal } = {}) {
  const fetchList = list ?? (await import('./daemon.mjs')).listMachines;
  const first = await fetchList(env);
  if (!first.ok) return { ok: false, error: first.error };
  const known = new Set(first.machines.map(m => m.machineId));
  const deadline = Date.now() + Math.min(3600, Math.max(1, seconds)) * 1000;
  while (Date.now() < deadline) {
    if (signal?.aborted) return { ok: false, error: 'Stopped waiting.' };
    await new Promise(done => setTimeout(done, pollMs));
    const latest = await fetchList(env);
    if (!latest.ok) continue;
    const arrived = latest.machines.filter(m => !known.has(m.machineId));
    if (arrived.length) return { ok: true, machines: arrived };
  }
  return { ok: false, timedOut: true, error: 'No new machine signed in while waiting.' };
}
