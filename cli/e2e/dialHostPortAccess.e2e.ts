/**
 * A dial this Linux account may not open (cable/portAccess.ts), on the real daemon: its port belongs to `dialout`,
 * mode 0660, and the account is not in that group. The window's row says how to fix it, and once the account is
 * added the row says only to log out and in, as the daemon's own login still lacks the group. That the log says each
 * once, not at every try, is cableSession.spec's.
 *
 * Needs Linux, passwordless sudo and a `dialout` this account is not in: it changes the account's groups, so it runs
 * only on CI's `e2e (dial hosts)` job (`E2E_DIAL_HOSTS=1`), never on a developer's machine. There a missing one fails
 * the file (harness/dialHosts.ts).
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient } from './harness/client.js'
import { IsolatedDaemon } from './harness/daemon.js'
import { dialHost } from './harness/dialHosts.js'

const GROUP = 'dialout'
const ACCOUNT = userInfo().username
const NO_ACCESS = `No access to the dial. Run: sudo usermod -aG ${GROUP} $USER, then log out and in.`
const NO_ACCESS_YET = 'No access to the dial yet. Log out and in.'

const sudo = (...args: string[]) => execFileSync('sudo', ['-n', ...args], { stdio: 'pipe' })
const ran = (command: string, args: string[]): string | null => {
  try { return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) } catch { return null }
}

/** The group, on a dial-hosts run on Linux where sudo needs no password and neither this login nor the account is in it. */
const group = dialHost('sudo and a group this account is not in', (() => {
  if (process.env.E2E_DIAL_HOSTS !== '1' || process.platform !== 'linux' || ran('sudo', ['-n', 'true']) === null || ran('getent', ['group', GROUP]) === null) return null
  const groups = `${ran('id', ['-nG']) ?? ''} ${ran('id', ['-nG', ACCOUNT]) ?? ''}`.split(/\s+/)
  return groups.includes(GROUP) ? null : GROUP
})())

describe.skipIf(!group)('a dial this account cannot open', () => {
  let daemon: IsolatedDaemon | undefined
  let port: string | undefined
  // The daemon first, so nothing holds the port; then each step alone, so one failing still leaves the account's
  // groups as they were. A close that failed is the test's failure, said once the rest is undone.
  afterEach(async () => {
    let closing: unknown
    try { await daemon?.close() } catch (error) { closing = error }
    try { sudo('gpasswd', '-d', ACCOUNT, GROUP) } catch { /* not added: the test stopped before it */ }
    try { if (port) sudo('rm', '-f', port) } catch { /* sudo refused: the port stays in the run's folder */ }
    daemon = undefined
    port = undefined
    if (closing) throw closing
  })

  it('says how to fix it on its row, then to log out and in', async () => {
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

    const refused = await row(NO_ACCESS)
    expect(refused.payload?.devices).toEqual([{ id: 'E2E-PERM', attached: false, problem: NO_ACCESS }])

    sudo('usermod', '-aG', GROUP, ACCOUNT)
    const yet = await row(NO_ACCESS_YET)
    expect(yet.payload?.devices).toEqual([{ id: 'E2E-PERM', attached: false, problem: NO_ACCESS_YET }])
    // Every try before the account was added refused it the same way: still one line.
    expect(logged(NO_ACCESS)).toBe(1)
    window.close()
  })
})
