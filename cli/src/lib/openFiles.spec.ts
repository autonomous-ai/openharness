import { describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { MIN_OPEN_FILES, RAISE_OPEN_FILES_SH } from './openFiles.js'

const LOW_LIMIT = 256 // what launchd hands every process on macOS

/** Run `command args` under /bin/sh with the soft open-files limit first forced to `soft`. */
function runUnderSoftLimit(soft: number, command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      '/bin/sh',
      ['-c', `ulimit -S -n ${soft} || exit 99; exec "$@"`, 'limit-wrapper', command, ...args],
      { timeout: 10_000 },
      (error, stdout, stderr) => (error ? reject(new Error(`${error.message}\n${stderr}`)) : resolve(stdout.trim())),
    )
  })
}

/** The hard limit of this test process's shell, or Infinity for `unlimited`. */
async function hardLimit(): Promise<number> {
  const raw = await runUnderSoftLimit(LOW_LIMIT, '/bin/sh', ['-c', 'ulimit -H -n'])
  return raw === 'unlimited' ? Infinity : Number(raw)
}

describe('RAISE_OPEN_FILES_SH', () => {
  it('raises a low soft limit to MIN_OPEN_FILES, or to the hard limit when that is lower', async () => {
    const hard = await hardLimit()
    const after = Number(await runUnderSoftLimit(LOW_LIMIT, '/bin/sh', ['-c', `${RAISE_OPEN_FILES_SH}ulimit -S -n`]))
    expect(after).toBe(Math.min(MIN_OPEN_FILES, hard))
  })

  it('never lowers a soft limit that is already higher', async () => {
    const hard = await hardLimit()
    const generous = Math.min(MIN_OPEN_FILES * 2, hard)
    if (generous <= MIN_OPEN_FILES) return // hard limit too low on this box to exercise the branch
    const after = Number(await runUnderSoftLimit(generous, '/bin/sh', ['-c', `${RAISE_OPEN_FILES_SH}ulimit -S -n`]))
    expect(after).toBe(generous)
  })

  it('leaves the hard limit alone', async () => {
    const before = await runUnderSoftLimit(LOW_LIMIT, '/bin/sh', ['-c', 'ulimit -H -n'])
    const after = await runUnderSoftLimit(LOW_LIMIT, '/bin/sh', ['-c', `${RAISE_OPEN_FILES_SH}ulimit -H -n`])
    expect(after).toBe(before)
  })

  // The pane script runs under the user's own shell, so the prelude is exercised under the two it
  // meets in practice as well as /bin/sh. A box without one of them skips rather than fails.
  for (const shell of ['/bin/zsh', '/bin/bash']) {
    it.skipIf(!existsSync(shell))(`runs under ${shell}`, async () => {
      const hard = await hardLimit()
      const after = Number(await runUnderSoftLimit(LOW_LIMIT, shell, ['-c', `${RAISE_OPEN_FILES_SH}ulimit -S -n`]))
      expect(after).toBe(Math.min(MIN_OPEN_FILES, hard))
    })
  }

  it('does not end a script running under set -e, even when the raise itself fails', async () => {
    // ulimit shadowed to always fail; the engine (`echo`) must still run.
    const out = await runUnderSoftLimit(LOW_LIMIT, '/bin/bash', ['-c', `set -e; ulimit() { return 1; }; ${RAISE_OPEN_FILES_SH}echo ENGINE_RAN`])
    expect(out).toBe('ENGINE_RAN')
  })
})
