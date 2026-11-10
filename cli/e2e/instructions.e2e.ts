/**
 * An agent's instructions, as the owner reads them from another computer: the Desktop or the phone on the owner's account,
 * through the relay. A signed-in daemon on the fake backend (harness/fakeBackend.ts) with an agent in a folder, and a computer
 * of the same account paired with it, with an end-to-end encrypted session through the relay (harness/relayPhone.ts, the
 * CLI's own relay client role). What it asks is `agent_instructions_read`, and what it must be told is all that instructs the
 * agent from its folder: its own file, and the project's AGENTS.md and CLAUDE.md (services/projects.ts).
 *
 * - A Product Manager in a repository with no `agents` folder reads as the project's two files, sealed: the relay holds not a
 *   word of them, and saving her own file leaves them as they were.
 * - Files made to break it: a file larger than any instructions, links that lead out of the project, bytes that are not text,
 *   a file that cannot be opened, a named pipe, a folder. What can be shown is shown, what cannot is left out and said to be
 *   (`skipped`, with why), and the read neither fails nor waits.
 * - An error of her own file (a name it cannot have, a file over the limit, not text) leaves the project's files beside it.
 * - An agent in a subfolder of a repository is told of the files above its own, with the engines that load each.
 * - Writers at the same time, whichever way a file is replaced: every answer is whole.
 * - The machine offline: the read is refused at once, and answered with what its disk holds now when it is back.
 *
 * Nothing here reaches beyond this machine: the daemon's every server setting is the fake backend's.
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient } from './harness/client.js'
import { until } from './harness/daemon.js'
import { startPhoneMachine, type PhoneMachine } from './harness/fleet.js'
import { RelayPhone } from './harness/relayPhone.js'

type Shared = Array<{ name: string; path: string; loadedBy: string[]; text: string; truncated: boolean }>
/** The two files of the agent's folder as they are told: where, and which engine loads each (Codex AGENTS.md, Claude Code CLAUDE.md). */
const fine = (name: 'AGENTS.md' | 'CLAUDE.md', text: string, truncated = false) => ({ name, path: name, loadedBy: [name === 'AGENTS.md' ? 'codex' : 'claude'], text, truncated })
const left = (name: 'AGENTS.md' | 'CLAUDE.md', why: string) => ({ name, path: name, loadedBy: [name === 'AGENTS.md' ? 'codex' : 'claude'], why })

const row = async (client: LocalClient, agentId: string) =>
  ((await client.request<{ agents: Array<Record<string, any>> }>('agents_list', { includeStopped: true }, 30_000)).agents)
    .find((agent) => agent.id === agentId)
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')
const euro = String.fromCodePoint(0x20ac)
/** Whatever is at the path made to break a read: a folder, or anything else, a link to nothing and a named pipe included. */
function clear(path: string): void {
  const found = lstatSync(path, { throwIfNoEntry: false })
  if (found?.isDirectory()) rmSync(path, { recursive: true })
  else if (found) unlinkSync(path)
}
// Neither a root user (who opens what it likes) nor Windows (which has no mode that refuses the owner) can be refused a file.
const canBeRefused = process.platform !== 'win32' && process.getuid?.() !== 0

describe('an agent\'s instructions, as the owner reads them from another computer', () => {
  let world: PhoneMachine | undefined
  let phone: RelayPhone | undefined
  let desk: LocalClient | undefined
  afterEach(async () => {
    phone?.close()
    desk?.close()
    await world?.close()
    world = undefined; phone = undefined; desk = undefined
  })

  /** A daemon with Faye, a Product Manager, in a repository folder, and the owner's other computer with a session to it. */
  const fresh = async () => {
    const w = await startPhoneMachine()
    world = w
    const { backend, machine } = w
    onTestFailed(() => {
      console.log(`---- daemon log\n${machine.daemon.log().split('\n').slice(-150).join('\n')}`)
      console.log(`---- fake backend saw\n${backend.seen.slice(-40).join('\n')}`)
    })
    await until('the machine to be connected to the backend', () => backend.nodeUp(machine.machineId) || null, 30_000)
    const local = desk = await LocalClient.connect(machine.daemon, { machineId: machine.machineId })
    const folder = join(machine.daemon.projectsDir, 'lampOS')
    mkdirSync(folder, { recursive: true })
    const created = await local.request('agent_create', { engine: 'claude', cwd: folder, bypassPermission: true }, 60_000)
    expect(created.error, JSON.stringify(created)).toBeUndefined()
    const agentId: string = created.agent.id
    await until('the agent to bind its conversation', async () => (await row(local, agentId))?.sessionId || null, 45_000, 500)
    const owner = phone = new RelayPhone({ backend, machineId: machine.machineId, identity: w.phone.identity, machinePub: machine.identity.pub, token: w.phone.token })
    await owner.open()
    const ask = (type: string, payload: Record<string, unknown> = {}) => owner.request(type, { agentId, name: 'Faye', ...payload }, 30_000)
    return { w, backend, machine, desk: local, phone: owner, agentId, folder, ask }
  }

  it('a Product Manager with no file of her own reads as her repository\'s AGENTS.md and CLAUDE.md, sealed, and saving her own file leaves them alone', async () => {
    const { backend, machine, phone, folder, ask } = await fresh()
    // About 18 KB, as the real one is.
    const agents = `# lampOS\n${'Ship small, test first.\n'.repeat(780)}Never push to main. LAMPOS-MARKER\n`
    writeFileSync(join(folder, 'AGENTS.md'), agents)
    writeFileSync(join(folder, 'CLAUDE.md'), '@AGENTS.md\n')
    expect(existsSync(join(folder, 'agents'))).toBe(false)
    const shared: Shared = [fine('AGENTS.md', agents), fine('CLAUDE.md', '@AGENTS.md\n')]
    const first = await ask('agent_instructions_read')
    expect(first).toMatchObject({ text: null, version: '' })
    expect(first.shared).toEqual(shared)
    const saved = await ask('agent_instructions_write', { text: 'Lead the crew.\n', version: '' })
    expect(saved).not.toHaveProperty('shared')
    const second = await ask('agent_instructions_read')
    expect(second).toMatchObject({ text: 'Lead the crew.\n', version: saved.version })
    expect(second.shared).toEqual(shared)
    expect(readFileSync(join(folder, 'AGENTS.md'), 'utf8')).toBe(agents)
    expect(readFileSync(join(folder, 'CLAUDE.md'), 'utf8')).toBe('@AGENTS.md\n')
    // The relay carried sealed frames only: not a word of any of it, and no line of the daemon's log has one either.
    const relayed = JSON.stringify([...(backend.webSent.get(phone.connId!) ?? []), ...(backend.webReceived.get(phone.connId!) ?? [])])
    expect(relayed).toContain('__e2e')
    for (const secret of ['LAMPOS-MARKER', 'Ship small', 'Lead the crew']) {
      expect(relayed, secret).not.toContain(secret)
      expect(machine.daemon.log(), secret).not.toContain(secret)
    }
  })

  it('files made to break it: what can be shown is shown, what cannot is left out, and the read neither fails nor waits', async () => {
    const { machine, folder, ask } = await fresh()
    const outside = join(machine.daemon.root, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'secret.md'), 'SECRET-OUTSIDE-THE-PROJECT\n')
    const agentsFile = join(folder, 'AGENTS.md'), claudeFile = join(folder, 'CLAUDE.md')
    // What is shown, and what is there and not shown, with why.
    const cases: Array<[string, () => void, Shared | undefined, Array<{ name: string; why: string }> | undefined]> = [
      // 6 MB: the limit falls inside the character after the 21 845th (three bytes each), so the text ends before it.
      ['a file far over the limit, cut at a whole character', () => writeFileSync(agentsFile, euro.repeat(2_000_000)), [fine('AGENTS.md', euro.repeat(21_845), true)], undefined],
      // Codex loads no empty file, so nothing loads this one.
      ['an empty file', () => writeFileSync(agentsFile, ''), [{ ...fine('AGENTS.md', ''), loadedBy: [] }], undefined],
      ['links that lead out of the project, and a link to such a link', () => {
        symlinkSync(join(outside, 'secret.md'), agentsFile)
        symlinkSync('AGENTS.md', claudeFile)
      }, undefined, [left('AGENTS.md', 'link'), left('CLAUDE.md', 'link')]],
      ['a link to nothing', () => symlinkSync(join(outside, 'missing.md'), claudeFile), undefined, [left('CLAUDE.md', 'link')]],
      ['one file that is a link to the other: both, the one text', () => {
        writeFileSync(agentsFile, 'Real.\n')
        symlinkSync('AGENTS.md', claudeFile)
      }, [fine('AGENTS.md', 'Real.\n'), fine('CLAUDE.md', 'Real.\n')], undefined],
      ['a link to a file in a subfolder of the project, and one to a folder', () => {
        mkdirSync(join(folder, 'docs'))
        writeFileSync(join(folder, 'docs', 'rules.md'), 'Rules.\n')
        symlinkSync('docs/rules.md', agentsFile)
        symlinkSync('docs', claudeFile)
      }, [fine('AGENTS.md', 'Rules.\n')], [left('CLAUDE.md', 'not_a_file')]],
      ['links out of the project, through a folder that is a link out and by a way up', () => {
        symlinkSync(outside, join(folder, 'docs'))
        symlinkSync('docs/secret.md', agentsFile)
        symlinkSync('../../outside/secret.md', claudeFile)
      }, undefined, [left('AGENTS.md', 'link'), left('CLAUDE.md', 'link')]],
      ['bytes that are not text beside text', () => {
        writeFileSync(agentsFile, 'Fine.\n')
        writeFileSync(claudeFile, Buffer.from([0x41, 0xe9, 0x42]))
      }, [fine('AGENTS.md', 'Fine.\n')], [left('CLAUDE.md', 'not_text')]],
      ['text with a byte-order mark and two kinds of line ending, as it is', () => writeFileSync(agentsFile, '\u{feff}one\r\ntwo\n'), [fine('AGENTS.md', '\u{feff}one\r\ntwo\n')], undefined],
      ['folders by those names', () => { mkdirSync(agentsFile); mkdirSync(claudeFile) }, undefined, [left('AGENTS.md', 'not_a_file'), left('CLAUDE.md', 'not_a_file')]],
    ]
    if (canBeRefused) cases.push(['a file this user may not open', () => { writeFileSync(claudeFile, 'Private.\n'); chmodSync(claudeFile, 0) }, undefined, [left('CLAUDE.md', 'unreadable')]])
    if (process.platform !== 'win32') {
      cases.push(['a named pipe, which an open would wait on for ever', () => { writeFileSync(agentsFile, 'Before the pipe.\n'); execFileSync('mkfifo', [claudeFile]) }, [fine('AGENTS.md', 'Before the pipe.\n')], [left('CLAUDE.md', 'not_a_file')]])
    }
    for (const [what, set, shown, skipped] of cases) {
      for (const file of [agentsFile, claudeFile, join(folder, 'docs')]) clear(file)
      set()
      const answer = await ask('agent_instructions_read')
      expect(answer, what).not.toHaveProperty('error')
      expect(answer, what).toMatchObject({ text: null, version: '' })
      expect(answer.shared, what).toEqual(shown)
      expect(answer.skipped, what).toEqual(skipped)
      expect(JSON.stringify(answer), what).not.toContain('SECRET-OUTSIDE')
    }
    // What was left out for a reason that is not the person's own doing is said in the log, by name and code and nothing more.
    const told = machine.daemon.log().split('\n').filter((line) => line.includes('left out'))
    expect(told.some((line) => line.includes('left out CLAUDE.md · NOT_UTF8'))).toBe(true)
    if (canBeRefused) expect(told.some((line) => line.includes('left out CLAUDE.md · EACCES'))).toBe(true)
    for (const line of told) expect(line, line).not.toContain(folder)
    // The most a read can carry, all three texts at the limit and each of them control characters, which the reply writes at
    // six bytes the character: over a megabyte, sealed, through the relay.
    for (const file of [agentsFile, claudeFile]) clear(file)
    mkdirSync(join(folder, 'agents'))
    for (const file of [agentsFile, claudeFile, join(folder, 'agents', 'Faye.md')]) writeFileSync(file, '\x01'.repeat(65_536))
    const worst = await ask('agent_instructions_read')
    expect(worst.text).toHaveLength(65_536)
    expect((worst.shared as Shared).map((one) => [one.name, one.text.length, one.truncated])).toEqual([['AGENTS.md', 65_536, false], ['CLAUDE.md', 65_536, false]])
  })

  // The owner reads her instructions to see what the agent is told: a name the agent's own file cannot have, or that file being
  // too large or not text, must not hide what its project tells it.
  it('an error of her own file does not hide the project\'s: a name it cannot have, a file over the limit, a file that is not text', async () => {
    const { phone, folder, ask } = await fresh()
    writeFileSync(join(folder, 'AGENTS.md'), 'Ship it.\n')
    if (process.platform !== 'win32') symlinkSync('nowhere.md', join(folder, 'CLAUDE.md'))
    const shared = [fine('AGENTS.md', 'Ship it.\n')]
    const skipped = process.platform === 'win32' ? undefined : [left('CLAUDE.md', 'link')]
    const refused = await ask('agent_instructions_read', { name: 'Faye:Ken' })
    expect(refused.error).toBe('BAD_NAME')
    expect(refused.shared).toEqual(shared)
    expect(refused.skipped).toEqual(skipped)
    mkdirSync(join(folder, 'agents'))
    for (const [what, bytes, error] of [['over the limit', Buffer.alloc(65_537, 97), 'TOO_LARGE'], ['not text', Buffer.from([0x66, 0xff, 0xfe, 0x66]), 'NOT_UTF8']] as const) {
      writeFileSync(join(folder, 'agents', 'Faye.md'), bytes)
      const answer = await ask('agent_instructions_read')
      expect(answer.error, what).toBe(error)
      expect(answer.shared, what).toEqual(shared)
      expect(answer.skipped, what).toEqual(skipped)
    }
    // Where the folder is not known there is nothing to read beside it.
    const nobody = await phone.request('agent_instructions_read', { agentId: 'no-such-agent', name: 'Faye' }, 30_000)
    expect(nobody.error).toBe('AGENT_NOT_FOUND')
    expect(nobody).not.toHaveProperty('shared')
    expect(nobody).not.toHaveProperty('skipped')
  })

  // What an agent really gets is more than its folder's two files: an agent in a folder of a repository is told what its engines load
  // in the folders above its own, up to the repository's root, each with where it is and which engines load it.
  it('a subfolder agent is told of the files above its own folder, with the engines that load each, and of no more than 256 KiB', async () => {
    const { desk, phone, folder } = await fresh()
    // lampOS is the repository (its `.git` makes it the project's root) and the agent works in packages/app of it.
    execFileSync('git', ['init', '-q'], { cwd: folder })
    const app = join(folder, 'packages', 'app')
    mkdirSync(app, { recursive: true })
    writeFileSync(join(folder, 'AGENTS.md'), 'Root rules.\n')
    writeFileSync(join(folder, 'CLAUDE.md'), '@AGENTS.md\n')
    writeFileSync(join(folder, 'packages', 'CLAUDE.md'), 'Packages.\n')
    writeFileSync(join(app, 'AGENTS.override.md'), 'Override.\n')
    const created = await desk.request('agent_create', { engine: 'claude', cwd: app, bypassPermission: true }, 60_000)
    expect(created.error, JSON.stringify(created)).toBeUndefined()
    const agentId: string = created.agent.id
    await until('the agent to bind its conversation', async () => (await row(desk, agentId))?.sessionId || null, 45_000, 500)
    const ask = () => phone.request('agent_instructions_read', { agentId, name: 'Nina' }, 30_000)
    const told = await ask()
    expect((told.shared as Shared).map((one) => [one.path, one.name, one.loadedBy, one.text])).toEqual([
      ['AGENTS.override.md', 'AGENTS.override.md', ['codex'], 'Override.\n'],
      ['../CLAUDE.md', 'CLAUDE.md', ['claude'], 'Packages.\n'],
      ['../../AGENTS.md', 'AGENTS.md', ['codex'], 'Root rules.\n'],
      ['../../CLAUDE.md', 'CLAUDE.md', ['claude'], '@AGENTS.md\n'],
    ])
    expect(told.skipped).toBeUndefined()
    // However much the folders hold, one read carries 256 KiB of it: the files after that are there, and said to be.
    for (const file of [join(app, 'AGENTS.md'), join(app, 'CLAUDE.md'), join(app, 'CLAUDE.local.md'), join(folder, 'packages', 'AGENTS.md')]) writeFileSync(file, '\x01'.repeat(100_000))
    const much = await ask()
    const texts = (much.shared as Shared).map((one) => one.text.length)
    expect(texts.reduce((all, one) => all + one, 0)).toBeLessThanOrEqual(256 * 1024 + 65_536)
    expect((much.skipped as Array<{ why: string }>).every((one) => one.why === 'too_much')).toBe(true)
    expect(JSON.stringify(much).length).toBeLessThan(2 * 1024 * 1024)
  })

  it('written while it is read, whichever way a file is replaced: every answer is whole, and the last is what the disk holds', async () => {
    const { folder, ask } = await fresh()
    const agentsFile = join(folder, 'AGENTS.md'), claudeFile = join(folder, 'CLAUDE.md')
    const one = 'a'.repeat(50_000), two = 'b'.repeat(50_000)
    writeFileSync(agentsFile, one)
    writeFileSync(claudeFile, one)
    let writing = true
    // One program writes as an editor does, a new file renamed over the old; another writes in place, as a script does.
    const writers = (async () => {
      for (let i = 0; writing; i++) {
        const next = join(folder, `.AGENTS.md.${i}`)
        writeFileSync(next, i % 2 ? one : two)
        renameSync(next, agentsFile)
        writeFileSync(claudeFile, i % 2 ? one : two)
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
    })()
    // And the owner saves her own file again and again, each time on the version she read.
    let version = ''
    const saves = (async () => {
      for (let i = 0; i < 15; i++) version = (await ask('agent_instructions_write', { text: `Version ${i}\n`, version })).version
    })()
    // Awaited below, once the reads are done; a failure now is not an unhandled one in the meantime.
    for (const running of [writers, saves]) running.catch(() => {})
    try {
      for (let round = 0; round < 12; round++) {
        for (const answer of await Promise.all([1, 2, 3, 4].map(() => ask('agent_instructions_read')))) {
          expect(answer).not.toHaveProperty('error')
          const shared = answer.shared as Shared
          // Present throughout, and the renamed one is one text or the other: never a mix.
          expect(shared.map((entry) => entry.name)).toEqual(['AGENTS.md', 'CLAUDE.md'])
          expect([one, two]).toContain(shared[0].text)
          // The one written in place can be caught empty or half written, and is never anything but what was written.
          expect(shared[1].text).toMatch(/^[ab]*$/)
          expect(shared[1].truncated).toBe(false)
          // Her own file is the version of the text it comes with: a save is a file renamed over, never a file seen half.
          if (answer.text !== null) expect(answer.version).toBe(sha256(answer.text))
        }
      }
    } finally { writing = false; await writers; await saves }
    const last = await ask('agent_instructions_read')
    expect(last).toMatchObject({ text: 'Version 14\n', version })
    expect((last.shared as Shared).map((entry) => entry.text)).toEqual([readFileSync(agentsFile, 'utf8'), readFileSync(claudeFile, 'utf8')])
  })

  it('the machine offline: the read is refused at once, and answered with what its disk holds now when it is back', async () => {
    const { w, machine, desk, phone, agentId, folder, ask } = await fresh()
    writeFileSync(join(folder, 'AGENTS.md'), 'Before.\n')
    expect((await ask('agent_instructions_read')).shared).toEqual([fine('AGENTS.md', 'Before.\n')])
    desk.close()
    const offline = phone.next((frame) => frame.type === 'node_status' && frame.payload?.online === false, 30_000, 'node_status offline on the phone')
    await machine.daemon.stop()
    await offline
    // Not asked into nowhere to wait out its timeout: refused where the person can see it.
    await expect(ask('agent_instructions_read')).rejects.toThrow(/no session/)
    // Someone edits the file by hand meanwhile.
    writeFileSync(join(folder, 'AGENTS.md'), 'While it was off.\n')
    await machine.daemon.start()
    const back = await LocalClient.connect(machine.daemon, { machineId: machine.machineId })
    try {
      await until('the agent to come back', async () => {
        const now = await row(back, agentId)
        return now?.status === 'active' && now.launch?.state !== 'starting' ? now : null
      }, 60_000, 500)
    } finally { back.close() }
    await until('the machine to be back on the relay', () => w.backend.nodeUp(machine.machineId) || null, 60_000, 200)
    await until('the phone to open a new session', async () => { await phone.open(10_000); return true }, 60_000, 500)
    expect((await ask('agent_instructions_read')).shared).toEqual([fine('AGENTS.md', 'While it was off.\n')])
  })
})
