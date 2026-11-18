import { REMOVALS_FILE } from './signOut.js'
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readZip } from '../testing/readZip.js'
import { blankPersonal, buildLogBundle, bundleFileName } from './logBundle.js'
import { redactSecretsInText } from './redactSecrets.js'
import { crc32, writeZip } from './zipWriter.js'

describe('zipWriter', () => {
  it('round-trips deflated and stored entries', () => {
    const text = Buffer.from('hello hello hello hello hello hello\n'.repeat(50))
    const noise = Buffer.from(Array.from({ length: 300 }, (_, i) => (i * 7919) % 256))
    const zip = writeZip([{ name: 'a/text.log', data: text }, { name: 'noise.bin', data: noise }])
    const files = readZip(zip)
    expect(files.get('a/text.log')?.equals(text)).toBe(true)
    expect(files.get('noise.bin')?.equals(noise)).toBe(true)
    expect(zip.length).toBeLessThan(text.length) // the repeated text really was compressed
  })

  it('computes the standard CRC-32', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926)
  })
})

describe('buildLogBundle', () => {
  // The fourth review of #4221: the removals kept apart from harness.log (signOut.ts) are what to read when a person was signed
  // out without knowing why, and the bundle a person sends left them out.
  it('takes the sign-in removals kept apart, whole and redacted', () => {
    const root = mkdtempSync(join(tmpdir(), 'bundle-'))
    const logs = join(root, 'logs'), data = join(root, 'data')
    mkdirSync(logs); mkdirSync(data)
    writeFileSync(join(data, REMOVALS_FILE), '2026-11-12 04:58:09.000 [auth] sign-in removed · reason=logout · pid=2 (x token=abcdefgh12345)\n')
    const { zip, included } = buildLogBundle({ logsDir: logs, dataDir: data, now: new Date(2026, 10, 12), version: '0.6.50', home: '/Users/nobody', redact: redactSecretsInText })
    const files = readZip(zip)
    expect(files.get(REMOVALS_FILE)?.toString()).toBe('2026-11-12 04:58:09.000 [auth] sign-in removed · reason=logout · pid=2 (x token=<redacted>\n')
    expect(included).toContain(REMOVALS_FILE)
  })

  it('takes the last week of dated logs, the daemon log tail, and redacts', () => {
    const root = mkdtempSync(join(tmpdir(), 'bundle-'))
    const logs = join(root, 'logs'), data = join(root, 'data')
    mkdirSync(logs); mkdirSync(data)
    const now = new Date(2026, 8, 15, 10, 30)
    writeFileSync(join(logs, 'dial-20260915.log'), 'I (1) touch: press\nsession_token: abcdefgh12345\n')
    writeFileSync(join(logs, 'app-20260910.log'), 'in window\n')
    writeFileSync(join(logs, 'app-20260908.log'), 'too old\n')
    writeFileSync(join(logs, 'cli-20260915.log'), 'Bearer abcdefghijklmnop\n')
    writeFileSync(join(logs, 'unrelated.txt'), 'no\n')
    writeFileSync(join(data, 'harness.log'), 'x'.repeat(100) + 'THE END\n')
    const { zip, included } = buildLogBundle({
      logsDir: logs, dataDir: data, now, version: '0.2.21', home: '/Users/nobody', redact: redactSecretsInText,
      harnessLogTailBytes: 8, notes: ['app: 1.1.22'],
    })
    const files = readZip(zip)
    expect([...files.keys()]).toEqual(['README.txt', 'logs/app-20260910.log', 'logs/cli-20260915.log', 'logs/dial-20260915.log', 'harness.log'])
    expect(files.get('logs/dial-20260915.log')?.toString()).toBe('I (1) touch: press\nsession_token: <redacted>\n')
    expect(files.get('logs/cli-20260915.log')?.toString()).toBe('Bearer <redacted>\n')
    expect(files.get('harness.log')?.toString()).toBe('THE END\n')
    expect(files.get('README.txt')?.toString()).toContain('app: 1.1.22')
    expect(included).toContain('dial-20260915.log')
    expect(bundleFileName(now)).toBe('harness-logs-20260915-1030.zip')
  })

  it('takes each device\'s own dial logs from its usb-<serial> folder, redacted, within the same week', () => {
    // The fleet writes one folder per device (cableFleet.ts); a bundle without them left out the Pro's own
    // console on 20-26 Oct, the one log that says whether it rebooted.
    const root = mkdtempSync(join(tmpdir(), 'bundle-'))
    const logs = join(root, 'logs'), pro = join(logs, 'usb-E8-F6-0A-E7-63-7D'), other = join(logs, 'notes')
    mkdirSync(pro, { recursive: true }); mkdirSync(other)
    writeFileSync(join(pro, 'dial-20260915.log'), '[daemon] dial E8 on fw 0.1.13 board pro\nsession_token: abcdefgh12345\n')
    writeFileSync(join(pro, 'dial-20260901.log'), 'too old\n')
    writeFileSync(join(pro, 'notes.txt'), 'no\n')
    writeFileSync(join(other, 'dial-20260915.log'), 'not a device folder\n')
    const { zip, included } = buildLogBundle({ logsDir: logs, dataDir: root, now: new Date(2026, 8, 15, 10, 30), version: '0', home: '/Users/nobody', redact: redactSecretsInText })
    const files = readZip(zip)
    expect([...files.keys()]).toEqual(['README.txt', 'logs/usb-E8-F6-0A-E7-63-7D/dial-20260915.log'])
    expect(files.get('logs/usb-E8-F6-0A-E7-63-7D/dial-20260915.log')?.toString()).toBe('[daemon] dial E8 on fw 0.1.13 board pro\nsession_token: <redacted>\n')
    expect(included).toEqual(['usb-E8-F6-0A-E7-63-7D/dial-20260915.log'])
  })

  it('caps the devices\' dial logs, newest first, so a desk of devices cannot make the bundle huge', () => {
    const root = mkdtempSync(join(tmpdir(), 'bundle-'))
    const logs = join(root, 'logs'), a = join(logs, 'usb-AA'), b = join(logs, 'usb-BB')
    mkdirSync(a, { recursive: true }); mkdirSync(b)
    writeFileSync(join(a, 'dial-20260915.log'), 'a'.repeat(40))
    writeFileSync(join(b, 'dial-20260914.log'), 'b'.repeat(40))
    writeFileSync(join(a, 'dial-20260913.log'), 'c'.repeat(40))
    writeFileSync(join(logs, 'app-20260913.log'), 'the app log is not capped\n')
    const { zip, included } = buildLogBundle({ logsDir: logs, dataDir: root, now: new Date(2026, 8, 15, 10, 30), version: '0', home: '/Users/nobody', redact: (t) => t, deviceLogCapBytes: 100 })
    expect([...readZip(zip).keys()]).toEqual(['README.txt', 'logs/app-20260913.log', 'logs/usb-AA/dial-20260915.log', 'logs/usb-BB/dial-20260914.log'])
    expect(included).toContain('usb-AA/dial-20260913.log (left out to keep the bundle small)')
  })

  it('keeps every device\'s newest day, as its tail when that day alone is over the cap, then older days while there is room', () => {
    // The reviewer's case: dialLog caps a day at 20 MB and then writes one more line, so a newest day can be 20 MB + 90 B.
    // Counting whole files left that day out, and every older day after it.
    const root = mkdtempSync(join(tmpdir(), 'bundle-'))
    const logs = join(root, 'logs'), big = join(logs, 'usb-AA'), small = join(logs, 'usb-BB')
    mkdirSync(big, { recursive: true }); mkdirSync(small)
    const cap = 20 * 1024 * 1024
    writeFileSync(join(big, 'dial-20260915.log'), 'x'.repeat(cap) + 'y'.repeat(89) + '\n')
    writeFileSync(join(big, 'dial-20260914.log'), 'o'.repeat(1024))
    writeFileSync(join(small, 'dial-20260913.log'), 'the other device\n')
    const { zip, included } = buildLogBundle({ logsDir: logs, dataDir: root, now: new Date(2026, 8, 15, 10, 30), version: '0', home: '/Users/nobody', redact: (t) => t })
    const files = readZip(zip)
    expect([...files.keys()]).toEqual(['README.txt', 'logs/usb-AA/dial-20260915.log', 'logs/usb-BB/dial-20260913.log'])
    const newest = files.get('logs/usb-AA/dial-20260915.log')!
    expect(newest.length).toBe(cap - 17)
    expect(newest.toString().endsWith('y'.repeat(89) + '\n')).toBe(true)
    expect(files.get('logs/usb-BB/dial-20260913.log')?.toString()).toBe('the other device\n')
    expect(included).toEqual(expect.arrayContaining([
      `usb-AA/dial-20260915.log (last ${Math.round((cap - 17) / 1024)} KB)`,
      'usb-AA/dial-20260914.log (left out to keep the bundle small)',
    ]))
  })

  it('still produces a bundle with a README when there is nothing to include', () => {
    const root = mkdtempSync(join(tmpdir(), 'bundle-'))
    const { zip, included } = buildLogBundle({ logsDir: join(root, 'none'), dataDir: root, version: '0', home: '/Users/nobody', redact: (s) => s })
    expect(included).toEqual([])
    expect(readZip(zip).get('README.txt')?.toString()).toContain('nothing')
  })

  it('takes the menu-bar app\'s log in the window, and nothing else of its folder', () => {
    // The app's folder also holds its state, and whatever else lands there: only its own dated log is read.
    const root = mkdtempSync(join(tmpdir(), 'bundle-'))
    const app = join(root, 'app')
    mkdirSync(join(app, 'app-20260914.log'), { recursive: true })
    for (const name of ['app-20260915.log', 'app-20260901.log', 'cli-20260915.log', 'app-20260915.log.bak', 'state.json']) writeFileSync(join(app, name), `${name}\n`)
    writeFileSync(join(root, 'elsewhere'), 'NEVER-IN-THE-BUNDLE\n')
    symlinkSync(join(root, 'elsewhere'), join(app, 'app-20260913.log'))
    const none = join(root, 'none')
    const { zip, included } = buildLogBundle({ logsDir: none, dataDir: none, deviceAppLogsDir: app, now: new Date(2026, 8, 15, 10, 30), version: '0', home: '/Users/nobody', redact: (t) => t })
    const files = readZip(zip)
    expect([...files.keys()]).toEqual(['README.txt', 'logs/harness-device/app-20260915.log'])
    expect(files.get('logs/harness-device/app-20260915.log')?.toString()).toBe('app-20260915.log\n')
    expect(included).toEqual(['harness-device/app-20260915.log'])
  })

  it('a missing app log folder includes nothing', () => {
    const root = mkdtempSync(join(tmpdir(), 'bundle-'))
    const { zip, included } = buildLogBundle({ logsDir: root, dataDir: root, deviceAppLogsDir: join(root, 'missing'), now: new Date(2026, 8, 15, 10, 30), version: '0', home: '/Users/nobody', redact: (t) => t })
    expect([...readZip(zip).keys()]).toEqual(['README.txt'])
    expect(included).toEqual([])
  })

  it('blanks a token, an email and the home in every text file', () => {
    const root = mkdtempSync(join(tmpdir(), 'bundle-'))
    const logs = join(root, 'logs'), data = join(root, 'data'), app = join(root, 'app')
    mkdirSync(join(logs, 'usb-AA'), { recursive: true }); mkdirSync(data); mkdirSync(app)
    const line = 'Bearer abcdefghijklmnop for person@example.com in /Users/somebody/project/src\n'
    for (const path of [join(logs, 'cli-20260915.log'), join(logs, 'usb-AA', 'dial-20260915.log'), join(data, 'harness.log'), join(data, REMOVALS_FILE), join(app, 'app-20260915.log')]) writeFileSync(path, line)
    const { zip } = buildLogBundle({
      logsDir: logs, dataDir: data, deviceAppLogsDir: app, status: line, now: new Date(2026, 8, 15, 10, 30), version: '0',
      home: '/Users/somebody', redact: redactSecretsInText,
    })
    const files = readZip(zip)
    const names = ['logs/cli-20260915.log', 'logs/usb-AA/dial-20260915.log', 'harness.log', REMOVALS_FILE, 'logs/harness-device/app-20260915.log', 'status.txt']
    expect(Object.fromEntries(names.map((name) => [name, files.get(name)?.toString()])))
      .toEqual(Object.fromEntries(names.map((name) => [name, 'Bearer <redacted> for <email> in ~/project/src\n'])))
  })

  it('the home is blanked as a whole folder', () => {
    // Another person's folder that begins with the same name is not the home: blanking it would hide whose it is.
    expect(blankPersonal('/Users/al/x /Users/alice/y /Users/al. /Users/al', '/Users/al')).toBe('~/x /Users/alice/y ~. ~')
    expect(blankPersonal('/Users/al/x', '/Users/al/')).toBe('~/x')
    // A Windows home in a JSON log line has each `\` doubled.
    expect(blankPersonal('{"cwd":"C:\\\\Users\\\\al\\\\repo"} C:\\Users\\al\\x', 'C:\\Users\\al')).toBe('{"cwd":"~\\\\repo"} ~\\x')
    // A root holds every path: it is no one's home.
    for (const home of ['', '/', 'C:\\']) expect(blankPersonal('cd / && ls /Users/al C:\\x', home)).toBe('cd / && ls /Users/al C:\\x')
  })

  it('a long line with no address does not stall the blanking', () => {
    // A rule that tries every start of a long run (base64, hex) against its end took 20 s on 100 KB: an export with
    // such a line would outlast the 30 s the desktop app waits for it.
    const line = 'A'.repeat(100_000)
    const started = performance.now()
    expect(blankPersonal(`${line} person@example.com`, '/Users/al')).toBe(`${line} <email>`)
    expect(performance.now() - started).toBeLessThan(2_000)
  })

  it('never includes a transcript, a sign-in file or a project file placed beside the logs', () => {
    const root = mkdtempSync(join(tmpdir(), 'bundle-'))
    const logs = join(root, 'logs'), device = join(logs, 'usb-AA'), data = join(root, 'data'), app = join(root, 'app')
    for (const dir of [device, data, app]) mkdirSync(dir, { recursive: true })
    for (const dir of [logs, device, data, app]) {
      for (const name of ['session.jsonl', 'auth.json', 'main.ts', 'notes.md']) writeFileSync(join(dir, name), 'NEVER-IN-THE-BUNDLE\n')
    }
    writeFileSync(join(logs, 'app-20260915.log'), 'the desktop app\n')
    writeFileSync(join(device, 'dial-20260915.log'), 'the dial\n')
    writeFileSync(join(data, 'harness.log'), 'the daemon\n')
    writeFileSync(join(app, 'app-20260915.log'), 'the menu-bar app\n')
    const { zip } = buildLogBundle({ logsDir: logs, dataDir: data, deviceAppLogsDir: app, now: new Date(2026, 8, 15, 10, 30), version: '0', home: '/Users/nobody', redact: (t) => t })
    const files = readZip(zip)
    expect([...files.keys()]).toEqual(['README.txt', 'logs/app-20260915.log', 'logs/usb-AA/dial-20260915.log', 'logs/harness-device/app-20260915.log', 'harness.log'])
    expect([...files].filter(([, bytes]) => bytes.includes('NEVER-IN-THE-BUNDLE')).map(([name]) => name)).toEqual([])
  })

  it('status.txt holds what it is given, blanked, right after the README', () => {
    const root = mkdtempSync(join(tmpdir(), 'bundle-'))
    writeFileSync(join(root, 'app-20260915.log'), 'the desktop app\n')
    const opts = { logsDir: root, dataDir: root, now: new Date(2026, 8, 15, 10, 30), version: '0', home: '/Users/somebody', redact: redactSecretsInText }
    const { zip, included } = buildLogBundle({ ...opts, status: '$ harness status\nsigned in as person@example.com at /Users/somebody/.harness\n' })
    const files = readZip(zip)
    expect([...files.keys()]).toEqual(['README.txt', 'status.txt', 'logs/app-20260915.log'])
    expect(files.get('status.txt')?.toString()).toBe('$ harness status\nsigned in as <email> at ~/.harness\n')
    expect(included).toEqual(['status.txt', 'app-20260915.log'])
    expect([...readZip(buildLogBundle(opts).zip).keys()]).toEqual(['README.txt', 'logs/app-20260915.log'])
  })

  it('the README lists the notes given to it and says what is blanked and never included', () => {
    const root = mkdtempSync(join(tmpdir(), 'bundle-'))
    const { zip } = buildLogBundle({
      logsDir: root, dataDir: root, version: '0', home: '/Users/somebody', redact: (t) => t,
      notes: ['node: v24.22.2', 'Harness Device: 0.1.0', 'cwd: /Users/somebody/work'],
    })
    const readme = readZip(zip).get('README.txt')!.toString()
    expect(readme).toContain('\nnode: v24.22.2\nHarness Device: 0.1.0\ncwd: ~/work\n')
    expect(readme).toContain([
      'Blanked before writing: secrets (tokens, keys, passwords, signed URLs), email addresses (<email>) and the home folder (~).',
      'Never included: conversations and transcripts, prompts, voice, tokens, keys, passwords and sign-in files, any process\'s environment, project files.',
      'status.txt: what `harness status` and `harness device claude|codex|vscode status --json` printed.',
      'logs/harness-device/: the Harness menu-bar app\'s own log.',
      'The dial\'s firmware version is in harness.log: the `fw` on the `cable: dial … on fw …` line of each dial greeting.',
      'dial-*.log: the dial\'s own console',
    ].join('\n'))
  })
})
