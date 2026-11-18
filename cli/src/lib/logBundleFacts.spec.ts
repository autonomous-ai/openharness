import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  collectBundleFacts, deviceAppLogsDir, runCommand, statusText, versionLines,
  type FactsDeps, type Run, type RunResult,
} from './logBundleFacts.js'

const SELF = ['/node', '--flag', '/cli.js']
const HOME = '/Users/somebody'
const ok = (stdout: string): RunResult => ({ code: 0, stdout, timedOut: false })

interface Call { file: string; args: readonly string[]; timeoutMs: number }

/** A `run` that records each call and answers with [answer]'s result for it. */
function recording(answer: (call: Call) => RunResult | Promise<RunResult>): { run: Run; calls: Call[] } {
  const calls: Call[] = []
  const run: Run = async (file, args, timeoutMs) => {
    const call = { file, args, timeoutMs }
    calls.push(call)
    return answer(call)
  }
  return { run, calls }
}

/** A `run` whose answers the test gives by hand, each call left waiting until then. */
function waiting(): { run: Run; calls: Call[]; answerAll: (result: RunResult) => void } {
  const calls: Call[] = []
  const pending: ((result: RunResult) => void)[] = []
  const run: Run = (file, args, timeoutMs) => {
    calls.push({ file, args, timeoutMs })
    return new Promise((resolve) => pending.push(resolve))
  }
  return { run, calls, answerAll: (result) => pending.forEach((resolve) => resolve(result)) }
}

const words = (call: Call): string => call.args.slice(2).join(' ')

describe('statusText', () => {
  it('status.txt: each command under its own heading', async () => {
    const answers: Record<string, RunResult> = {
      status: ok('● running\n'),
      'device claude status --json': ok('{"enabled":true}\n'),
      'device codex status --json': { code: 1, stdout: 'half', timedOut: false },
      'device vscode status --json': { code: null, stdout: '', timedOut: true },
    }
    const { run, calls } = recording((call) => answers[words(call)])

    expect(await statusText(SELF, run)).toBe([
      '$ harness status',
      '● running',
      '',
      '$ harness device claude status --json',
      '{"enabled":true}',
      '',
      '$ harness device codex status --json',
      '(exit 1)',
      '',
      '$ harness device vscode status --json',
      '(no answer: timed out after 10 s)',
      '',
    ].join('\n'))
    expect(calls).toEqual(Object.keys(answers).map((command) => (
      { file: '/node', args: ['--flag', '/cli.js', ...command.split(' ')], timeoutMs: 10_000 })))
  })

  it('a command that could not start, threw, or printed nothing is one line', async () => {
    let n = 0
    const run: Run = (_file, _args, _timeoutMs) => {
      n += 1
      if (n === 1) return Promise.resolve({ code: null, stdout: '', timedOut: false })
      if (n === 2) return Promise.reject(new Error('spawn failed'))
      if (n === 3) throw new Error('threw')
      return Promise.resolve(ok('  \n'))
    }

    expect(await statusText(SELF, run)).toBe([
      '$ harness status', '(no answer)', '',
      '$ harness device claude status --json', '(no answer)', '',
      '$ harness device codex status --json', '(no answer)', '',
      '$ harness device vscode status --json', '(no output)', '',
    ].join('\n'))
  })

  // Four commands of 10 s each, one after another, would outlast the desktop app's 30 s wait for the export.
  it('all four start before any answers', async () => {
    const { run, calls, answerAll } = waiting()

    const text = statusText(SELF, run)
    expect(calls).toHaveLength(4)
    answerAll(ok('x\n'))
    await text
  })
})

describe('runCommand', () => {
  it('the real runner gives stdout and the exit code, never stderr', async () => {
    const result = await runCommand(process.execPath,
      ['-e', 'console.log("out"); console.error("SECRET"); process.exit(3)'], 10_000)

    expect(result).toEqual({ code: 3, stdout: 'out\n', timedOut: false })
    expect(JSON.stringify(result)).not.toContain('SECRET')
  })

  it('the real runner ends a command at its time', async () => {
    expect(await runCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], 200))
      .toEqual({ code: null, stdout: '', timedOut: true })
    expect(await runCommand(join(HOME, 'no-such-program'), [], 10_000))
      .toMatchObject({ code: null, timedOut: false })
  })
})

describe('versionLines', () => {
  const deps = (over: Partial<FactsDeps>): FactsDeps => ({
    self: SELF, platform: 'darwin', home: HOME, env: {}, nodeVersion: 'v24.22.2', osRelease: '25.6.0',
    exists: () => false, run: async () => ok(''), ...over,
  })
  const plist = (root: string, app: string): string => join(root, `${app}.app`, 'Contents', 'Info.plist')

  it('on a Mac the versions name the OS and each app found', async () => {
    const harness = plist('/Applications', 'Harness')
    const orca = plist(join(HOME, 'Applications'), 'Orca')
    const versions: Record<string, string> = { [harness]: '1.2.3\n', [orca]: '1.4.262\n' }
    const { run, calls } = recording((call) => (
      call.file === '/usr/bin/sw_vers' ? ok('26.0.1\n') : ok(versions[call.args[call.args.length - 1]])))

    const lines = await versionLines(deps({ run, exists: (path) => path === harness || path === orca }))

    expect(lines).toEqual(['node: v24.22.2', 'os: macOS 26.0.1', 'Harness: 1.2.3', 'Orca: 1.4.262'])
    expect(calls.filter((call) => call.file === '/usr/bin/plutil')).toEqual([harness, orca].map((path) => (
      { file: '/usr/bin/plutil', args: ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', path], timeoutMs: 2_000 })))
  })

  it('an app whose version cannot be read is not listed', async () => {
    const answers: Record<string, RunResult> = {
      [plist('/Applications', 'Harness')]: { code: 1, stdout: '1.0.0\n', timedOut: false },
      [plist('/Applications', 'Orca')]: { code: null, stdout: '', timedOut: true },
      [plist('/Applications', 'Claude')]: ok('not a version!\n'),
    }
    const { run } = recording((call) => (
      call.file === '/usr/bin/sw_vers' ? { code: 1, stdout: '', timedOut: false } : answers[call.args[call.args.length - 1]]))

    const lines = await versionLines(deps({ run, exists: (path) => path in answers }))

    expect(lines).toEqual(['node: v24.22.2', 'os: darwin 25.6.0'])
  })

  it('off a Mac nothing is run', async () => {
    const { run, calls } = recording(() => ok('1.0.0\n'))

    const lines = await versionLines(deps({ platform: 'linux', osRelease: '6.8.0', run, exists: () => true }))

    expect(lines).toEqual(['node: v24.22.2', 'os: linux 6.8.0'])
    expect(calls).toEqual([])
  })
})

describe('deviceAppLogsDir', () => {
  const ID = 'ai.autonomous.harness.device'

  it("the app's log folder, per platform", () => {
    expect(deviceAppLogsDir('darwin', HOME, {})).toBe(join(HOME, 'Library', 'Logs', ID))
    expect(deviceAppLogsDir('linux', '/home/somebody', {})).toBe(join('/home/somebody', '.local', 'share', ID, 'logs'))
    expect(deviceAppLogsDir('linux', '/home/somebody', { XDG_DATA_HOME: '/data' })).toBe(join('/data', ID, 'logs'))
    expect(deviceAppLogsDir('linux', '/home/somebody', { XDG_DATA_HOME: 'data' }))
      .toBe(join('/home/somebody', '.local', 'share', ID, 'logs'))
    expect(deviceAppLogsDir('win32', 'C:\\Users\\somebody', { LOCALAPPDATA: 'C:\\Users\\somebody\\AppData\\Local' }))
      .toBe(join('C:\\Users\\somebody\\AppData\\Local', ID, 'logs'))
    expect(deviceAppLogsDir('win32', 'C:\\Users\\somebody', {})).toBeUndefined()
    expect(deviceAppLogsDir('freebsd', '/home/somebody', {})).toBeUndefined()
  })
})

describe('collectBundleFacts', () => {
  it('the facts come together', async () => {
    const { run, calls, answerAll } = waiting()

    const facts = collectBundleFacts({
      self: SELF, platform: 'darwin', home: HOME, env: {}, nodeVersion: 'v24.22.2', osRelease: '25.6.0',
      exists: () => false, run,
    })
    expect(calls.map((call) => call.file)).toEqual(['/node', '/node', '/node', '/node', '/usr/bin/sw_vers'])
    answerAll(ok('26.0.1\n'))

    expect(await facts).toEqual({
      status: expect.stringMatching(/^\$ harness status\n26\.0\.1\n\n/),
      versions: ['node: v24.22.2', 'os: macOS 26.0.1'],
      deviceAppLogsDir: join(HOME, 'Library', 'Logs', 'ai.autonomous.harness.device'),
    })
  })
})
