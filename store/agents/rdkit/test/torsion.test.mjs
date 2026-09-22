import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createTorsionService } from '../torsion.mjs'

const scratch = mkdtempSync(join(tmpdir(), 'rdkit-torsion-'))
after(() => rmSync(scratch, { recursive: true, force: true }))
const workspace = () => mkdtempSync(join(scratch, 'workspace-'))
const input = {
  molblock: 'native MOL block',
  name: 'example',
  atoms: [0, 1, 2, 3],
  step: 15,
  fingerprint: 'native fingerprint',
  title: 'A chosen shape',
  selected: 1,
  note: 'Rotate the other bond next.'
}
const study = {
  spec: 'rdkit-torsion/1',
  title: input.title,
  record: { name: input.name },
  frames: [{ angle: -180 }, { angle: -165 }],
  selectedIndex: 1
}
function nativeFiles(request) {
  writeFileSync(join(request.destination, 'study.json'), JSON.stringify(study))
  writeFileSync(
    join(request.destination, 'study.zip'),
    'archive from native worker'
  )
}

test('keep chooses an isolated destination, exposes it only after native completion and preserves source', async () => {
  const root = workspace()
  mkdirSync(join(root, 'out'))
  writeFileSync(join(root, 'out/source.sdf'), 'original')
  let release, request
  const service = createTorsionService({
    workspace: root,
    ask: async (op, payload) => {
      assert.equal(op, 'torsion_keep')
      request = payload
      await new Promise((resolve) => {
        release = resolve
      })
      nativeFiles(payload)
    }
  })
  const keeping = service.calculate('keep', {
    ...input,
    destination: '/untrusted/destination',
    frames: ['browser invention']
  })
  assert.deepEqual(service.list(), [])
  assert.ok(
    request.destination.startsWith(
      join(realpathSync(root), 'out/torsions/.saving-')
    )
  )
  assert.equal(
    request.frames,
    undefined,
    'browser energies never enter native calculation'
  )
  await assert.rejects(service.calculate('scan', input), /already running/)
  release()
  const result = await keeping
  assert.match(result.id, /^[a-f0-9-]{36}$/)
  assert.equal(
    readFileSync(join(root, result.path, 'study.zip'), 'utf8'),
    'archive from native worker'
  )
  assert.equal(readFileSync(join(root, 'out/source.sdf'), 'utf8'), 'original')
  assert.deepEqual(
    service.list().map(({ id, title, angle }) => ({ id, title, angle })),
    [{ id: result.id, title: input.title, angle: -165 }]
  )
  assert.deepEqual(readdirSync(join(root, 'out/torsions')), [result.id])
})

test('failed or incomplete native saves leave no published study and the next request can succeed', async () => {
  for (const failure of ['throw', 'incomplete']) {
    const root = workspace()
    let attempt = 0
    const service = createTorsionService({
      workspace: root,
      ask: async (_op, request) => {
        attempt++
        if (attempt === 1) {
          writeFileSync(join(request.destination, 'partial'), 'partial')
          if (failure === 'throw') throw new Error('Native calculation failed')
          return
        }
        nativeFiles(request)
      }
    })
    await assert.rejects(service.calculate('keep', input))
    assert.deepEqual(service.list(), [])
    assert.deepEqual(readdirSync(join(root, 'out/torsions')), [])
    await service.calculate('keep', input)
    assert.equal(service.list().length, 1)
  }
})

test('an escaping output symlink cannot be used for writes or the library', async () => {
  for (const at of ['out', 'torsions']) {
    const root = workspace(),
      outside = workspace()
    let asked = false
    if (at === 'torsions') mkdirSync(join(root, 'out'))
    symlinkSync(outside, join(root, at === 'out' ? 'out' : 'out/torsions'))
    const service = createTorsionService({
      workspace: root,
      ask: async () => {
        asked = true
      }
    })
    await assert.rejects(
      service.calculate('keep', input),
      /real workspace directory/
    )
    assert.equal(asked, false)
    assert.deepEqual(service.list(), [])
    assert.deepEqual(readdirSync(outside), [])
  }
})

test('the library ignores partial, malformed and linked studies', () => {
  const root = workspace(),
    shelf = join(root, 'out/torsions'),
    outside = workspace()
  mkdirSync(shelf, { recursive: true })
  for (const [id, contents] of [
    ['.saving-partial', JSON.stringify(study)],
    ['a'.repeat(36), '{invalid'],
    ['b'.repeat(36), '{}']
  ]) {
    mkdirSync(join(shelf, id))
    writeFileSync(join(shelf, id, 'study.json'), contents)
  }
  writeFileSync(join(outside, 'study.json'), JSON.stringify(study))
  symlinkSync(outside, join(shelf, 'c'.repeat(36)))
  mkdirSync(join(shelf, 'd'.repeat(36)))
  symlinkSync(
    join(outside, 'study.json'),
    join(shelf, 'd'.repeat(36), 'study.json')
  )
  const service = createTorsionService({
    workspace: root,
    ask: async () => {}
  })
  assert.deepEqual(service.list(), [])
})

test('bounded invalid requests fail before calling native code', async () => {
  let calls = 0
  const service = createTorsionService({
    workspace: workspace(),
    ask: async () => {
      calls++
    }
  })
  for (const value of [
    null,
    {},
    { ...input, molblock: 'x'.repeat(131073) },
    { ...input, atoms: [0, 1, 2] },
    { ...input, atoms: [0, 1, 2, 0.5] },
    { ...input, name: 'x'.repeat(101) },
    { ...input, title: 'x'.repeat(101) },
    { ...input, note: 'x'.repeat(1001) },
    { ...input, selected: '1' }
  ]) {
    await assert.rejects(
      service.calculate('keep', value),
      (error) => error.code === 400
    )
  }
  await assert.rejects(
    service.calculate('overwrite', input),
    (error) => error.code === 404
  )
  assert.equal(calls, 0)
})
