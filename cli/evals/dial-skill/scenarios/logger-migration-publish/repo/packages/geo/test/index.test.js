import assert from 'node:assert/strict'
import { test } from 'node:test'
import { distanceKm } from '../src/index.js'

test('measures a quarter of the equator', () => {
  assert.equal(Math.round(distanceKm({ lat: 0, lon: 0 }, { lat: 0, lon: 90 })), 10008)
})

test('refuses a latitude past a pole', () => {
  assert.ok(Number.isNaN(distanceKm({ lat: 91, lon: 0 }, { lat: 0, lon: 0 })))
})
