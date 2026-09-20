import { spawn } from 'node:child_process';
import { access, mkdir, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

// Private, request-correlated JSON-lines transport. It never invokes a shell.
export class JsonWorker {
  constructor({ python, script, directory, env = {}, name }) {
    Object.assign(this, { python, script, directory, env, name });
    this.child = null; this.ready = false; this.pending = new Map(); this.state = {}; this.closed = false;
  }
  async start() {
    if (this.closed) throw new Error(`${this.name} is closing.`);
    if (this.stopping) await this.stopping;
    if (this.child && this.ready) return;
    if (this.starting) return this.starting;
    this.starting = this.launch().finally(() => { this.starting = null; });
    return this.starting;
  }
  async launch() {
    await access(this.python, constants.X_OK).catch(() => { throw new Error(`${this.name} needs setup. Run this harness's setup command.`); });
    await mkdir(this.directory, { recursive: true });
    const log = await open(join(this.directory, 'model-cache.log'), 'a', 0o600);
    const child = spawn(this.python, ['-u', this.script], { stdio: ['pipe', 'pipe', log.fd], env: { ...process.env, ...this.env } });
    await log.close(); this.child = child; this.ready = false;
    child.stdin.on('error', () => {});
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.stop(child); reject(new Error(`${this.name} startup timed out.`)); }, 45000);
      const fail = error => { clearTimeout(timer); reject(error); };
      child.once('error', error => { if (this.child === child) this.child = null; fail(error); });
      const lines = createInterface({ input: child.stdout });
      lines.on('line', line => {
        if (this.child !== child) return;
        try {
          if (line.length > 8 * 1024 * 1024) throw new Error('Oversized worker event.');
          const event = JSON.parse(line);
          if (event.event === 'ready') { clearTimeout(timer); this.ready = true; this.state = event; resolve(); return; }
          if (event.state) this.state = { ...this.state, ...event.state };
          const pending = this.pending.get(event.id); if (!pending) return;
          if (event.event === 'done') pending.resolve(event.result);
          else if (event.event === 'error') pending.reject(new Error(event.message));
          else pending.onEvent(event);
        } catch (error) { this.stop(child); fail(error); }
      });
      child.once('close', (code, signal) => {
        clearTimeout(timer); lines.close();
        if (this.child === child) { this.child = null; this.ready = false; }
        const error = new Error(`${this.name} stopped (${signal || code}).`);
        for (const pending of this.pending.values()) if (pending.child === child) pending.reject(error);
        fail(error);
      });
    });
  }
  stop(child = this.child) {
    if (!child || this.stopping) return this.stopping;
    this.ready = false;
    this.stopping = new Promise(resolve => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 1500);
      child.once('close', () => { clearTimeout(timer); resolve(); });
      child.kill('SIGTERM');
    }).finally(() => { this.stopping = null; });
    return this.stopping;
  }
  async request(action, body = {}, { signal, onEvent = () => {}, timeout = 180000 } = {}) {
    signal?.throwIfAborted(); await this.start(); signal?.throwIfAborted();
    const child = this.child; const id = randomUUID();
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); this.pending.delete(id); fn(value); };
      const abort = () => { this.stop(child); finish(reject, signal.reason || new Error('Cancelled.')); };
      const timer = setTimeout(() => { this.stop(child); finish(reject, new Error(`${this.name} ${action} timed out.`)); }, timeout);
      this.pending.set(id, { child, resolve: value => finish(resolve, value), reject: error => finish(reject, error), onEvent });
      signal?.addEventListener('abort', abort, { once: true });
      child.stdin.write(JSON.stringify({ id, action, ...body }) + '\n', error => { if (error) finish(reject, error); });
    });
  }
  async close() { this.closed = true; await this.starting?.catch(() => {}); await this.stop(); }
}
