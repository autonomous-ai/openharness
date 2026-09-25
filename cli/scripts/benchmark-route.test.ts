import { test } from 'node:test'
import assert from 'node:assert/strict'
import { candidateSummary, verifiedRoute, verifyExchange, type RouteSnapshot } from './benchmark-route.js'

test('candidate evidence keeps type/protocol but removes addresses and ports', () => {
  assert.deepEqual(candidateSummary('candidate:1 1 UDP 123 192.0.2.1 12345 typ srflx raddr 10.0.0.1 rport 23456'), { type: 'srflx', protocol: 'udp' })
  assert.equal(candidateSummary('not a candidate'), null)
  assert.equal(candidateSummary('candidate:1 1 UDP 123 192.0.2.1 12345'), null)
  assert.equal(candidateSummary('relay 1 UDP 123 192.0.2.1 12345'), null)
})

const direct = { local: { type: 'host', protocol: 'udp' }, remote: { type: 'srflx', protocol: 'udp' } }
test('relay on either candidate means TURN; missing proof and migration are unknown', () => {
  assert.equal(verifiedRoute(true, true, false, direct), 'p2p')
  assert.equal(verifiedRoute(true, true, false, { ...direct, remote: { type: 'relay', protocol: 'udp' } }), 'turn')
  assert.equal(verifiedRoute(true, true, false, { ...direct, local: { type: 'relay', protocol: 'udp' } }), 'turn')
  assert.equal(verifiedRoute(true, true, false, null), 'unknown')
  assert.equal(verifiedRoute(true, false, false, direct), 'unknown')
  assert.equal(verifiedRoute(false, true, true, direct), 'unknown')
  assert.equal(verifiedRoute(false, false, false, null), 'relay')
})

const before: RouteSnapshot = { route: 'p2p', ready: true, migrating: false, pair: direct,
  sent: { p2p: 4, relay: 2 }, received: { p2p: 10, relay: 5 } }
const after: RouteSnapshot = { ...before, sent: { p2p: 5, relay: 2 }, received: { p2p: 11, relay: 5 } }
test('accept one direct input and its response, reject fallback, missing send, or pair change', () => {
  assert.equal(verifyExchange('p2p', before, after), true)
  assert.equal(verifyExchange('turn', before, after), false)
  assert.equal(verifyExchange('p2p', before, { ...after, sent: { p2p: 4, relay: 3 } }), false)
  assert.equal(verifyExchange('p2p', before, { ...after, received: { p2p: 11, relay: 6 } }), false)
  assert.equal(verifyExchange('p2p', before, { ...after, received: before.received }), false)
  assert.equal(verifyExchange('p2p', before, { ...after, pair: null }), false)
})

test('relay requires both wire directions and rejects a mixed route', () => {
  const relayBefore: RouteSnapshot = { ...before, route: 'relay', pair: null, ready: false }
  const relayAfter: RouteSnapshot = { ...relayBefore, sent: { p2p: 4, relay: 3 }, received: { p2p: 10, relay: 6 } }
  assert.equal(verifyExchange('relay', relayBefore, relayAfter), true)
  assert.equal(verifyExchange('relay', relayBefore, { ...relayAfter, sent: { p2p: 5, relay: 3 } }), false)
  assert.equal(verifyExchange('relay', relayBefore, { ...relayAfter, route: 'p2p' }), false)
})
