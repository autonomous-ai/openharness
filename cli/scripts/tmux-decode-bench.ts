/** Decoder-only before/after benchmark. Run from cli/ with:
 * node --import tsx scripts/tmux-decode-bench.ts /tmp/tmux-decode.json
 * The question uses recorded terminal paint; the other inputs are synthetic.
 * This does not measure tmux, the transport, rendering, or whole-app energy.
 */
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { decodeTmuxControlBytes } from '../src/lib/tmuxStream.js'

/** Exact decoder from CLI 0.3.45 (bb0cf693a), retained only for comparison. */
function previousDecoder(encoded: Uint8Array): Uint8Array {
  const input = Buffer.from(encoded)
  const chunks: Buffer[] = []
  let plainStart = 0
  for (let i = 0; i < input.length; i++) {
    if (input[i] !== 0x5c
      || i + 3 >= input.length
      || input[i + 1] < 0x30 || input[i + 1] > 0x37
      || input[i + 2] < 0x30 || input[i + 2] > 0x37
      || input[i + 3] < 0x30 || input[i + 3] > 0x37) continue
    if (i > plainStart) chunks.push(input.subarray(plainStart, i))
    const value = ((input[i + 1] - 0x30) << 6)
      | ((input[i + 2] - 0x30) << 3)
      | (input[i + 3] - 0x30)
    chunks.push(Buffer.from([value]))
    i += 3
    plainStart = i + 1
  }
  if (plainStart < input.length) chunks.push(input.subarray(plainStart))
  return Buffer.concat(chunks)
}

function escaped(bytes: Uint8Array): Buffer {
  return Buffer.from([...bytes].map(byte => byte < 0x20 || byte === 0x5c || byte === 0x7f
    ? `\\${byte.toString(8).padStart(3, '0')}` : String.fromCharCode(byte)).join(''), 'latin1')
}

const fixtures: Array<[string, Buffer]> = [
  ['plain', Buffer.from('plain terminal content '.repeat(190))],
  ['sparse-leading-escape', Buffer.from(`\\033${'x'.repeat(32_768)}`)],
  ['sparse-trailing-escape', Buffer.from(`${'x'.repeat(32_768)}\\033`)],
  ['literal-backslash', Buffer.from(`C:\\Users\\workspace\\${'x'.repeat(4_096)}`)],
  ['recorded-question', escaped(readFileSync(resolve('src/lib/__fixtures__/question-single.txt')))],
  ['styled-unicode', escaped(Buffer.from('\x1b[38;5;112mHello, 世界\x1b[0m\r\n'.repeat(1_000)))],
  ['escape-heavy', Buffer.from('\\033\\012\\015\\000'.repeat(2_000))],
]
const WARMUPS = 100
const ROUNDS = 30
const DECODES = 200
const samples: Array<{ fixture: string; mode: string; round: number; wallMs: number; nodeCpuMs: number }> = []
for (const [fixture, bytes] of fixtures) {
  const reference = Buffer.from(previousDecoder(bytes))
  assert.deepEqual(Buffer.from(decodeTmuxControlBytes(bytes)), reference)
  for (let warm = 0; warm < WARMUPS; warm++) { previousDecoder(bytes); decodeTmuxControlBytes(bytes) }
  for (let round = 0; round < ROUNDS; round++) {
    for (const mode of round % 2 ? ['current', 'previous'] : ['previous', 'current']) {
      const decode = mode === 'current' ? decodeTmuxControlBytes : previousDecoder
      const cpu = process.cpuUsage()
      const started = performance.now()
      let bytesDecoded = 0
      for (let i = 0; i < DECODES; i++) bytesDecoded += decode(bytes).length
      const wallMs = performance.now() - started
      const used = process.cpuUsage(cpu)
      assert.equal(bytesDecoded, reference.length * DECODES)
      assert.deepEqual(Buffer.from(decode(bytes)), reference)
      samples.push({ fixture, mode, round, wallMs, nodeCpuMs: (used.user + used.system) / 1_000 })
    }
  }
}
const summary = fixtures.map(([fixture, bytes]) => ({
  fixture, wireBytes: bytes.length,
  ...Object.fromEntries(['previous', 'current'].map(mode => {
    const rows = samples.filter(sample => sample.fixture === fixture && sample.mode === mode)
    const elapsed = rows.map(row => row.wallMs).sort((a, b) => a - b)
    return [mode, { medianWallMs: (elapsed[14] + elapsed[15]) / 2,
      nodeCpuMs: rows.reduce((sum, row) => sum + row.nodeCpuMs, 0) }]
  })),
}))
const result = { recordedAt: new Date().toISOString(), node: process.version, platform: `${process.platform}-${process.arch}`,
  baseline: 'CLI 0.3.45 decoder, commit bb0cf693a829d2cebb4b8be285c59582a969d8df',
  scope: 'Decoder microbenchmark with recorded question paint and synthetic inputs; not whole-app CPU or energy.',
  warmups: WARMUPS, rounds: ROUNDS, decodesPerRound: DECODES, summary, samples }
if (process.argv[2]) writeFileSync(resolve(process.argv[2]), JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify({ summary }, null, 2))
