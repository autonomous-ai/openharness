import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { buildLogBundle, bundleFileName, redactSecretsInText } from './logBundle.js'
import { crc32, writeZip } from './zipWriter.js'

/** Enough of a ZIP reader to check what writeZip produced: walks the local headers. */
function readZip(zip: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>()
  let at = 0
  while (zip.readUInt32LE(at) === 0x04034b50) {
    const method = zip.readUInt16LE(at + 8)
    const crc = zip.readUInt32LE(at + 14)
    const csize = zip.readUInt32LE(at + 18)
    const nlen = zip.readUInt16LE(at + 26)
    const name = zip.subarray(at + 30, at + 30 + nlen).toString('utf8')
    const body = zip.subarray(at + 30 + nlen, at + 30 + nlen + csize)
    const data = method === 8 ? inflateRawSync(body) : Buffer.from(body)
    expect(crc32(data)).toBe(crc)
    out.set(name, data)
    at += 30 + nlen + csize
  }
  expect(zip.readUInt32LE(at)).toBe(0x02014b50) // the central directory follows the last entry
  return out
}

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
      logsDir: logs, dataDir: data, now, version: '0.2.21', redact: redactSecretsInText,
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
    const { zip, included } = buildLogBundle({ logsDir: logs, dataDir: root, now: new Date(2026, 8, 15, 10, 30), version: '0', redact: redactSecretsInText })
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
    const { zip, included } = buildLogBundle({ logsDir: logs, dataDir: root, now: new Date(2026, 8, 15, 10, 30), version: '0', redact: (t) => t, deviceLogCapBytes: 100 })
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
    const { zip, included } = buildLogBundle({ logsDir: logs, dataDir: root, now: new Date(2026, 8, 15, 10, 30), version: '0', redact: (t) => t })
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
    const { zip, included } = buildLogBundle({ logsDir: join(root, 'none'), dataDir: root, version: '0', redact: (s) => s })
    expect(included).toEqual([])
    expect(readZip(zip).get('README.txt')?.toString()).toContain('nothing')
  })
})
