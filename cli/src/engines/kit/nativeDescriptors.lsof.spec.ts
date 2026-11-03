// lsof warns on stderr about a file system it cannot stat, while its own listing is complete, and the native probe reads
// any stderr as failure: no Codex session in a Harness Team account whose owner has an OrbStack NFS mount was ever
// confirmed (Mac Auto, 2026-10-29). The descriptor probe asks lsof not to warn.
import { afterEach, expect, it, vi } from 'vitest'

const calls: string[][] = []
vi.mock('node:child_process', async original => ({ ...await original<object>(),
  execFile: (command: string, args: string[], _options: unknown, done: (error: Error | null, out: Buffer, err: Buffer) => void) => {
    calls.push([command, ...args])
    const listing = Buffer.from('p42\0\nf3\0tREG\0D0x1\0i7\0n/rollout.jsonl\0\n')
    // What lsof wrote in the Team account: exit 0, a complete listing, and a warning unless -w.
    const warning = args.includes('-w') ? '' : 'lsof: WARNING: can\'t stat() nfs file system /Users/owner/OrbStack\n      Output information may be incomplete.\n'
    done(null, listing, Buffer.from(warning))
  },
}))

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
afterEach(() => { Object.defineProperty(process, 'platform', platform); calls.length = 0 })

it('reads a process\'s descriptors past lsof\'s warnings about file systems it cannot stat', async () => {
  Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' })
  const { readDescriptorEvidence } = await import('./nativeDescriptors.js')
  const { NativeEvidenceBudget } = await import('./nativeEvidence.js')
  const evidence = await readDescriptorEvidence(42, new NativeEvidenceBudget())
  expect(evidence.descriptors).toEqual([expect.objectContaining({ fd: '3', path: '/rollout.jsonl' })])
  await evidence.verify()
  expect(calls[0]).toEqual(['lsof', '-n', '-P', '-w', '-p', '42', '-F0pftDin'])
})
