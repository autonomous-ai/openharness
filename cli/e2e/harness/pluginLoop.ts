/**
 * Orca's Harness Device plugin's own loop (plugins/harness-device-orca/src/dial.ts, with Node's inputs), run as Orca
 * would run it for someone whose launcher is `~/.local/bin/harness` (harness/pluginDial.ts). Its whole environment is the
 * throwaway home and a bare PATH: it finds the daemon under test through a launcher shim in that home, and nothing on
 * this machine's PATH.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import { expect } from 'vitest'
import { CLI_ROOT, type IsolatedDaemon, until } from './daemon.js'
import type { DialState } from '../../../plugins/harness-device-orca/src/protocol.ts'

// How the CLI is started: the run's bundle when there is one (E2E_BUNDLE), as the daemon runs.
const CLI_ENTRY = process.env.E2E_BUNDLE_PATH ? [process.env.E2E_BUNDLE_PATH] : ['--import', 'tsx', 'src/cli.ts']

/** The plugin's loop, running. */
export interface PluginLoop {
  /** Each state it told, in order. */
  states: DialState[]
  /** Its log lines. */
  logs: string[]
  /** Hands it the terminals of the worktree on Orca's screen, as Orca does, or null for none; with [workspace], Orca's id
   *  of that worktree beside them, as the worker hands both. With none, the line is the ids alone, as before, which the
   *  loop takes as Orca naming no workspace. */
  front(terminals: string[] | null, workspace?: string | null): void
  /** Ends its stdin, which stops it; its exit code, once it exits within 10 s. */
  stop(): Promise<number | null>
}

/** A word the shell takes as it is. */
const quoted = (word: string): string => `'${word.replaceAll("'", `'\\''`)}'`

/**
 * The loop's whole environment: the throwaway home, and `/usr/bin:/bin`, which holds no `harness`: with no shim the loop
 * would say `noHarness`, never find this machine's launcher. [env] is the test's own besides (the dial eval's network
 * guard).
 */
export function pluginLoopEnv(d: Pick<IsolatedDaemon, 'env'>, env: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
  return { ...env, HOME: d.env.HOME, PATH: '/usr/bin:/bin' }
}

/**
 * The plugin's loop on [d], killed with [children]: the launcher in [d]'s home starts this checkout's CLI under the
 * daemon's environment and nothing else. [env] is the loop's own besides (pluginLoopEnv).
 */
export function startPluginLoop(d: IsolatedDaemon, children: ChildProcess[], env: Readonly<Record<string, string>> = {}): PluginLoop {
  const bin = join(d.env.HOME!, '.local', 'bin')
  const shim = join(bin, 'harness')
  expect(shim.startsWith(d.root + sep)).toBe(true)
  const daemonEnv = Object.entries(d.env).flatMap(([name, value]) => (value === undefined ? [] : [quoted(`${name}=${value}`)]))
  mkdirSync(bin, { recursive: true })
  writeFileSync(shim, `#!/bin/sh\ncd ${quoted(CLI_ROOT)} && exec /usr/bin/env -i ${daemonEnv.join(' ')} ${[process.execPath, ...CLI_ENTRY].map(quoted).join(' ')} "$@"\n`, { mode: 0o700 })
  const child = spawn(process.execPath, ['--import', 'tsx', 'e2e/harness/pluginDial.ts'], {
    cwd: CLI_ROOT, env: pluginLoopEnv(d, env), stdio: ['pipe', 'pipe', 'pipe'],
  })
  children.push(child)
  const states: DialState[] = []
  const logs: string[] = []
  const lines = (from: NodeJS.ReadableStream, take: (line: string) => void): void => {
    let rest = ''
    from.setEncoding('utf8')
    from.on('data', (chunk: string) => {
      const parts = (rest + chunk).split('\n')
      rest = parts.pop()!
      for (const part of parts) take(part)
    })
  }
  lines(child.stdout, (line) => states.push(JSON.parse(line) as DialState))
  lines(child.stderr, (line) => logs.push(line))
  let exited: { code: number | null } | undefined
  child.once('close', (code) => { exited = { code } })
  return {
    states, logs,
    front: (terminals, workspace) => {
      child.stdin.write(`${JSON.stringify(workspace === undefined ? terminals : { terminals, workspace })}\n`)
    },
    stop: async () => {
      child.stdin.end()
      return (await until('the loop to exit', () => exited, 10_000, 50)).code
    },
  }
}
