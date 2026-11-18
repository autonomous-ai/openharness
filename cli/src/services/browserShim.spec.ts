import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { browserShimScript, writeBrowserShim } from './browserShim.js'
import { browserPrelude, browserShimPath } from '../lib/browserPrelude.js'

/** A pane's `BROWSER`: the daemon first, then the person's own browser, then the system's. Run for real in /bin/sh
 *  with stand-ins for the daemon's command and the browsers, each recording what it was given. */
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'browser-shim-'))
  dirs.push(dir)
  const tool = (name: string, exit: number) => {
    const path = join(dir, name)
    writeFileSync(path, `#!/bin/sh\necho "${name} $*" >> '${dir}/log'\nexit ${exit}\n`)
    chmodSync(path, 0o755)
    return path
  }
  const run = (daemonExit: number, extra: Record<string, string> = {}) => {
    const shim = join(dir, 'bin', 'harness-browser')
    writeBrowserShim(`'${tool('daemon', daemonExit)}'`, shim)
    try {
      execFileSync(shim, ['https://x.test/a?b=c'], { env: { PATH: `${dir}:/usr/bin:/bin`, ...extra }, stdio: 'ignore' })
    } catch { /* the stand-in system browser may be missing on this host */ }
    try { return readFileSync(join(dir, 'log'), 'utf8').trim().split('\n') } catch { return [] }
  }
  return { dir, tool, run }
}

describe('the pane browser script', () => {
  it('stops at the daemon when a phone took the page', () => {
    const { run } = sandbox()
    expect(run(0)).toEqual(['daemon open-url https://x.test/a?b=c'])
  })

  it('falls back to the browser the person had, arguments and all', () => {
    const { run, tool } = sandbox()
    const mine = tool('mine', 0)
    expect(run(1, { HARNESS_PREVIOUS_BROWSER: `${mine} --new-window` })).toEqual([
      'daemon open-url https://x.test/a?b=c',
      'mine --new-window https://x.test/a?b=c',
    ])
  })

  it('never falls back to itself, and needs an address', () => {
    const { dir, run } = sandbox()
    const lines = run(1, { HARNESS_PREVIOUS_BROWSER: join(dir, 'bin', 'harness-browser') })
    expect(lines[0]).toBe('daemon open-url https://x.test/a?b=c')
    expect(lines.filter((line) => line.startsWith('daemon'))).toHaveLength(1)
    expect(() => execFileSync(join(dir, 'bin', 'harness-browser'), [], { stdio: 'ignore' })).toThrow()
  })

  it('is written private, rewritten only when it changed, and never throws', () => {
    const { dir } = sandbox()
    const path = join(dir, 'bin', 'harness-browser')
    expect(writeBrowserShim("'a'", path)).toBe(true)
    expect(statSync(path).mode & 0o777).toBe(0o700)
    const first = statSync(path).mtimeMs
    expect(writeBrowserShim("'a'", path)).toBe(true)
    expect(statSync(path).mtimeMs).toBe(first)
    expect(readFileSync(path, 'utf8')).toBe(browserShimScript("'a'"))
    writeFileSync(join(dir, 'file'), '')
    expect(writeBrowserShim("'a'", join(dir, 'file', 'nested', 'x'))).toBe(false)
    expect(browserShimPath('/data')).toBe('/data/bin/harness-browser')
  })
})

describe('browserPrelude', () => {
  const env = (prelude: string, start: Record<string, string>) =>
    execFileSync('/bin/sh', ['-c', `${prelude}printf '%s|%s' "\${BROWSER:-}" "\${HARNESS_PREVIOUS_BROWSER:-}"`], { env: start, encoding: 'utf8' })

  it('sets BROWSER to the script and keeps the person\'s, once the script is there', () => {
    const { dir } = sandbox()
    const path = join(dir, 'bin', 'harness-browser')
    expect(env(browserPrelude(path), { BROWSER: 'firefox' })).toBe('firefox|')
    writeBrowserShim("'a'", path)
    expect(env(browserPrelude(path), { BROWSER: 'firefox' })).toBe(`${path}|firefox`)
    // A pane started from a pane: the person's browser is not lost to the script's own name.
    expect(env(browserPrelude(path), { BROWSER: path, HARNESS_PREVIOUS_BROWSER: 'firefox' })).toBe(`${path}|firefox`)
  })
})
