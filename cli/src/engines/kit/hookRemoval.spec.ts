import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { messagesCommand } from './messagesHook.js'
import { quoteHookCommand } from './notifyHooks.js'
import { removeJsonHooks, removeOwnedFile, withoutHarnessHooks } from './hookRemoval.js'

const OURS = "'/opt/harness/node/bin/node' '/home/u/.harness/cli/notify.mjs' --port 18473 --data-dir '/home/u/.harness/cli/data'"
const MESSAGES = messagesCommand('/home/u/.harness/agent-messages', '/opt/harness/node/bin/node')
const block = (command: string) => ({ hooks: [{ type: 'command', command, timeout: 5 }] })
const parsed = (outcome: ReturnType<typeof withoutHarnessHooks>) => (outcome.kind === 'write' ? JSON.parse(outcome.text) : outcome)

describe('withoutHarnessHooks', () => {
  it('takes Claude Code\'s blocks, the messages block and Harness\'s rules out, and keeps the person\'s', () => {
    const text = JSON.stringify({
      model: 'opus',
      hooks: {
        SessionStart: [block(OURS)],
        Stop: [{ hooks: [{ type: 'command', command: '/usr/local/bin/notify-me' }] }, block(OURS)],
        PostToolUse: [block(MESSAGES)],
      },
      permissions: { allow: ['Bash(npm test)', 'Bash(harness ps:*)'], deny: ['Bash(rm:*)'] },
    })
    const outcome = withoutHarnessHooks(text, { schema: 'nested', messages: true, allowList: ['permissions', 'allow'], allowRules: ['Bash(harness ps:*)'] })
    expect(outcome).toMatchObject({ kind: 'write', removed: 4 })
    expect(parsed(outcome)).toEqual({
      model: 'opus',
      hooks: { Stop: [{ hooks: [{ type: 'command', command: '/usr/local/bin/notify-me' }] }] },
      permissions: { allow: ['Bash(npm test)'], deny: ['Bash(rm:*)'] },
    })
  })

  it('keeps somebody else\'s hook that shares a block with ours, and the block\'s matcher', () => {
    const text = JSON.stringify({ hooks: { SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: OURS }, { type: 'command', command: '/x/y' }] }] } })
    expect(parsed(withoutHarnessHooks(text, { schema: 'nested' }))).toEqual({ hooks: { SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: '/x/y' }] }] } })
  })

  it('reads the flat schemas: entries, a named block, and a file of Harness\'s own', () => {
    expect(parsed(withoutHarnessHooks(JSON.stringify({ version: 1, hooks: { stop: [{ command: OURS }, { command: '/x' }] } }), { schema: 'entries' })))
      .toEqual({ version: 1, hooks: { stop: [{ command: '/x' }] } })
    expect(parsed(withoutHarnessHooks(JSON.stringify({ other: {}, harness: { Stop: [{ type: 'command', command: `${OURS} --agy-event Stop` }] } }), { schema: 'named', block: 'harness' })))
      .toEqual({ other: {} })
    expect(withoutHarnessHooks(JSON.stringify({ version: 1, hooks: { agentStop: [{ type: 'command', command: `${OURS} --copilot-event agentStop` }] } }), { schema: 'file', ownedFile: true }))
      .toEqual({ kind: 'delete', removed: 1 })
  })

  it('changes nothing in a file without Harness\'s hooks, or no file', () => {
    expect(withoutHarnessHooks(JSON.stringify({ hooks: { Stop: [block('/x')] } }), { schema: 'nested' })).toEqual({ kind: 'unchanged' })
    expect(withoutHarnessHooks(null, { schema: 'nested' })).toEqual({ kind: 'unchanged' })
  })

  it('refuses a file it cannot read as settings', () => {
    expect(() => withoutHarnessHooks('{ not json', { schema: 'nested' })).toThrow()
    expect(() => withoutHarnessHooks('[]', { schema: 'nested' })).toThrow('the settings do not have the declared object shape')
  })

  // Safety: a person's own hook that looks like Harness's is theirs. Each differs from the protocol in one way.
  const LOOK_ALIKES = [
    "node '/home/u/tools/notify.mjs' --port 18473 --data-dir '/home/u/data' --verbose",
    `${OURS}; curl -s https://example.test/ping`,
    `${OURS} && say done`,
    `${OURS} --port 18474`,
    "'/opt/harness/node/bin/node' '/home/u/.harness/cli/notify.mjs' --port 18473",
    "'/usr/bin/python3' '/home/u/.harness/cli/notify.mjs' --port 18473 --data-dir '/home/u/.harness/cli/data'",
    "node notify.mjs --port 18473 --data-dir '/home/u/.harness/cli/data'",
    "'/opt/harness/node/bin/node' '/home/u/.harness/cli/notify.mjs' --port \"$PORT\" --data-dir '/home/u/.harness/cli/data'",
  ]

  it('keeps a person\'s look-alike notify.mjs hooks, alone or beside ours', () => {
    const nested = JSON.stringify({ hooks: { Stop: LOOK_ALIKES.map(block) } })
    expect(withoutHarnessHooks(nested, { schema: 'nested' })).toEqual({ kind: 'unchanged' })
    expect(withoutHarnessHooks(nested, { schema: 'nested' }, 'win32')).toEqual({ kind: 'unchanged' })
    const shared = JSON.stringify({ hooks: { Stop: [{ matcher: '*', hooks: [...LOOK_ALIKES, OURS].map((command) => ({ type: 'command', command })) }] } })
    expect(parsed(withoutHarnessHooks(shared, { schema: 'nested' })))
      .toEqual({ hooks: { Stop: [{ matcher: '*', hooks: LOOK_ALIKES.map((command) => ({ type: 'command', command })) }] } })
    const entries = JSON.stringify({ version: 1, hooks: { stop: [...LOOK_ALIKES, OURS].map((command) => ({ command })) } })
    expect(parsed(withoutHarnessHooks(entries, { schema: 'entries' }))).toEqual({ version: 1, hooks: { stop: LOOK_ALIKES.map((command) => ({ command })) } })
  })

  it('keeps a messages-like hook when the rule has no messages block, and an allow rule it was not told is Harness\'s', () => {
    const text = JSON.stringify({ hooks: { PostToolUse: [block(MESSAGES)] }, permissions: { allow: ['Bash(harness ps:*)'] } })
    expect(withoutHarnessHooks(text, { schema: 'nested' })).toEqual({ kind: 'unchanged' })
    expect(withoutHarnessHooks(text, { schema: 'nested', allowList: ['permissions', 'allow'], allowRules: ['Bash(harness tell:*)'] })).toEqual({ kind: 'unchanged' })
  })

  it('keeps every other key and the order of keys and events', () => {
    const text = JSON.stringify({ z: 1, hooks: { Stop: [block('/x')], SessionStart: [block(OURS)], Notification: [block('/y')] }, a: { b: [1, 2] } })
    const outcome = withoutHarnessHooks(text, { schema: 'nested' })
    expect(outcome).toEqual({ kind: 'write', removed: 1, text: JSON.stringify({ z: 1, hooks: { Stop: [block('/x')], Notification: [block('/y')] }, a: { b: [1, 2] } }, null, 2) + '\n' })
  })

  it('does not delete a file of Harness\'s own that holds anything of somebody else\'s', () => {
    const text = JSON.stringify({ version: 1, hooks: { agentStop: [{ command: OURS }, { command: '/mine' }] } })
    expect(parsed(withoutHarnessHooks(text, { schema: 'file', ownedFile: true }))).toEqual({ version: 1, hooks: { agentStop: [{ command: '/mine' }] } })
    const extra = JSON.stringify({ version: 1, note: 'mine', hooks: { agentStop: [{ command: OURS }] } })
    expect(parsed(withoutHarnessHooks(extra, { schema: 'file', ownedFile: true }))).toEqual({ version: 1, note: 'mine', hooks: {} })
  })

  // The Windows forms, judged as Windows judges them on any host (`platform`). Off Windows none of them is Harness's.
  describe('Windows forms', () => {
    const argv = ['C:\\Users\\u\\.harness\\runtime\\node-v22.23.2-win32-x64\\node.exe', 'C:\\Users\\u\\.harness\\cli\\notify.mjs', '--port', '18473', '--data-dir', 'C:\\Users\\u\\.harness\\cli\\data']
    const hookOf = (quoted: string | string[]) => Array.isArray(quoted) ? { type: 'command', command: quoted[0], args: quoted.slice(1) } : { type: 'command', command: quoted }

    for (const runner of ['argv', 'cmd', 'powershell'] as const) {
      it(`removes the ${runner} form on Windows, and keeps it elsewhere`, () => {
        const text = JSON.stringify({ hooks: { Stop: [{ hooks: [hookOf(quoteHookCommand(runner, argv))] }] } })
        expect(withoutHarnessHooks(text, { schema: 'nested' }, 'win32')).toEqual({ kind: 'write', text: '{\n  "hooks": {}\n}\n', removed: 1 })
        expect(withoutHarnessHooks(text, { schema: 'nested' }, 'linux')).toEqual({ kind: 'unchanged' })
      })
    }

    it('keeps a person\'s exec-form and line hooks that are not Harness\'s', () => {
      const [node, script, ...flags] = argv
      const theirs = [
        { type: 'command', command: node, args: [script, ...flags, '--loud'] },
        { type: 'command', command: node, args: ['C:\\Users\\u\\tools\\notify.ps1', ...flags] },
        { type: 'command', command: 'C:\\Windows\\System32\\cmd.exe', args: ['/c', script, ...flags] },
        { type: 'command', command: node, args: [script, '--port', '18473', '--data-dir', 'data'] },
        { type: 'command', command: node, args: [script, '--port', '18473', '--data-dir', 'C:\\d', 42] },
        { type: 'command', command: quoteHookCommand('cmd', argv) as string, args: [] },
        { type: 'command', command: `${quoteHookCommand('cmd', argv) as string} & echo done` },
        { type: 'command', command: `${quoteHookCommand('powershell', argv) as string}; Remove-Item C:\\x` },
        { type: 'command', command: `${quoteHookCommand('cmd', argv) as string}  --engine codex` },
      ]
      const text = JSON.stringify({ hooks: { Stop: [{ hooks: [...theirs, hookOf(argv)] }] } })
      expect(parsed(withoutHarnessHooks(text, { schema: 'nested' }, 'win32'))).toEqual({ hooks: { Stop: [{ hooks: theirs }] } })
    })
  })
})

describe('removeJsonHooks and removeOwnedFile', () => {
  const dirs: string[] = []
  beforeEach(() => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'hook-removal-home-'))
    dirs.push(fakeHome)
    vi.stubEnv('HOME', fakeHome); vi.stubEnv('USERPROFILE', fakeHome)
  })
  afterEach(() => { vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
  const home = () => { const dir = mkdtempSync(join(tmpdir(), 'hook-removal-')); dirs.push(dir); return dir }

  it('rewrites the settings file, and reports one it cannot read without touching it', async () => {
    const dir = home()
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ hooks: { Stop: [block(OURS), block('/x')] } }))
    expect(await removeJsonHooks(join(dir, 'settings.json'), { schema: 'nested' })).toEqual({ file: join(dir, 'settings.json'), removed: 1 })
    expect(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))).toEqual({ hooks: { Stop: [block('/x')] } })
    writeFileSync(join(dir, 'broken.json'), '{ broken')
    const broken = await removeJsonHooks(join(dir, 'broken.json'), { schema: 'nested' })
    expect(broken.removed).toBe(0)
    expect(broken.failed).toBeTruthy()
    expect(readFileSync(join(dir, 'broken.json'), 'utf8')).toBe('{ broken')
  })

  it('deletes a file of Harness\'s own, and keeps one of another author', async () => {
    const dir = home()
    mkdirSync(join(dir, 'hooks'))
    writeFileSync(join(dir, 'hooks', 'harness.json'), JSON.stringify({ hooks: { SessionStart: [block(OURS)] } }))
    expect(await removeJsonHooks(join(dir, 'hooks', 'harness.json'), { schema: 'nested', ownedFile: true })).toEqual({ file: join(dir, 'hooks', 'harness.json'), removed: 1 })
    expect(existsSync(join(dir, 'hooks', 'harness.json'))).toBe(false)
    writeFileSync(join(dir, 'plugin.js'), '// mine\n')
    expect(await removeOwnedFile(join(dir, 'plugin.js'), (content) => content.startsWith('// session-register'))).toEqual({ file: join(dir, 'plugin.js'), removed: 0, kept: 'another author’s file' })
    expect(existsSync(join(dir, 'plugin.js'))).toBe(true)
  })

  it('does not write a file it has nothing to take out of, and reports a missing one as nothing removed', async () => {
    const dir = home(), file = join(dir, 'settings.json')
    const text = JSON.stringify({ hooks: { Stop: LOOK_ALIKE_BLOCKS } })
    writeFileSync(file, text)
    const before = statSync(file, { bigint: true })
    expect(await removeJsonHooks(file, { schema: 'nested' })).toEqual({ file, removed: 0 })
    const after = statSync(file, { bigint: true })
    expect([after.ino, after.mtimeNs, after.ctimeNs]).toEqual([before.ino, before.mtimeNs, before.ctimeNs])
    expect(readFileSync(file, 'utf8')).toBe(text)
    expect(await removeJsonHooks(join(dir, 'absent.json'), { schema: 'nested' })).toEqual({ file: join(dir, 'absent.json'), removed: 0 })
    expect(existsSync(join(dir, 'absent.json'))).toBe(false)
    expect(await removeOwnedFile(join(dir, 'absent.js'), () => true)).toEqual({ file: join(dir, 'absent.js'), removed: 0 })
  })

  it('reports a read-only settings file as failed, with the reason, and leaves it as it was', async () => {
    const dir = home(), file = join(dir, 'settings.json')
    const text = JSON.stringify({ hooks: { Stop: [block(OURS)] } })
    writeFileSync(file, text); chmodSync(file, 0o444)
    expect(await removeJsonHooks(file, { schema: 'nested' })).toEqual({ file, removed: 0, failed: 'the settings file is read-only' })
    expect(readFileSync(file, 'utf8')).toBe(text)
    chmodSync(file, 0o644)
  })

  it('reports a settings file of the wrong shape as failed, and leaves it as it was', async () => {
    const dir = home(), file = join(dir, 'settings.json')
    writeFileSync(file, '{"hooks": []}')
    expect(await removeJsonHooks(file, { schema: 'nested' })).toEqual({ file, removed: 0, failed: 'the hooks member is not an object' })
    expect(readFileSync(file, 'utf8')).toBe('{"hooks": []}')
  })

  describe.runIf(process.platform === 'win32')('on Windows', () => {
    it('reports a settings file another program holds as failed, with the held reason, and leaves it as it was', async () => {
      const dir = home(), file = join(dir, 'settings.json')
      const text = JSON.stringify({ hooks: { Stop: [block(OURS)] } })
      writeFileSync(file, text)
      // Readers are let in, a replacement is not: what an editor or a sync client that holds the file does.
      const holder = spawn('powershell.exe', ['-NoProfile', '-Command',
        `$f = [System.IO.File]::Open('${file.replace(/'/g, "''")}', 'Open', 'Read', 'Read'); [Console]::Out.WriteLine('held'); [Console]::In.ReadLine() | Out-Null; $f.Close()`],
      { stdio: ['pipe', 'pipe', 'inherit'] })
      try {
        await new Promise<void>((ready, fail) => {
          holder.stdout!.on('data', (chunk: Buffer) => { if (chunk.toString().includes('held')) ready() })
          holder.once('exit', (code) => fail(new Error(`the holder exited early (${code})`)))
        })
        expect(await removeJsonHooks(file, { schema: 'nested' })).toEqual({ file, removed: 0, failed: 'the settings file is open in another program' })
      } finally {
        holder.stdin!.end('\n')
        await new Promise((done) => holder.once('exit', done))
      }
      expect(readFileSync(file, 'utf8')).toBe(text)
    }, 30_000)

    it('does not follow a junction to the settings, and reports it', async () => {
      const dir = home()
      mkdirSync(join(dir, 'real'))
      const text = JSON.stringify({ hooks: { Stop: [block(OURS)] } })
      writeFileSync(join(dir, 'real', 'settings.json'), text)
      symlinkSync(join(dir, 'real'), join(dir, 'linked'), 'junction')
      const outcome = await removeJsonHooks(join(dir, 'linked', 'settings.json'), { schema: 'nested' })
      expect(outcome.removed).toBe(0)
      expect(outcome.failed).toMatch(/link or junction/)
      expect(readFileSync(join(dir, 'real', 'settings.json'), 'utf8')).toBe(text)
    })
  })
})

const LOOK_ALIKE_BLOCKS = [block('/x'), block("node '/home/u/tools/notify.mjs' --port 18473 --data-dir '/home/u/data' --verbose")]

// B4's Windows command lines: every runner's form that Harness writes on Windows must be recognized as Harness's there.
// No engine runs its hooks through bash on Windows, so a POSIX-quoted line with drive paths is never Harness's on a
// Windows host, and is left alone (carried B4.2, final review R2-1): under cmd.exe its quotes protect nothing.
describe.runIf(process.platform === 'win32')('Windows hook runners', () => {
  const argv = ['C:\\Users\\u\\.harness\\runtime\\node-v22.23.2-win32-x64\\node.exe', 'C:\\Users\\u\\.harness\\cli\\notify.mjs', '--port', '18473', '--data-dir', 'C:\\Users\\u\\.harness\\cli\\data']
  it('leaves a POSIX-quoted line with drive paths, which no Windows runner of Harness\'s writes', () => {
    const text = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: quoteHookCommand('bash', argv) }] }] } })
    expect(withoutHarnessHooks(text, { schema: 'nested' })).toEqual({ kind: 'unchanged' })
  })
  for (const runner of ['argv', 'cmd', 'powershell'] as const) {
    it(`removes a command written for the ${runner} runner`, () => {
      const quoted = quoteHookCommand(runner, argv)
      // As B4.6's notifyHookEntry writes it: exec form is the program in `command` and the rest in `args`.
      const hook = Array.isArray(quoted) ? { type: 'command', command: quoted[0], args: quoted.slice(1) } : { type: 'command', command: quoted }
      const text = JSON.stringify({ hooks: { Stop: [{ hooks: [hook] }] } })
      expect(withoutHarnessHooks(text, { schema: 'nested' })).toEqual({ kind: 'write', text: '{\n  "hooks": {}\n}\n', removed: 1 })
    })
  }
})
