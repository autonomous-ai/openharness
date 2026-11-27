import assert from 'node:assert/strict'
import { test } from 'node:test'
import { deliver } from '../src/index.js'

const URL = 'https://hooks.example.invalid/orders'

test('delivers after a failed attempt', async () => {
  let calls = 0
  const send = async () => {
    if (++calls === 1) throw new Error('503')
  }
  assert.equal(await deliver(URL, {}, send), true)
  assert.equal(calls, 2)
})

test('gives up after three failed attempts', async () => {
  let calls = 0
  const send = async () => {
    calls++
    throw new Error('503')
  }
  assert.equal(await deliver(URL, {}, send), false)
  assert.equal(calls, 3)
})
