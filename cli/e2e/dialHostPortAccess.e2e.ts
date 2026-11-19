/**
 * A dial this Linux account may not open (cable/portAccess.ts), on the real daemon: its port belongs to `dialout`,
 * mode 0660, and the account is not in that group. The window's row says how to fix it, and once the account is
 * added the row says only to log out and in, as the daemon's own login still lacks the group. The daemon's log says
 * each once, not at every try.
 *
 * Needs Linux, passwordless sudo and a `dialout` this account is not in: it changes the account's groups. Skipped
 * elsewhere; CI's `e2e (dial hosts)` job has them, and there a missing one fails the file (harness/dialHosts.ts).
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'
import { dialHost } from './harness/dialHosts.js'

const GROUP = 'dialout'
const ACCOUNT = userInfo().username
const NO_ACCESS = `No access to the dial. Run: sudo usermod -aG ${GROUP} $USER, then log out and in.`
const NO_ACCESS_YET = 'No access to the dial yet. Log out and in.'
/** How often the dial's session tries its port again (cable/cableSession.ts REOPEN_EVERY_MS). */
const TRY_EVERY_MS = 2_000

const sudo = (...args: string[]) => execFileSync('sudo', ['-n', ...args], { stdio: 'pipe' })
const ran = (command: string, args: string[]): string | null => {
  try { return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) } catch { return null }
}

/** The group, when this is Linux, sudo needs no password, and neither this login nor the account is in the group. */
const group = dialHost('sudo and a group this account is not in', (() => {
  if (process.platform !== 'linux' || ran('sudo', ['-n', 'true']) === null || ran('getent', ['group', GROUP]) === null) return null
  const groups = `${ran('id', ['-nG']) ?? ''} ${ran('id', ['-nG', ACCOUNT]) ?? ''}`.split(/\s+/)
  return groups.includes(GROUP) ? null : GROUP
})())

describe.skipIf(!group)('a dial this account cannot open', () => {
  let daemon: IsolatedDaemon | undefined
  let port: string | undefined
  afterEach(async () => {
    try { sudo('gpasswd', '-d', ACCOUNT, GROUP) } catch { /* not added: the test stopped before it */ }
    if (port) sudo('rm', '-f', port)
    await daemon?.close()
    daemon = undefined
    port = undefined
  })

  it('says how to fix it on its row, then to log out and in, each once in the log', async () => {
    const d = await IsolatedDaemon.create({ env: { CABLE_DISABLE: 'false' } })
    daemon = d
    port = join(d.root, 'ttyACM0')
    writeFileSync(port, '')
    sudo('chown', `root:${GROUP}`, port)
    sudo('chmod', '0660', port)
    const dials = join(d.root, 'dials.json')
    writeFileSync(dials, JSON.stringify([{ serial: 'E2E-PERM', path: port }]))
    d.env.HARNESSD_TEST_DIAL_PORT = dials
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`) })
    await d.start()
    const window = await LocalClient.connect(d)
    const row = (problem: string) => window.waitFor((frame) => frame.type === 'dial_status'
      && (frame.payload?.devices as Array<Record<string, unknown>> | undefined)?.some((device) => device.problem === problem) === true,
    60_000, `the row saying "${problem}"`)
    const logged = (problem: string) => d.log().split('\n').filter((line) => line.includes(`cable: cannot open the dial: ${problem}`)).length
    // A repeat would come at the next try: the session goes on trying, and a few tries pass with none.
    const afterTries = async () => {
      const at = Date.now() + 3 * TRY_EVERY_MS
      await until('three more tries', () => Date.now() >= at, 4 * TRY_EVERY_MS, 100)
    }

    const refused = await row(NO_ACCESS)
    expect(refused.payload?.devices).toEqual([{ id: 'E2E-PERM', attached: false, problem: NO_ACCESS }])
    await afterTries()
    expect(logged(NO_ACCESS)).toBe(1)

    sudo('usermod', '-aG', GROUP, ACCOUNT)
    const yet = await row(NO_ACCESS_YET)
    expect(yet.payload?.devices).toEqual([{ id: 'E2E-PERM', attached: false, problem: NO_ACCESS_YET }])
    await afterTries()
    expect(logged(NO_ACCESS)).toBe(1)
    expect(logged(NO_ACCESS_YET)).toBe(1)
    window.close()
  })
})
