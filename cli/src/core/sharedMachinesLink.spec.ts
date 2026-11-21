import { describe, expect, it, vi } from 'vitest'
import { guestPaneCommand } from '../lib/guestPaneCommand.js'
import { guestUserFor, guestWorkspaceFor } from '../lib/guestUser.js'
import { createSharedMachinesLink, guestLaunchIn } from './sharedMachinesLink.js'

describe('a guest\'s launch, asked of shared machines\' process', () => {
  const input = { email: 'kim@acme.io', engine: 'claude', bypassPermission: true }

  const reply = (platform: NodeJS.Platform = process.platform) => {
    const user = guestUserFor(input.email), workspace = guestWorkspaceFor(input.email, platform)
    return { ok: true as const, workspace, ...guestPaneCommand({ ...input, engine: 'claude', platform, account: { user, workspace, home: workspace } }),
      ...(platform === 'win32' ? { guestHostUser: user } : {}) }
  }

  it('asks under the port\'s member name, and takes a launch as it came', async () => {
    const answer = reply()
    const call = vi.fn(async () => answer)
    const link = createSharedMachinesLink(call)
    expect(await link.guestLaunch(input)).toEqual(answer)
    expect(call).toHaveBeenCalledWith('guestLaunch', input)
    link.stop()
  })

  it('passes on a refusal, with its words when it has them', async () => {
    expect(await createSharedMachinesLink(async () => ({ ok: false, error: 'GUEST_HELPER_REQUIRED', detail: 'Turn it on.' })).guestLaunch(input))
      .toEqual({ ok: false, error: 'GUEST_HELPER_REQUIRED', detail: 'Turn it on.' })
    expect(await createSharedMachinesLink(async () => ({ ok: false, error: 'GUEST_INVALID' })).guestLaunch(input)).toEqual({ ok: false, error: 'GUEST_INVALID' })
  })

  it('the launch guard admits only the guest\'s own host', () => {
    const answer = reply('win32')
    expect(guestLaunchIn(answer, input)).toEqual(answer)
    // A name that is not a guest's is not a host this core may start a pane on.
    for (const guestHostUser of ['DELL', 'hg_x', '', 7, null]) {
      expect(guestLaunchIn({ ...answer, guestHostUser }, input), String(guestHostUser)).toBeNull()
    }
  })

  it('the launch guard refuses a process down, failing, or answering oddly', () => {
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
      expect(guestLaunchIn(answer, input), JSON.stringify(answer)).toBeNull()
    }
  })
})
