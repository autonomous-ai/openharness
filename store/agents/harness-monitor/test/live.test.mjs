import assert from 'node:assert/strict'
import { test } from 'node:test'
import { hostHidden, liveConnection } from '../viewer/live.js'

/** A stand-in for the page's EventSource: counts what was opened and closed. */
function streams() {
  const opened = []
  return { opened, open: () => { const stream = { closed: false, close() { this.closed = true } }; opened.push(stream); return stream } }
}

test('a page nobody can see, or one that is frozen, holds no connection; showing it again opens exactly one', () => {
  const fake = streams()
  let paused = false
  const live = liveConnection({ open: fake.open, paused: () => paused })

  live.sync(); live.sync()
  assert.equal(fake.opened.length, 1, 'a visible page opens one connection, however often it checks')
  assert.equal(live.open, true)

  paused = true
  live.sync()
  assert.equal(fake.opened[0].closed, true, 'hidden or frozen: the connection is closed, so the server stops reading')
  assert.equal(live.open, false)
  live.sync()
  assert.equal(fake.opened.length, 1, 'and nothing is opened while it stays that way')

  paused = false
  live.sync()
  assert.equal(fake.opened.length, 2, 'shown or unfrozen again: one new connection, which brings the current readings')
  assert.equal(fake.opened[1].closed, false)
})

test('Harness says when its tab is out of sight by marking the page', () => {
  assert.equal(hostHidden({ dataset: { hostVisible: 'false' } }), true)
  assert.equal(hostHidden({ dataset: { hostVisible: 'true' } }), false)
  assert.equal(hostHidden({ dataset: {} }), false, 'a page opened outside Harness, or by an older Harness, is visible')
})
