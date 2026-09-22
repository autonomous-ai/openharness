import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'
import {
  createReviewService,
  MAX_METADATA,
  MAX_PDF,
  unpackReview
} from '../lib/reviews.mjs'
import { docState } from '../lib/workspace.mjs'
import { cleanup, put, scratch } from './helpers.mjs'
import { metadata, pack, pdf } from './review-fixture.mjs'

after(cleanup)

test('a packet preserves the held PDF and readable notes after the workspace PDF changes or disappears', () => {
  const ws = scratch(),
    service = createReviewService(ws),
    value = metadata(),
    body = pack(value)
  put(
    ws,
    value.source.path,
    'a newer PDF, deliberately different from the held bytes'
  )
  const before = readFileSync(join(ws, value.source.path))
  const result = service.keep(body)
  assert.deepEqual(readFileSync(join(ws, value.source.path)), before)
  assert.deepEqual(readFileSync(service.file(result.id, 'reference.pdf')), pdf)
  const saved = JSON.parse(readFileSync(service.file(result.id, 'review.json')))
  assert.equal(saved.source.bytes, pdf.length)
  assert.deepEqual(saved.notes, value.notes)
  assert.match(
    readFileSync(service.file(result.id, 'review.md'), 'utf8'),
    /Change · page 1[\s\S]*A full workday[\s\S]*Name the brightness/
  )
  rmSync(join(ws, value.source.path))
  assert.equal(createReviewService(ws).list()[0].id, result.id)
  assert.deepEqual(readFileSync(service.file(result.id, 'reference.pdf')), pdf)
  assert.equal(
    docState(ws, '').pdf,
    null,
    'the review shelf never becomes the live PDF'
  )
})

test('the portable ZIP can be read by Python, contains exact bytes, and never includes workspace secrets', () => {
  const ws = scratch({
      '.env': 'a private value',
      'source.typ': 'editable source remains here'
    }),
    service = createReviewService(ws)
  const result = service.keep(pack())
  const inspected = JSON.parse(
    execFileSync(
      'python3',
      [
        '-c',
        'import json,sys,zipfile,hashlib\nwith zipfile.ZipFile(sys.argv[1]) as z:\n print(json.dumps({"names": sorted(z.namelist()), "pdfSha": hashlib.sha256(z.read("reference.pdf")).hexdigest(), "bad": z.testzip()}))',
        service.file(result.id, 'review.zip')
      ],
      { encoding: 'utf8' }
    )
  )
  assert.deepEqual(inspected.names, [
    'README.md',
    'reference.pdf',
    'review.json',
    'review.md'
  ])
  assert.equal(inspected.pdfSha, metadata().source.sha256)
  assert.equal(inspected.bad, null)
})

test('an identical lost-ACK retry returns one immutable packet; a different payload cannot reuse its ID', () => {
  const ws = scratch(),
    service = createReviewService(ws),
    value = metadata(),
    body = pack(value)
  const result = service.keep(body),
    saved = readFileSync(service.file(result.id, 'review.json'))
  assert.equal(service.keep(body).repeated, true)
  assert.equal(service.list().length, 1)
  value.notes[0].text = 'A later decision'
  assert.throws(() => service.keep(pack(value)), { status: 409 })
  assert.deepEqual(readFileSync(service.file(result.id, 'review.json')), saved)
  value.id = randomUUID()
  assert.equal(service.keep(pack(value)).repeated, false)
  assert.equal(service.list().length, 2)
})

test('a crash-left scratch directory cannot block a retry or appear as a kept review', () => {
  const ws = scratch(),
    service = createReviewService(ws),
    value = metadata()
  put(ws, `.harness/doc-reviews/.saving-${value.id}/reference.pdf`, 'partial')
  service.keep(pack(value))
  assert.equal(service.list().length, 1)
  assert.ok(service.file(value.id, 'review.zip'))
})

test('PDF integrity is checked before publishing anything', () => {
  const ws = scratch(),
    service = createReviewService(ws)
  const value = metadata()
  value.source.sha256 = '0'.repeat(64)
  assert.throws(() => service.keep(pack(value)), /do not match/)
  assert.throws(
    () => service.keep(pack(metadata(), Buffer.from('not a PDF'))),
    /complete PDF/
  )
  assert.equal(existsSync(join(ws, '.harness')), false)
})

test('metadata and PDF size caps reject truncated or oversized uploads', () => {
  for (const size of [0, 3, 64])
    assert.throws(() => unpackReview(Buffer.alloc(size)), /incomplete/)
  const body = pack()
  body.writeUInt32LE(MAX_METADATA + 1)
  assert.throws(() => unpackReview(body), /metadata/)
  assert.throws(
    () => unpackReview(pack(metadata(), Buffer.alloc(MAX_PDF + 1))),
    /complete PDF/
  )
})

for (const [name, mutate] of [
  [
    'absolute path',
    (v) => {
      v.source.path = '/private/report.pdf'
    }
  ],
  [
    'traversal path',
    (v) => {
      v.source.path = '../report.pdf'
    }
  ],
  [
    'invalid note page',
    (v) => {
      v.notes[0].page = 4
    }
  ],
  [
    'out-of-page rectangle',
    (v) => {
      v.notes[0].rects = [[0.8, 0, 0.4, 0.1]]
    }
  ],
  [
    'empty rectangle',
    (v) => {
      v.notes[0].rects = [[0, 0, 0, 0.1]]
    }
  ],
  [
    'duplicate note ID',
    (v) => {
      v.notes.push({ ...v.notes[0] })
    }
  ],
  [
    'oversized note',
    (v) => {
      v.notes[0].text = 'a'.repeat(2001)
    }
  ],
  [
    'empty note',
    (v) => {
      v.notes[0].text = ' '
    }
  ],
  [
    'unknown note kind',
    (v) => {
      v.notes[0].kind = 'execute'
    }
  ],
  [
    'too many notes',
    (v) => {
      v.notes = Array.from({ length: 101 }, () => ({
        ...v.notes[0],
        id: randomUUID()
      }))
    }
  ],
  [
    'too many pages',
    (v) => {
      v.source.pages = 501
    }
  ]
])
  test(`rejects ${name} without publishing a packet`, () => {
    const ws = scratch(),
      service = createReviewService(ws),
      value = metadata()
    mutate(value)
    assert.throws(() => service.keep(pack(value)), { status: 400 })
    assert.deepEqual(service.list(), [])
  })

test('review directories and files cannot be symlinks into another directory', () => {
  const outside = scratch({ 'keep.txt': 'untouched' })
  for (const target of ['.harness', '.harness/doc-reviews']) {
    const ws = scratch()
    mkdirSync(join(ws, target, '..'), { recursive: true })
    symlinkSync(outside, join(ws, target))
    assert.throws(
      () => createReviewService(ws).keep(pack()),
      /real workspace directory/
    )
    assert.deepEqual(readdirSync(outside), ['keep.txt'])
  }
  const ws = scratch(),
    service = createReviewService(ws),
    saved = service.keep(pack())
  const path = service.file(saved.id, 'reference.pdf')
  rmSync(path)
  symlinkSync(join(outside, 'keep.txt'), path)
  assert.equal(service.file(saved.id, 'reference.pdf'), null)
  const id = randomUUID()
  symlinkSync(outside, join(ws, '.harness/doc-reviews', id))
  assert.equal(service.file(id, 'review.json'), null)
  assert.equal(service.file('../outside', 'review.json'), null)
  assert.equal(service.file(saved.id, '../reference.pdf'), null)
})

test('a failed publication leaves no visible packet and preserves the authored files', () => {
  const ws = scratch({
    '.harness': 'this workspace already uses a regular file here',
    'main.typ': 'unchanged'
  })
  const service = createReviewService(ws)
  assert.throws(() => service.keep(pack()), /real workspace directory/)
  assert.equal(readFileSync(join(ws, 'main.typ'), 'utf8'), 'unchanged')
  assert.deepEqual(service.list(), [])
})

test('a malformed archived review is ignored without hiding healthy packets', () => {
  const ws = scratch(),
    service = createReviewService(ws),
    saved = service.keep(pack())
  put(ws, `.harness/doc-reviews/${randomUUID()}/review.json`, '{ broken')
  assert.equal(service.list().length, 1)
  assert.equal(service.list()[0].id, saved.id)
})

test('a write failure after the PDF is staged publishes nothing and the same request can retry', () => {
  const ws = scratch(),
    service = createReviewService(ws),
    body = pack()
  const write = fs.writeFileSync
  try {
    fs.writeFileSync = (path, ...args) => {
      if (String(path).endsWith('/review.json'))
        throw Object.assign(new Error('simulated storage failure'), {
          code: 'EIO'
        })
      return write(path, ...args)
    }
    syncBuiltinESMExports()
    assert.throws(() => service.keep(body), /storage failure/)
  } finally {
    fs.writeFileSync = write
    syncBuiltinESMExports()
  }
  assert.deepEqual(service.list(), [])
  assert.deepEqual(readdirSync(join(ws, '.harness/doc-reviews')), [])
  const saved = service.keep(body)
  assert.deepEqual(readFileSync(service.file(saved.id, 'reference.pdf')), pdf)
})
