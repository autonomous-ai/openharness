/**
 * Orca's account homes on the dial (docs/plans/2026-11-17-new-user-onboarding-design.md, "C. Orca homes"), on the real
 * daemon with a fake dial on the desk (harness/desk.ts) and a fake `orca` (harness/fakeOrca.ts) that lists homes of the
 * test's own:
 * - Claude Code in an Orca account's home, where Harness put no hooks, is found by the open scan and named from that
 *   home's process record;
 * - with a dial attached, an Orca account's Codex home gets the dial skill, with no command run;
 * - with no answer from Orca, the default home's sessions are listed as before.
 * No log line names an account's home or email.
 *
 * The daemon's `lsof` shows only files under the test's root, as in deviceDialSkill.e2e.ts: with a dial attached, the
 * open scan would otherwise see a Codex the developer runs and write into their real home.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { DIAL_SKILL } from '../src/devices/dialSkill.js'
import { SYSTEM_FOLDERS } from '../src/testing/testPath.js'
import { IsolatedDaemon, until } from './harness/daemon.js'
import { Desk } from './harness/desk.js'
import type { DialMessage, FakeDial } from './harness/fakeDial.js'
import { FakeOrca } from './harness/fakeOrca.js'
import { Outside } from './harness/outsideAgent.js'

/** The open scan's report of the one session it found: counts and its time, nothing else. */
const FOUND_ONE = /\[observed\] scan · 1 found · \d+ app known · \d+ named · \d+ ms/

/** An Orca account's Claude Code home, as Orca makes one: its `projects` a link to the default home's. */
function orcaClaudeHome(d: IsolatedDaemon): string {
  const home = join(d.root, 'orca-claude')
  mkdirSync(home, { recursive: true })
  symlinkSync(d.env.CLAUDE_PROJECTS_DIR!, join(home, 'projects'))
  return home
}

/**
 * A turn, so its conversation is on disk: the scan lists only a session with one. No hook of Harness's runs in an Orca
 * home, so the turn's end is read in its transcript, which the link puts in the default home's projects folder.
 */
async function turn(d: IsolatedDaemon, engine: Outside): Promise<void> {
  engine.type('before the dial')
  const projects = d.env.CLAUDE_PROJECTS_DIR!
  await until('its answer in its transcript', () => readdirSync(projects, { recursive: true }).map(String)
    .filter((path) => path.endsWith(`${engine.sessionId}.jsonl`))
    .some((path) => readFileSync(join(projects, path), 'utf8').includes('"type":"assistant"')), 30_000, 100)
}

describe('Orca\'s account homes on the dial', () => {
  let daemon: IsolatedDaemon | undefined
  let desk: Desk | undefined
  const outside: Outside[] = []
  afterEach(async () => {
    for (const engine of outside.splice(0)) await engine.close()
    await desk?.close()
    await daemon?.close()
    daemon = undefined
    desk = undefined
  })

  /** A daemon whose `lsof` shows only the test's own files, checked before anything is turned on. */
  const fresh = async (before: (d: IsolatedDaemon) => void = () => {}): Promise<{ d: IsolatedDaemon; desk: Desk }> => {
    const d = await IsolatedDaemon.create({ env: { CABLE_DISABLE: 'false' } })
    daemon = d
    const system = SYSTEM_FOLDERS.map((folder) => join(folder, 'lsof')).find((file) => existsSync(file))
    if (!system) throw new Error('lsof is required: the daemon\'s open scan reads it')
    // First on the daemon's PATH, and the scan runs `lsof` by name (lib/processTable.ts). Only the field output (-F),
    // which is what the scan reads, is filtered: its `n` lines are the names.
    writeFileSync(join(d.root, 'bin', 'lsof'), `#!/bin/sh
case " $* " in
  *" -F"*) '${system}' "$@" | awk -v root='${d.root}/' 'substr($0, 1, 1) != "n" || index($0, "n" root) == 1' ;;
  *) exec '${system}' "$@" ;;
esac
`, { mode: 0o755 })
    // The daemon finds this one by name, or the filter proves nothing.
    expect(execFileSync('/bin/sh', ['-c', 'command -v lsof'], { env: d.env }).toString().trim()).toBe(join(d.root, 'bin', 'lsof'))
    const file = join(d.root, 'dials.json')
    d.env.HARNESSD_TEST_DIAL_PORT = file
    writeFileSync(file, '[]')
    const theDesk = new Desk(file)
    desk = theDesk
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-200).join('\n')}`) })
    before(d)
    await d.start()
    return { d, desk: theDesk }
  }
  const plugged = async (theDesk: Desk): Promise<FakeDial> => {
    const dial = await theDesk.plug('E2E-A', 'e2:e0:00:00:00:0a')
    await dial.next((m) => m.t === 'agents.end', 45_000, 'the first list')
    return dial
  }
  /** Its row on the dial, once one is sent. */
  const listed = (dial: FakeDial, engine: Outside, what: string, test: (row: DialMessage) => boolean = () => true): Promise<DialMessage> =>
    dial.next((m) => m.t === 'agent' && m.id === engine.id && test(m), 45_000, what)

  it('Claude Code in an Orca account\'s home is found by the scan', async () => {
    let home = ''
    const { d, desk } = await fresh((d) => {
      home = orcaClaudeHome(d)
      FakeOrca.install(d).accounts({ claude: [home] })
    })
    // No dial yet, so no devices process, and no hook of Harness's in that home: only the scan can find it.
    const engine = await Outside.startIn(d, 'in-orca-home', home, {})
    outside.push(engine)
    await turn(d, engine)
    const dial = await plugged(desk)
    expect(await listed(dial, engine, 'the agent in the Orca home listed')).toMatchObject({ name: 'in-orca-home', engine: 'claude' })
    const log = d.log()
    expect(log).toContain('[observed] orca homes · 1 claude · 0 codex')
    expect(log).toMatch(FOUND_ONE)
    expect(log).not.toContain('example.invalid')
    expect(log).not.toContain(home)
  })

  it('the name the person gave it is read from that home\'s record', async () => {
    let home = ''
    const { d, desk } = await fresh((d) => {
      home = orcaClaudeHome(d)
      FakeOrca.install(d).accounts({ claude: [home] })
    })
    const engine = await Outside.startIn(d, 'in-orca-home', home, {})
    outside.push(engine)
    await turn(d, engine)
    engine.named(d, 'Tho 7f3a91c2', 'user')
    const dial = await plugged(desk)
    await listed(dial, engine, 'the agent by the name it was given', (row) => row.name === 'Tho 7f3a91c2')
    expect(d.log()).not.toContain('7f3a91c2')
  })

  it('with a dial attached, an Orca Codex home gets the dial skill', async () => {
    let home = ''
    const { d, desk } = await fresh((d) => {
      home = join(d.root, 'orca-codex')
      mkdirSync(home, { recursive: true })
      FakeOrca.install(d).accounts({ codex: [home] })
    })
    // No command run: the dial's first attach sets Codex up (docs/plans/2026-11-17-dial-agents-always-on-design.md).
    await plugged(desk)
    const skill = join(home, 'skills', 'dial', 'SKILL.md')
    await until('the skill in the Orca Codex home', () => existsSync(skill) && readFileSync(skill, 'utf8') === DIAL_SKILL, 45_000, 100)
    expect(d.log()).toContain('[observed] orca homes · 0 claude · 1 codex')
    expect(d.log()).not.toContain('example.invalid')
    expect(d.log()).not.toContain(home)
  })

  it('with no answer from Orca the default home\'s sessions are listed as before', async () => {
    // The harness's own `orca`, which exits 1 for everything.
    const { d, desk } = await fresh()
    const engine = await Outside.start(d, 'in-default-home', { TERM_PROGRAM: 'ghostty' })
    outside.push(engine)
    await turn(d, engine)
    const dial = await plugged(desk)
    expect(await listed(dial, engine, 'the agent in the default home listed')).toMatchObject({ name: 'in-default-home', engine: 'claude' })
    const log = d.log()
    expect(log).toContain('[observed] orca homes · not read · failed')
    expect(log).toMatch(FOUND_ONE)
  })
})
