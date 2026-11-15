/** A probe's deadline and cleanup survive its setup process being killed or frozen. No public command route. */
import { ChildProcess, spawn, type execFile, type ExecFileException, type ExecFileOptions } from 'node:child_process'
import { managedNodePath } from '../../lib/nodeRuntime.js'
import { ownProcessGroup } from '../../lib/windows/noWindow.js'

const RUNNER = String.raw`
const { execFile, spawn } = require('node:child_process'), path = require('node:path');
let child, answered = false, started = false, cancelling = false, deadline, draining, failure, stdout = '', stderr = '';
let stdoutBytes = 0, stderrBytes = 0;
function finish(error) {
  if (answered) return; answered = true; clearTimeout(deadline); clearTimeout(draining);
  const reply = { stdout, stderr, error: error ? { code: error.code, killed: !!error.killed, signal: error.signal } : null };
  const leave = () => process.exit(0);
  setTimeout(leave, 250);
  if (process.connected) { try { process.send(reply, leave); } catch { leave(); } } else leave();
}
function cancel() {
  if (answered || cancelling) return; cancelling = true;
  const error = failure ||= { code: 'SETUP_PROBE_CANCELLED', killed: true, signal: 'SIGKILL' };
  if (!child?.pid) { finish(error); return; }
  if (process.platform === 'win32') {
    execFile(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
      ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 2000 }, () => finish(error));
    draining = setTimeout(() => finish(error), 2250);
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    draining = setTimeout(() => finish(error), 250);
  }
}
process.on('disconnect', cancel);
process.on('uncaughtException', cancel);
process.on('message', message => {
  if (message.cancel) { cancel(); return; }
  if (started) return; started = true; clearTimeout(deadline);
  const { file, args, options, group } = message;
  try {
    child = spawn(file, args, { env: options.env, cwd: options.cwd, ...group, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const read = (kind, bytes) => {
      if (kind === 'stdout') stdoutBytes += Buffer.byteLength(bytes); else stderrBytes += Buffer.byteLength(bytes);
      if ((kind === 'stdout' ? stdoutBytes : stderrBytes) > options.maxBuffer) {
        failure = { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', killed: true }; cancel(); return;
      }
      if (kind === 'stdout') stdout += bytes.toString(); else stderr += bytes.toString();
    };
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', bytes => read('stdout', bytes)); child.stderr.on('data', bytes => read('stderr', bytes));
    child.once('error', finish);
    child.once('close', (code, signal) => finish(failure || (code === 0 ? null : { code, signal })));
    deadline = setTimeout(cancel, Math.min(5000, options.timeout > 0 ? options.timeout : 5000));
  } catch (error) { finish(error); }
});
deadline = setTimeout(cancel, 5000);
`

export function createSetupProbeExecutor() {
  const children = new Set<ChildProcess>()
  type Callback = (error: ExecFileException | null, stdout: string, stderr: string) => void
  interface Keeper { child: ChildProcess; answered: boolean; callback?: Callback }
  let spare: Keeper | undefined, warmed = false
  const start = (): Keeper => {
    // The documented Windows hidden runner pattern: cleanup must outlive setup to observe IPC disconnect.
    // Only this small runner is detached; it starts real work hidden, under ownProcessGroup's platform rules.
    const child = spawn(managedNodePath(), ['--max-old-space-size=32', '-e', RUNNER], {
      detached: true, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    })
    children.add(child)
    const keeper: Keeper = { child, answered: false }
    const reply = (error: ExecFileException | null, stdout = '', stderr = '') => {
      if (keeper.answered) return
      keeper.answered = true; keeper.callback?.(error, stdout, stderr)
    }
    const unavailable = () => {
      if (!keeper.answered && !keeper.callback) console.warn('[engine-setup] SETUP_PROBE_WARMUP_UNAVAILABLE')
      reply(Object.assign(Error('Setup probe is unavailable'), { code: 'SETUP_PROBE_UNAVAILABLE' }))
    }
    child.once('error', () => { children.delete(child); unavailable() })
    child.once('exit', () => { children.delete(child); unavailable() })
    child.once('message', value => {
      const answer = value as { error: { code?: string | number; killed: boolean; signal?: NodeJS.Signals } | null; stdout: string; stderr: string }
      if (!answer || typeof answer.stdout !== 'string' || typeof answer.stderr !== 'string'
        || answer.stdout.length > 1_048_576 || answer.stderr.length > 1_048_576) { unavailable(); if (child.connected) child.disconnect(); return }
      reply(answer.error ? Object.assign(Error('Setup probe did not complete'), answer.error) as ExecFileException : null, answer.stdout, answer.stderr)
    })
    // A caller's deadline cancels the actual probe through its keeper; killing the keeper would orphan it.
    child.kill = () => {
      if (!child.connected) return false
      try { child.send({ cancel: true }, () => {}); return true } catch { return false }
    }
    return keeper
  }
  const warmOnce = () => {
    if (warmed) return
    warmed = true
    // One speculative keeper after first use, within the same admission; its own timer expires it unused.
    if (children.size < 8) {
      try { spare = start() } catch { console.warn('[engine-setup] SETUP_PROBE_WARMUP_UNAVAILABLE') }
    }
  }
  const execute = (file: string, args: string[], options: ExecFileOptions, callback: Callback): ChildProcess => {
    const ready = spare && !spare.answered && spare.child.connected ? spare : undefined
    spare = undefined
    if (!ready && children.size >= 8) {
      queueMicrotask(() => callback(Object.assign(Error('Setup probes are busy'), { code: 'SETUP_PROBE_BUSY' }), '', ''))
      return new ChildProcess()
    }
    const keeper = ready ?? start(), { child } = keeper
    keeper.callback = callback
    child.send({ file, args, options: { ...options, maxBuffer: Math.min(options.maxBuffer ?? 65_536, 1_048_576) }, group: ownProcessGroup() }, error => {
      if (error) {
        if (!keeper.answered) {
          keeper.answered = true
          callback(Object.assign(Error('Setup probe is unavailable'), { code: 'SETUP_PROBE_UNAVAILABLE' }), '', '')
        }
        if (child.connected) child.disconnect()
      }
    })
    return child
  }
  return { execute: execute as typeof execFile, warmOnce,
    close() { spare = undefined; for (const child of children) child.kill('SIGKILL') } }
}
