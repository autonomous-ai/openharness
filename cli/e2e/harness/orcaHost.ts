/**
 * A stand-in for Orca's terminal host (testing/recordedOrca.ts): the devices take an Orca pane as the agent's own only on
 * a pty Orca's host made, which they tell by the name of the process that made it. So a hook the test runs as Orca's
 * agent must run on such a pty, under a parent with that name, never from the test's own process.
 *
 * The host is a C program built with cc under the recorded name, which forkpty's one long-lived runner (the test's Node)
 * on its pty. The runner starts each command the test sends it with pipes, as Claude Code starts its hooks, so it is the
 * caller of every hook run through it. Its channel to the test is Node's IPC on fd 3, which the host passes through
 * untouched: nothing but the runner's own terminal is on the pty.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import { resolveBinaryOnPath } from '../../src/lib/binaryOnPath.js'
import { RECORDED_ORCA } from '../../src/testing/recordedOrca.js'
import type { IsolatedDaemon } from './daemon.js'
import { dialHost } from './dialHosts.js'

const execFileAsync = promisify(execFile)

/** The cc that builds the host, or null to skip the files that need it; on a dial-hosts run a null throws (dialHosts.ts). */
export const orcaHostCc: string | null = process.platform === 'win32' ? null : dialHost('cc', resolveBinaryOnPath('cc'))

/** The terminal host's name on this OS: macOS's helper bundle executable; on Linux the name the daemon gives itself,
 *  the same from the .deb and the AppImage. */
const HOST_NAME = process.platform === 'darwin'
  ? basename(RECORDED_ORCA.macos.chain[RECORDED_ORCA.macos.chain.length - 1].comm)
  : RECORDED_ORCA.linux.deb.makerComm

const HOST = `#include <errno.h>
#include <stdio.h>
#include <sys/wait.h>
#include <unistd.h>
#ifdef __APPLE__
#include <util.h>
#else
#include <pty.h>
#endif
int main(int argc, char **argv) {
  int master;
  pid_t child;
  if (argc < 2) return 2;
  child = forkpty(&master, NULL, NULL, NULL);
  if (child < 0) { perror("forkpty"); return 1; }
  if (child == 0) { execvp(argv[1], argv + 1); perror("execvp"); _exit(127); }
  /* Drained, so the runner never blocks on its terminal; the read ends once the runner's side is closed. */
  char buffer[4096];
  for (;;) {
    ssize_t n = read(master, buffer, sizeof buffer);
    if (n > 0 || (n < 0 && errno == EINTR)) continue;
    break;
  }
  int status;
  while (waitpid(child, &status, 0) < 0 && errno == EINTR) {}
  return WIFEXITED(status) ? WEXITSTATUS(status) : 1;
}
`

const RUNNER = `import { spawn } from 'node:child_process'
// The test gone, its channel closes: the runner ends, and the host with it.
process.on('disconnect', () => process.exit(0))
process.on('message', ({ id, file, args, env, stdin, cwd }) => {
  const started = Date.now()
  let stdout = '', stderr = '', done = false
  const reply = (code, error) => {
    if (done) return
    done = true
    process.send({ id, stdout, stderr: error ? stderr + String(error) : stderr, code, ms: Date.now() - started })
  }
  const child = spawn(file, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
  child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8') })
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8') })
  // A command that exits before reading its input must not end the runner with an EPIPE.
  child.stdin.on('error', () => {})
  child.once('error', (error) => reply(null, error))
  child.once('close', (code) => reply(code))
  child.stdin.end(stdin)
})
process.send({ ready: process.pid })
`

export interface Ran { stdout: string; stderr: string; code: number | null; ms: number }

/** A stand-in for Orca's terminal host: a forkpty helper built with cc under the name Orca's host has on this OS
 *  (RECORDED_ORCA: `Orca Agents` on macOS, the recorded comm on Linux), whose child, on that pty, is one long-lived
 *  runner that starts each command it is sent with pipes. The runner is the caller of every hook run through it. */
export interface OrcaTerminal {
  /** The runner's process. */
  readonly pid: number
  run(file: string, args: string[], env: NodeJS.ProcessEnv, stdin: string, cwd: string): Promise<Ran>
  close(): Promise<void>
}

/** Built once a daemon root, however many terminals start at once. */
const built = new Map<string, Promise<string>>()

function build(d: IsolatedDaemon): Promise<string> {
  let host = built.get(d.root)
  if (!host) {
    host = (async () => {
      if (!orcaHostCc) throw new Error("cc, which builds Orca's terminal host stand-in, is not installed")
      const folder = join(d.root, 'orca-host')
      const binary = join(folder, HOST_NAME)
      await mkdir(folder, { recursive: true })
      await writeFile(join(folder, 'host.c'), HOST)
      await writeFile(join(folder, 'runner.mjs'), RUNNER)
      // glibc before 2.34 keeps forkpty in libutil; later ones still ship it, empty.
      await execFileAsync(orcaHostCc, ['-o', binary, join(folder, 'host.c'), ...(process.platform === 'linux' ? ['-lutil'] : [])])
      return binary
    })()
    built.set(d.root, host)
  }
  return host
}

async function ps(fields: string[], pid: number): Promise<string> {
  const { stdout } = await execFileAsync('/bin/ps', [...fields.flatMap((field) => ['-o', `${field}=`]), '-p', String(pid)], { encoding: 'utf8' })
  return stdout.trim()
}

/** Orca's terminal host stand-in, its runner on the pty and ready; its host process goes in [children], which the test
 *  ends. */
export async function orcaTerminal(d: IsolatedDaemon, children: ChildProcess[]): Promise<OrcaTerminal> {
  const binary = await build(d)
  const host = spawn(binary, [process.execPath, join(d.root, 'orca-host', 'runner.mjs')], {
    cwd: d.env.HOME, env: d.env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  })
  children.push(host)
  let stderr = ''
  host.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
  const pending = new Map<number, { resolve: (ran: Ran) => void; reject: (error: Error) => void }>()
  let gone: Error | undefined
  const runner = new Promise<number>((resolve, reject) => {
    host.on('message', (raw) => {
      const message = raw as { ready?: number; id?: number } & Ran
      if (message.ready !== undefined) resolve(message.ready)
      else if (message.id !== undefined) {
        pending.get(message.id)?.resolve({ stdout: message.stdout, stderr: message.stderr, code: message.code, ms: message.ms })
        pending.delete(message.id)
      }
    })
    // A host that cannot start (its binary gone) emits no exit.
    host.once('error', reject)
    host.once('exit', (code, signal) => {
      gone = new Error(`Orca's terminal host stand-in exited (${code ?? signal}): ${stderr.trim()}`)
      reject(gone)
      for (const waiting of pending.values()) waiting.reject(gone)
      pending.clear()
    })
  })
  const pid = await runner
  // A host under another name, or a runner on no pty, would leave every Orca pane held: the test would pass for nothing.
  const [ppid, tty] = (await ps(['ppid', 'tty'], pid)).split(/\s+/)
  const name = basename(await ps(['comm'], Number(ppid)))
  if (name !== HOST_NAME || tty === undefined || tty === '?') {
    host.kill('SIGKILL')
    throw new Error(`Orca's terminal host stand-in runs its runner under "${name}" on tty "${tty}", not under "${HOST_NAME}" on a pty`)
  }
  let next = 0
  return {
    pid,
    run(file, args, env, stdin, cwd) {
      if (gone) return Promise.reject(gone)
      const id = next++
      return new Promise<Ran>((resolve, reject) => {
        pending.set(id, { resolve, reject })
        host.send({ id, file, args, env, stdin, cwd }, (error) => {
          if (!error) return
          pending.delete(id)
          reject(error)
        })
      })
    },
    async close() {
      if (host.exitCode !== null || host.signalCode !== null) return
      const exited = new Promise<void>((done) => host.once('exit', () => done()))
      host.disconnect()
      const timer = setTimeout(() => host.kill('SIGKILL'), 10_000)
      await exited
      clearTimeout(timer)
    },
  }
}
