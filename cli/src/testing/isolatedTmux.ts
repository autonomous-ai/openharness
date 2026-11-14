import { execFile } from 'node:child_process'
import { chmod, lstat, mkdir, mkdtemp, readdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { resolveBinaryOnPath } from '../lib/binaryOnPath.js'

const exec = promisify(execFile)

/** Bare tmux calls in the backend under test must use the same private server as the fixture.
 * TMUX outranks TMUX_TMPDIR, so changing only the latter still reaches the developer's server.
 * Cleanup always names the captured socket, even after the caller restores its environment. */
export async function isolatedTmux(inherited: NodeJS.ProcessEnv = process.env) {
  const binary = resolveBinaryOnPath('tmux')
  if (!binary) throw new Error('tmux is required for this test')
  const root = await realpath(await mkdtemp(join(tmpdir(), 'htmux-')))
  const env: NodeJS.ProcessEnv = { ...inherited, TMUX_TMPDIR: root }
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

// kill-server returns before its panes have exited, and a zsh among them writes its history as
// it goes (macOS's /etc/zshrc sets HISTFILE): the folder filled up under the removal, and a
// passing tmuxmoves.e2e.ts test failed in its teardown with ENOTEMPTY. Asked again, it is empty.
const removeTree = (path: string) => rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })

// [root] and everything in it. A recursive removal cannot unlink in a read-only folder, and the managed grid's install
// makes its bin/ one (lib/runtimeInstall.ts `readOnly`): ten roots on one Mac kept their runtime/grid-*/bin after their
// close (2026-11-14). So a removal that fails makes the root's folders writable by their owner and is tried once more;
// what that one cannot remove, its error names.
async function removeRoot(root: string): Promise<void> {
  try {
    await removeTree(root)
  } catch {
    await ownerWritable(root)
    await removeTree(root)
  }
}

/** [folder] and every folder in it made writable by its owner. Read without following a link (lstat, and a link's own
 *  entry is never a folder), so nothing a link in the root leads to is changed. What it cannot change, the removal after
 *  it names. */
async function ownerWritable(folder: string): Promise<void> {
  const stats = await lstat(folder).catch(() => null)
  if (!stats?.isDirectory()) return
  await chmod(folder, (stats.mode & 0o7777) | 0o700).catch(() => {})
  for (const entry of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory()) await ownerWritable(join(folder, entry.name))
  }
}

export type IsolatedTmux = Awaited<ReturnType<typeof isolatedTmux>>
