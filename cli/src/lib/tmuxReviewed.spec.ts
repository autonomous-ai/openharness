import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { sendReviewedToTmux } from './tmux.js'

const directories: string[] = []
afterEach(async () => { vi.unstubAllEnvs(); for (const root of directories.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture(failure: 'load' | 'paste' | 'Enter' | 'hang' | 'none') {
  const root = await mkdtemp(join(tmpdir(), 'reviewed-tmux-boundary-')); directories.push(root)
  const calls = join(root, 'calls')
  await writeFile(join(root, 'tmux'), `#!/bin/sh
printf '%s\\n' "$1" >> "$REVIEWED_CALLS"
case "$1" in
  load-buffer) ${failure === 'hang' ? 'exec sleep 30' : 'cat > /dev/null'}; ${failure === 'load' ? 'exit 1' : 'exit 0'} ;;
  paste-buffer) ${failure === 'paste' ? 'exit 1' : 'exit 0'} ;;
  send-keys) ${failure === 'Enter' ? 'exit 1' : 'exit 0'} ;;
esac
`, { mode: 0o700 })
  vi.stubEnv('PATH', `${root}${delimiter}${process.env.PATH ?? ''}`); vi.stubEnv('REVIEWED_CALLS', calls)
  return async () => (await readFile(calls, 'utf8')).trim().split('\n')
}
describe('reviewed terminal failure receipts', () => {
  it.each(['load', 'paste', 'Enter'] as const)('does not retry a failed %s operation', async failure => {
    const calls = await fixture(failure)
    expect(await sendReviewedToTmux('%1', '/goal Once.', async () => true))
      .toMatchObject({ dispatch: failure === 'load' ? 'not_started' : 'possibly_executed' })
    expect(await calls()).toEqual(failure === 'load' ? ['load-buffer', 'delete-buffer']
      : failure === 'paste' ? ['load-buffer', 'paste-buffer', 'delete-buffer']
      : ['load-buffer', 'paste-buffer', 'send-keys', 'delete-buffer'])
  })
  it('bounds a stuck buffer load before holding any terminal input', async () => {
    const calls = await fixture('hang'), started = Date.now()
    expect(await sendReviewedToTmux('%1', '/goal Once.', async () => true)).toMatchObject({ dispatch: 'not_started' })
    expect(Date.now() - started).toBeLessThan(4500)
    expect(await calls()).toEqual(['load-buffer', 'delete-buffer'])
  }, 6000)
  it('reports a failed post-Enter guard as uncertain despite a successful write receipt', async () => {
    const calls = await fixture('none'); let checks = 0
    expect(await sendReviewedToTmux('%1', '/goal Once.', async () => ++checks < 4))
      .toMatchObject({ dispatch: 'possibly_executed' })
    expect((await calls()).filter(call => call === 'send-keys')).toHaveLength(1)
  })
})
