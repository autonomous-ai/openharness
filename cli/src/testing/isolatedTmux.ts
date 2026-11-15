import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'
import { resolveBinaryOnPath } from '../lib/binaryOnPath.js'
import { daemonEnvironment } from './daemonEnvironment.js'
import { removeRoot } from './removeRoot.js'
import { SYSTEM_FOLDERS, testPath } from './testPath.js'

const exec = promisify(execFile)

/** Bare tmux calls in the backend under test must use the same private server as the fixture.
 * TMUX outranks TMUX_TMPDIR, so changing only the latter still reaches the developer's server.
 * Cleanup always names the captured socket, even after the caller restores its environment.
 *
 * The first client to reach the socket starts the server, and the server's environment is that client's, and so every
 * pane's, a daemon's own included. Built from the worker's whole environment, a server a test started gave its panes
 * the developer's SSH_AUTH_SOCK, API keys, HOME and ZDOTDIR (audit of 2026-11-15,
 * docs/plans/2026-11-15-e2e-isolation-2-design.md). So it takes the daemon's allowlist (daemonEnvironment.ts), and
 * [own] is what the caller sets on top, never an environment to inherit. Its home has an empty .zshrc: with none, the
 * zsh of Debian, Ubuntu and Fedora opens its new-user menu in every pane. <root>/t is the temporary folder of a pane on
 * this server, so what it leaves stays in the root. Its PATH is the fixture's own (testPath.ts), so a pane finds no
 * engine of the developer's. TMUX_TMPDIR comes last: no caller moves the server away from its socket. A PATH of the
 * caller's with a folder of the worker's is refused, however it was built: the source check (isolatedTmux.spec.ts)
 * reads only the text of the argument (review of 2026-11-16). */
export async function isolatedTmux(own: NodeJS.ProcessEnv = {}) {
  const workers = new Set((process.env.PATH ?? '').split(delimiter).filter((folder) => folder && !SYSTEM_FOLDERS.includes(folder)))
  const theirs = (own.PATH ?? '').split(delimiter).filter((folder) => workers.has(folder)).length
  // A count, not the folders: they name the developer's own.
  if (theirs) throw new Error(`isolatedTmux: own.PATH holds folders of the worker's PATH (${theirs}): a pane would find its engines`)
  const binary = resolveBinaryOnPath('tmux')
  if (!binary) throw new Error('tmux is required for this test')
  const root = await realpath(await mkdtemp(join(tmpdir(), 'htmux-')))
  const home = join(root, 'home'), tmp = join(root, 't')
  await mkdir(home)
  await writeFile(join(home, '.zshrc'), '')
  await mkdir(tmp)
  const env = daemonEnvironment(process.env, { HOME: home, ZDOTDIR: home, TMPDIR: tmp, PATH: testPath(root), ...own, TMUX_TMPDIR: root })
  // Not on the allowlist, but a caller forwarding a parent's environment can carry them in [own].
  delete env.TMUX
  delete env.TMUX_PANE
  const socketDirectory = join(root, `tmux-${process.getuid!()}`)
  await mkdir(socketDirectory, { mode: 0o700 })
  const socket = join(socketDirectory, 'default')
  const run = async (...args: string[]) =>
    (await exec(binary, ['-S', socket, '-f', '/dev/null', ...args], { env, timeout: 5_000 })).stdout.trim()
  return {
    root,
    socket,
    env,
    run,
    async close() {
      await run('kill-server').catch(() => { /* this disposable server may already have exited */ })
      await removeRoot(root)
    },
  }
}

export type IsolatedTmux = Awaited<ReturnType<typeof isolatedTmux>>
