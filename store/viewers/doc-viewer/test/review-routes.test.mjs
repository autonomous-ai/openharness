import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { MAX_UPLOAD } from '../lib/reviews.mjs'
import { cleanup, raw, scratch, socket, startViewer } from './helpers.mjs'
import { metadata, pack, pdf } from './review-fixture.mjs'

let viewer, token
before(async () => {
  viewer = await startViewer(scratch(), { DOC_VIEWER_OPEN: 'off' })
  const html = await (await fetch(viewer.base)).text()
  token = /name="review-token" content="([a-f0-9]{64})"/.exec(html)?.[1]
  assert.ok(token)
})
after(async () => {
  await viewer?.stop()
  cleanup()
})
const headers = () => ({
  'x-doc-viewer': '1',
  'x-review-token': token,
  'content-type': 'application/octet-stream'
})

test('keeping a review needs the page token, loopback Host, and same Origin', async () => {
  for (const bad of [
    {},
    { 'x-doc-viewer': '1' },
    { ...headers(), 'x-review-token': 'expired' },
    { ...headers(), host: 'elsewhere.test' },
    { ...headers(), origin: 'https://elsewhere.test' }
  ]) {
    assert.equal(
      (
        await raw(viewer.port, {
          path: '/api/reviews',
          method: 'POST',
          headers: bad,
          body: pack()
        })
      ).status,
      403
    )
  }
  assert.deepEqual(await (await fetch(viewer.base + '/api/reviews')).json(), [])
})

test('the HTTP packet preserves the exact uploaded PDF and exports a complete ZIP', async () => {
  const value = metadata(),
    body = pack(value)
  const response = await fetch(viewer.base + '/api/reviews', {
    method: 'POST',
    headers: { ...headers(), origin: viewer.base },
    body
  })
  assert.equal(response.status, 200)
  const saved = await response.json()
  const bytes = await (
    await fetch(`${viewer.base}/api/reviews/${saved.id}/reference.pdf`)
  ).arrayBuffer()
  assert.deepEqual(Buffer.from(bytes), pdf)
  const zip = await fetch(
    `${viewer.base}/api/reviews/${saved.id}/review.zip?download=1`
  )
  assert.equal(zip.headers.get('content-type'), 'application/zip')
  assert.match(zip.headers.get('content-disposition'), /attachment/)
  assert.ok((await zip.arrayBuffer()).byteLength > pdf.length)
  const retry = await (
    await fetch(viewer.base + '/api/reviews', {
      method: 'POST',
      headers: headers(),
      body
    })
  ).json()
  assert.equal(retry.repeated, true)
  const head = await raw(viewer.port, {
    path: `/api/reviews/${saved.id}/review.json`,
    method: 'HEAD'
  })
  assert.equal(head.status, 200)
  assert.equal(head.text, '')
  assert.equal((await fetch(viewer.base + '/api/reviews')).status, 200)
})

test('declared oversized uploads are rejected before their body is sent', async () => {
  const line = await socket(
    viewer.port,
    `POST /api/reviews HTTP/1.1\r\nHost: 127.0.0.1:${viewer.port}\r\nx-doc-viewer: 1\r\nx-review-token: ${token}\r\nContent-Length: ${MAX_UPLOAD + 1}\r\nConnection: close\r\n\r\n`
  )
  assert.equal(line, 'HTTP/1.1 413 Payload Too Large')
})

test('malformed packets and unrecognized archive paths do not take down the reader', async () => {
  assert.equal(
    (
      await raw(viewer.port, {
        path: '/api/reviews',
        method: 'POST',
        headers: headers(),
        body: 'broken'
      })
    ).status,
    400
  )
  for (const path of [
    '/api/reviews/../viewer.mjs',
    '/api/reviews/..%2F..%2Foutside/reference.pdf',
    '/api/reviews/nope/review.json'
  ]) {
    assert.equal((await raw(viewer.port, { path })).status, 404)
  }
  assert.equal((await fetch(viewer.base + '/api/state')).status, 200)
  assert.equal(viewer.alive(), true)
})

test('chunked and interrupted uploads cannot publish an incomplete review', async () => {
  const before = await (await fetch(viewer.base + '/api/reviews')).json()
  const large = await raw(viewer.port, {
    path: '/api/reviews',
    method: 'POST',
    headers: { ...headers(), 'transfer-encoding': 'chunked' },
    body: Buffer.alloc(MAX_UPLOAD + 1)
  })
  assert.equal(large.status, 413)
  await socket(
    viewer.port,
    `POST /api/reviews HTTP/1.1\r\nHost: 127.0.0.1:${viewer.port}\r\nx-doc-viewer: 1\r\nx-review-token: ${token}\r\nContent-Length: 9999\r\n\r\npartial`,
    { holdMs: 40 }
  )
  assert.deepEqual(
    await (await fetch(viewer.base + '/api/reviews')).json(),
    before
  )
  assert.equal(viewer.alive(), true)
})
