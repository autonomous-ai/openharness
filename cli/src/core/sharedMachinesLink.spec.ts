import { describe, expect, it, vi } from 'vitest'
import { GUEST_LAUNCH_UNAVAILABLE } from './api.js'
import { createSharedMachinesLink } from './sharedMachinesLink.js'

describe('a guest\'s launch, asked of shared machines\' process', () => {
  const input = { email: 'kim@acme.io', engine: 'claude', bypassPermission: true }

  it('asks under the port\'s member name, and takes a launch as it came', async () => {
    const call = vi.fn(async () => ({ ok: true, workspace: '/g/work', argv: ['/bin/sh', '-c', 'x'], env: { TERM: 'xterm' } }))
    const link = createSharedMachinesLink(call)
    expect(await link.guestLaunch(input)).toEqual({ ok: true, workspace: '/g/work', argv: ['/bin/sh', '-c', 'x'], env: { TERM: 'xterm' } })
    expect(call).toHaveBeenCalledWith('guestLaunch', input)
    link.stop()
  })

  it('passes on a refusal, with its words when it has them', async () => {
    expect(await createSharedMachinesLink(async () => ({ ok: false, error: 'GUEST_HELPER_REQUIRED', detail: 'Turn it on.' })).guestLaunch(input))
      .toEqual({ ok: false, error: 'GUEST_HELPER_REQUIRED', detail: 'Turn it on.' })
    expect(await createSharedMachinesLink(async () => ({ ok: false, error: 'GUEST_INVALID' })).guestLaunch(input)).toEqual({ ok: false, error: 'GUEST_INVALID' })
  })

  it('passes on the guest\'s own host when the launch names one, and nothing else', async () => {
    const answer = { ok: true, workspace: 'C:\\Users\\hg_0123456789ab\\work', argv: ['claude'], env: {},
      guestHostUser: 'hg_0123456789ab' }
    expect(await createSharedMachinesLink(async () => answer).guestLaunch(input))
      .toEqual({ ok: true, workspace: answer.workspace, argv: ['claude'], env: {}, guestHostUser: 'hg_0123456789ab' })
    // A name that is not a guest's is not a host this core may start a pane on.
    for (const guestHostUser of ['DELL', 'hg_x', '', 7, null]) {
      expect(await createSharedMachinesLink(async () => ({ ...answer, guestHostUser })).guestLaunch(input), String(guestHostUser))
        .toEqual(GUEST_LAUNCH_UNAVAILABLE)
    }
  })

  it('runs nothing it cannot trust the shape of: a process down, failing, or answering oddly', async () => {
    for (const answer of [
      { error: 'SERVICE_UNAVAILABLE' },
      { ok: true, workspace: '/g/work', argv: [], env: {} },
      { ok: true, workspace: '/g/work', argv: ['sh', 1], env: {} },
      { ok: true, workspace: '/g/work', argv: ['sh'], env: { TERM: 1 } },
      { ok: true, workspace: '/g/work', argv: ['sh'], env: ['x'] },
      { ok: true, workspace: '/g/work', argv: ['sh'], env: null },
      { ok: true, argv: ['sh'], env: {} },
      { ok: false },
    ]) {
      expect(await createSharedMachinesLink(async () => answer as Record<string, unknown>).guestLaunch(input), JSON.stringify(answer)).toEqual(GUEST_LAUNCH_UNAVAILABLE)
    }
  })
})
