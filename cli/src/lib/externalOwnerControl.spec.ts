import { expect, it, vi } from 'vitest'
import { verifiedForegroundJob } from './externalOwnerControl.js'
it('distinguishes verified group leadership from unreadable foreground evidence', async () => {
  for (const [answer, expected] of [[null, 'unknown'], ['', 'unknown'], ['bad', 'unknown'], ['7 0', 'unknown'], ['0 7', 'unknown'],
    ['7 7 extra', 'unknown'], ['7 7', 7], ['8 7', null], ['7 -1', null]] as const) {
    expect(await verifiedForegroundJob(7, async () => answer)).toBe(expected)
  }
})

it('answers unknown on Windows without ps', async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { value: 'win32' })
  // Git's `ps` is on the Windows runners' PATH and answers (run 44758521149).
  const exec = vi.fn(async () => '7 7')
  try {
    expect(await verifiedForegroundJob(7, exec)).toBe('unknown')
    expect(exec).not.toHaveBeenCalled()
  } finally { Object.defineProperty(process, 'platform', platform) }
})
