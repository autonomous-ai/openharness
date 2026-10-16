/**
 * Every command that stops Harness before it changes something goes on only when Harness did stop. On Windows a stop
 * can leave Harness running (lib/daemonStop.ts `stopOnWindows`: a process it could not confirm is Harness's, or could
 * not end); a `reset` that went on cleared the pid file under it, after which `harness stop` said "not running" and
 * nothing could stop it. On a Mac or Linux every stop that found a process stopped it, and nothing here changes.
 *
 * The commands live in cli.ts, which runs as a process; a stop that leaves Harness running cannot be produced on a
 * Mac, so the order is asserted on the source and the guard itself (`stopDaemonOrExit`) is tested with an injected
 * result in lib/daemonStop.spec.ts.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SOURCE = readFileSync(join(import.meta.dirname, 'cli.ts'), 'utf-8')
  .replace(/\/\*[\s\S]*?\*\//g, (match) => ' '.repeat(match.length))
  .replace(/(^|[^:])\/\/[^\n]*/gm, (match, lead: string) => lead + ' '.repeat(match.length - lead.length))

/** A top-level function's body, to its closing brace at column 0. */
function body(name: string): string {
  const from = SOURCE.indexOf(`async function ${name}(`)
  expect(from, `cli.ts still defines ${name}`).toBeGreaterThan(-1)
  return SOURCE.slice(from, SOURCE.indexOf('\n}\n', from))
}

/** Where `call` first appears in [text], after [after] when given. */
function at(text: string, call: string, after = 0): number {
  const index = text.indexOf(call, after)
  expect(index, `still calls ${call}`).toBeGreaterThan(-1)
  return index
}

describe('commands that stop Harness first (cli.ts)', () => {
  it.each([
    ['resetCommand', ['clearAdapterState(', 'clearAuthSession(']],
    ['logout', ['passThroughToGridLogout(', 'clearAuthSession(', 'launch(']],
    ['updateCommand', ['downloadCanaryStage(', 'relaunch()']],
  ])('%s goes on only once Harness has stopped', (name, after) => {
    const text = body(name)
    const guard = at(text, 'stopDaemonOrExit(')
    for (const call of after) expect(at(text, call, guard), `${call} after the stop`).toBeGreaterThan(guard)
    expect(text).not.toContain('stopDaemonProcess(')
  })

  it('starting as another account launches only once the old account\'s Harness has stopped', () => {
    const text = body('startCommand')
    const switching = at(text, 'as another account')
    const guard = at(text, 'stopDaemonOrExit(', switching)
    expect(at(text, 'launch(', guard)).toBeGreaterThan(guard)
    expect(text).not.toContain('stopDaemonProcess(')
  })

  it('restarting on a new identity launches only once the old Harness has stopped', () => {
    const text = body('restartDaemonForIdentity')
    const guard = at(text, 'stopDaemonOrExit(')
    expect(at(text, 'launch(', guard)).toBeGreaterThan(guard)
    expect(text).not.toContain('stopDaemonProcess(')
  })

  it('a forced sign-in does not sign in while the old account\'s Harness is still running', () => {
    const text = body('loginCommand')
    const stop = at(text, 'await stopDaemonProcess()')
    const check = at(text, 'leftRunning(', stop)
    const refused = text.slice(check, at(text, 'await signIn()', check))
    expect(refused, 'it says so, the app\'s way too').toContain('didNotStopSentence(')
    expect(refused).toContain("code: 'DAEMON_DID_NOT_STOP'")
    expect(refused).toContain('return { signedIn: false }')
  })

  it('harness stop says it did not stop, through the same guard', () => {
    expect(body('stop')).toContain('stopDaemonOrExit(')
  })

  it('no other command stops Harness without the guard', () => {
    expect(SOURCE.match(/stopDaemonProcess\(/g) ?? []).toHaveLength(1) // loginCommand's, checked above
  })
})
