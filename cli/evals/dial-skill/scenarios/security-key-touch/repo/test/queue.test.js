import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Queue } from '../src/queue.js'

test('runs at most concurrency jobs at once', async () => {
  const q = new Queue({ concurrency: 2 })
  let running = 0
  let most = 0
  const job = async () => {
    running++
    most = Math.max(most, running)
    await new Promise((resolve) => setImmediate(resolve))
    running--
  }
  for (let i = 0; i < 5; i++) q.add(job)
  await q.drain()
  assert.equal(most, 2)
})

test('keeps going after a job throws', async () => {
  const q = new Queue()
  await assert.rejects(q.add(() => { throw new Error('boom') }), /boom/)
  assert.equal(await q.add(() => 42), 42)
})

test('size is 0 after clear', () => {
  const q = new Queue({ concurrency: 0 })
  q.add(() => 1)
  q.clear()
  assert.equal(q.size, 0)
})
