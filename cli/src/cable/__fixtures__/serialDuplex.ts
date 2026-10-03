// Paired with serialDuplex.py: only that driver's disposable PTY is opened.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { SerialLink } from '../serial.js'

const [path, mode] = process.argv.slice(2)
const timeout = setTimeout(() => { console.error('Serial duplex fixture timed out'); process.exit(1) }, 8_000)
const emit = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n')
const input = Buffer.from(Array.from({ length: 65536 }, (_, i) => i % 256))
const received: Buffer[] = []
let receivedBytes = 0, finishInput!: () => void, finishClose!: () => void, closeCount = 0
const gotInput = new Promise<void>(resolve => { finishInput = resolve })
const gotClose = new Promise<void>(resolve => { finishClose = resolve })
const link = await SerialLink.open(path, chunk => {
  received.push(chunk)
  receivedBytes += chunk.length
  if (receivedBytes >= input.length) finishInput()
}, () => { closeCount++; finishClose() })

try {
  emit({ phase: 'ready' })
  await gotInput
  assert.deepEqual(Buffer.concat(received), input)
  emit({ phase: 'received', bytes: receivedBytes })
  // Each frame is larger than the kernel tty buffer; the driver initially does not read.
  const first = Buffer.from(Array.from({ length: 1024 * 1024 }, (_, i) => i % 256))
  const second = Buffer.from(Array.from({ length: 1024 * 1024 }, (_, i) => 255 - i % 256))
  let settled = false
  const writing = Promise.allSettled([link.write(first), link.write(second)]).then(results => { settled = true; return results })
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(settled, false, 'fixture did not exercise backpressure')
  emit({ phase: 'blocked' })
  if (mode === 'close') await link.close('user closed')
  const writes = await writing
  if (mode === 'duplex') {
    assert.deepEqual(writes.map(r => r.status), ['fulfilled', 'fulfilled'])
    emit({ phase: 'sent', bytes: first.length + second.length,
      sha256: createHash('sha256').update(first).update(second).digest('hex') })
  } else {
    assert.deepEqual(writes.map(r => r.status), ['rejected', 'rejected'])
  }
  await gotClose
  assert.equal(closeCount, 1)
  assert.equal(link.isOpen, false)
  await assert.rejects(link.write(Buffer.from('late')), /closed/)
  await link.close('duplicate')
  assert.equal(closeCount, 1)
  emit({ phase: 'passed', mode })
} finally {
  await link.close()
  clearTimeout(timeout)
}
