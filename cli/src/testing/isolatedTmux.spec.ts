import { execFile, execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveBinaryOnPath } from '../lib/binaryOnPath.js'
import { isolatedTmux } from './isolatedTmux.js'

const exec = promisify(execFile)
const hasTmux = (() => { try { execFileSync('tmux', ['-V']); return true } catch { return false } })()

describe.skipIf(!hasTmux)('real tmux test isolation', () => {
  // The first tmux client to reach a socket starts its server, and the server's environment is that client's. A test
  // that opened the first session gave every pane on the server, a daemon's own included, the developer's variables
  // (audit of 2026-11-15, docs/plans/2026-11-15-e2e-isolation-2-design.md). Every value here is made up.
  describe('a server the test starts', () => {
    let theirs = ''
    let tmux: Awaited<ReturnType<typeof isolatedTmux>> | undefined
    afterEach(async () => {
      vi.unstubAllEnvs()
      await tmux?.close()
      tmux = undefined
      rmSync(theirs, { recursive: true, force: true })
    })
    /** A developer's shell: a secret, an ssh agent, a folder of their own on PATH, and a home whose .zshrc says it ran. */
    const developer = () => {
      theirs = mkdtempSync(join(tmpdir(), 'isolated-tmux-theirs-'))
      writeFileSync(join(theirs, '.zshrc'), 'echo developer-zshrc-ran\n')
      vi.stubEnv('FAKE_DEV_SECRET', 'not-a-secret')
      vi.stubEnv('SSH_AUTH_SOCK', join(theirs, 'agent.sock'))
      vi.stubEnv('HOME', theirs)
      // As most developers: no ZDOTDIR, so zsh reads the home's (vitest.setup.ts gives the worker one of its own).
      vi.stubEnv('ZDOTDIR', undefined)
      // Their folder, then where tmux is (isolatedTmux finds it there) and the system's: a failure prints no other folder
      // of the real PATH.
      vi.stubEnv('PATH', [theirs, dirname(resolveBinaryOnPath('tmux')!), '/usr/bin', '/bin'].join(':'))
    }
    /** What a pane of [made] has under each name, `unset` where it has none. Named one by one: never the pane's whole
     *  environment, which at the base is the developer's. */
    const inPane = async (made: Awaited<ReturnType<typeof isolatedTmux>>, names: string[]): Promise<string[]> => {
      const out = join(made.root, 'pane')
      await made.run('new-session', '-d', '-s', 'pane', '/bin/sh', '-c',
        `printf '%s\\n' ${names.map((name) => `"\${${name}-unset}"`).join(' ')} > '${out}.tmp' && mv '${out}.tmp' '${out}'; exec sleep 600`)
      await vi.waitFor(() => expect(existsSync(out)).toBe(true), { timeout: 10_000 })
      return readFileSync(out, 'utf8').split('\n').slice(0, -1)
    }

    it('gives a pane none of the developer\'s variables, and a home, a temporary folder and a PATH of its own', async () => {
      developer()
      const made = tmux = await isolatedTmux()
      const home = join(made.root, 'home')
      expect(await inPane(made, ['FAKE_DEV_SECRET', 'SSH_AUTH_SOCK', 'HOME', 'ZDOTDIR', 'TMPDIR', 'TMUX_TMPDIR', 'PATH']))
        .toEqual(['unset', 'unset', home, home, join(made.root, 't'), made.root, `${join(made.root, 'tools')}:/usr/bin:/bin:/usr/sbin:/sbin`])
      // The empty .zshrc keeps the new-user menu of Debian's, Ubuntu's and Fedora's zsh out of every pane.
      expect(readFileSync(join(home, '.zshrc'), 'utf8')).toBe('')
    })

    it('adds what the caller sets, which wins over its own home but never over its tmux folder', async () => {
      developer()
      const made = tmux = await isolatedTmux({ OWN_VALUE: 'set by the caller', HOME: join(theirs, 'own'), TMUX_TMPDIR: join(theirs, 'tmux') })
      expect(await inPane(made, ['OWN_VALUE', 'HOME', 'TMPDIR', 'TMUX_TMPDIR', 'FAKE_DEV_SECRET']))
        .toEqual(['set by the caller', join(theirs, 'own'), join(made.root, 't'), made.root, 'unset'])
    })

    // The source check below reads only the text of the argument: a PATH built in a variable or a helper passes it,
    // and every engine in the worker's folders is on the panes' again (review of 2026-11-16).
    it('refuses a PATH holding a folder of the worker\'s, however the caller built it', async () => {
      developer()
      const path = [join(theirs, 'bin'), process.env.PATH].join(':')
      await expect(isolatedTmux({ PATH: path }).then((made) => { tmux = made })).rejects.toThrow(/folders? of the worker's PATH/)
    })

    it.skipIf(!existsSync('/bin/zsh'))('runs none of the developer\'s zsh startup files in a login shell', async () => {
      developer()
      const made = tmux = await isolatedTmux()
      const ready = join(made.root, 'ready')
      // zsh by name: the shell the allowlist lets through is the developer's own.
      const pane = await made.run('new-session', '-d', '-P', '-F', '#{pane_id}', '-s', 'zsh', '-x', '120', '-y', '40', '/bin/zsh', '-l', '-i')
      await made.run('send-keys', '-t', pane, '-l', `: > '${ready}'`)
      await made.run('send-keys', '-t', pane, 'Enter')
      await vi.waitFor(() => expect(existsSync(ready)).toBe(true), { timeout: 10_000 })
      expect(await made.run('capture-pane', '-p', '-S', '-200', '-t', pane)).not.toContain('developer-zshrc-ran')
    })
  })

  it('isolates backend calls and cleanup from an inherited parent server', async () => {
    const parent = await isolatedTmux()
    let child: Awaited<ReturnType<typeof isolatedTmux>> | undefined
    try {
      const pane = await parent.run('new-session', '-d', '-P', '-F', '#{pane_id}', '-s', 'sentinel', 'sleep 600')
      const pid = await parent.run('display-message', '-p', '-t', pane, '#{pid}')
      const inherited = { ...process.env, TMUX: `${parent.socket},${pid},0`, TMUX_PANE: pane }
      child = await isolatedTmux({ TMUX: inherited.TMUX, TMUX_PANE: pane })
      // Reproduce the incident safely: TMPDIR alone still selects this disposable parent.
      const wrong = await exec('tmux', ['display-message', '-p', '-t', pane, '#{socket_path}'], {
        env: { ...inherited, TMUX_TMPDIR: child.root }, timeout: 5_000,
      })
      expect(wrong.stdout.trim()).toBe(parent.socket)

      await child.run('new-session', '-d', '-s', 'fixture', 'sleep 600')
      // TmuxBackend uses bare commands; prove its environment selects the child.
      const actual = await exec('tmux', ['display-message', '-p', '-t', 'fixture', '#{socket_path}'], {
        env: child.env, timeout: 5_000,
      })
      expect(actual.stdout.trim()).toBe(child.socket)
      expect(await parent.run('list-sessions', '-F', '#{session_name}')).toBe('sentinel')

      await child.close()
      child = undefined
      expect(await parent.run('display-message', '-p', '-t', pane, '#{pid}')).toBe(pid)
      expect(await parent.run('list-sessions', '-F', '#{session_name}')).toBe('sentinel')
    } finally {
      await child?.close()
      await parent.close()
    }
  }, 15_000)

  // The managed grid's install makes its bin/ read-only (lib/runtimeInstall.ts `readOnly`), and a recursive removal cannot
  // unlink in it: ten roots on one Mac kept their runtime/grid-*/bin after their close (2026-11-14).
  it('removes a folder made read-only in the root, and changes nothing a link in it leads to', async () => {
    const tmux = await isolatedTmux()
    const bin = join(tmux.root, 'runtime', 'grid-0.3.63-darwin-arm64', 'bin')
    const outside = mkdtempSync(join(tmpdir(), 'isolated-tmux-outside-'))
    try {
      mkdirSync(bin, { recursive: true })
      writeFileSync(join(bin, 'grid'), '')
      chmodSync(bin, 0o555)
      writeFileSync(join(outside, 'kept'), '')
      chmodSync(outside, 0o555)
      symlinkSync(outside, join(tmux.root, 'link'))
      await tmux.close()
      expect(existsSync(tmux.root)).toBe(false)
      expect([statSync(outside).mode & 0o777, readdirSync(outside)]).toEqual([0o555, ['kept']])
    } finally {
      for (const folder of [bin, outside]) { try { chmodSync(folder, 0o755) } catch { /* gone */ } }
      rmSync(tmux.root, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })
})

// The parameter was the whole environment to inherit, and four callers spread the worker's into it: a server they
// started had the developer's variables again (audit of 2026-11-15). It is now what the caller sets on top. And three
// named the worker's PATH, over the one it pins: every folder of the developer's PATH, and every engine in them, was on
// their panes' again (review of 2026-11-16). What a caller needs of the worker's goes on the allowlist, with its reason.
it('no caller hands it a copy of another environment, or anything of the worker\'s', () => {
  const cli = join(import.meta.dirname, '..', '..')
  const spreads = (folder: string) => readdirSync(join(cli, folder), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((file) => /isolatedTmux\(\s*(?:\{[^}]*(?:\.\.\.|process\.env)|process\.env)/.test(readFileSync(file, 'utf8')))
    .map((file) => relative(cli, file))
  expect([...spreads('src'), ...spreads('e2e')]).toEqual([])
})
