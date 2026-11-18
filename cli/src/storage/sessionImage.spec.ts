import { createHash, randomUUID } from 'node:crypto'
import { constants, fstatSync, lstatSync, mkdtempSync, openSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSessionImageCodec, sessionImageIdentity } from './sessionImage.js'
import type { StoredGridLaunch } from '../lib/sessionStorageWire.js'

let root: string
let key: string
const override = () => ({ networkId: 'fixture', networkName: 'Fixture', baseUrl: 'https://grid.example.test/v1', apiKey: key })
const row = () => ({ agentId: 'fixture-agent', registeredAt: 1, title: 'fixture', gridLaunch: override() })
const containsKey = (value: unknown) => JSON.stringify(value).includes(key)
const reservation = () => {
  const temporary = `registry.json.${process.pid}.${randomUUID()}.tmp`
  writeFileSync(join(root, temporary), '', { mode: 0o600, flag: 'wx' })
  return { temporary, identity: sessionImageIdentity(lstatSync(join(root, temporary), { bigint: true })) }
}
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'session-image-')); key = randomUUID() })
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('private session image projection', () => {
  it('returns only prepared Registry credential references while preserving exact legacy metadata and key bytes', async () => {
    const saved = { ...row(), title: 'large metadata '.repeat(1024), launchArgs: ['--fixture'], extra: { nested: ['owned'] } }
    writeFileSync(join(root, 'registry.json'), JSON.stringify([saved]), { mode: 0o600 })
    const codec = createSessionImageCodec(root), image = await codec.read({ kind: 'registry' })
    if (image.state !== 'image' || !image.json) throw new Error('fixture image was not readable')
    const prepared = await codec.prepare({ kind: 'registry' }, image.proof, image.value, reservation())
    try {
      const actual = JSON.parse(readFileSync(join(root, prepared.temporary), 'utf8'))
      expect(actual[0].title).toBe(saved.title)
      expect(actual[0].extra).toEqual(saved.extra)
      expect(actual[0].launchArgs).toEqual(saved.launchArgs)
      expect(actual[0].gridLaunch.apiKey === key).toBe(true)
      expect(containsKey(prepared)).toBe(false)
      expect(Object.hasOwn(prepared, 'value')).toBe(false)
      expect(prepared).toMatchObject({ projection: 'registry-credentials', credentials: [
        { row: { agentId: saved.agentId, registeredAt: 1 }, source: { kind: 'image', proof: prepared.proof } },
      ] })
    } finally { unlinkSync(join(root, prepared.temporary)); await codec.discard(prepared.temporary, prepared.proof.identity) }
  })

  it('omits keys before bytes or parsed rows can cross the child boundary', async () => {
    writeFileSync(join(root, 'registry.json'), JSON.stringify([row()]), { mode: 0o600 })
    const codec = createSessionImageCodec(root)
    const image = await codec.read({ kind: 'registry' })
    expect(image.state === 'image' && image.json).toBe(true)
    expect(containsKey(image)).toBe(false)
    expect(containsKey(readFileSync(join(root, 'registry.json'), 'utf8'))).toBe(true)
  })

  it('keeps raw legacy backup projection independent of its placeholder input', async () => {
    const saved = { ...row(), legacyField: { untouched: true } }
    writeFileSync(join(root, 'registry.json'), JSON.stringify([saved]), { mode: 0o600 })
    const codec = createSessionImageCodec(root), image = await codec.read({ kind: 'registry' })
    if (image.state !== 'image' || !image.json) throw new Error('fixture image was not readable')
    const temporary = `registry.pre-v2.json.${process.pid}.${randomUUID()}.tmp`
    writeFileSync(join(root, temporary), '', { mode: 0o600, flag: 'wx' })
    const prepared = await codec.prepare({ kind: 'legacy-registry' }, null, [],
      { temporary, identity: sessionImageIdentity(lstatSync(join(root, temporary), { bigint: true })) }, image.proof)
    try {
      expect(prepared.projection).toBe('value')
      expect(prepared.projection === 'value' && Array.isArray(prepared.value) && prepared.value.length === 1).toBe(true)
      expect(JSON.parse(readFileSync(join(root, temporary), 'utf8'))[0].gridLaunch.apiKey === key).toBe(true)
      expect(containsKey(prepared)).toBe(false)
    } finally { unlinkSync(join(root, temporary)); await codec.discard(temporary, prepared.proof.identity) }
  })

  it('reconstructs the selected key in the sole old-readable prepared image', async () => {
    writeFileSync(join(root, 'registry.json'), JSON.stringify([row()]), { mode: 0o600 })
    const codec = createSessionImageCodec(root)
    const image = await codec.read({ kind: 'registry' })
    if (image.state !== 'image' || !image.json) throw new Error('fixture image was not readable')
    const value = structuredClone(image.value) as Record<string, unknown>[]
    value[0].title = 'changed'
    const prepared = await codec.prepare({ kind: 'registry' }, image.proof, value, reservation())
    expect(containsKey(prepared)).toBe(false)
    const oldReadable = JSON.parse(readFileSync(join(root, prepared.temporary), 'utf8'))
    expect(oldReadable[0].title).toBe('changed')
    expect(oldReadable[0].gridLaunch.apiKey === key).toBe(true)
    unlinkSync(join(root, prepared.temporary))
    await codec.discard(prepared.temporary, prepared.proof.identity)
  })

  it('refuses changed source bytes without printing or substituting a credential', async () => {
    writeFileSync(join(root, 'registry.json'), JSON.stringify([row()]), { mode: 0o600 })
    const codec = createSessionImageCodec(root)
    const image = await codec.read({ kind: 'registry' })
    if (image.state !== 'image' || !image.json) throw new Error('fixture image was not readable')
    writeFileSync(join(root, 'registry.json'), JSON.stringify([{ ...row(), title: 'peer' }]), { mode: 0o600 })
    await expect(codec.prepare({ kind: 'registry' }, image.proof, image.value, reservation())).rejects.toMatchObject({ code: 'changed' })
  })

  it('uses current-image equality only for preparation, while selected launch resolution requires its exact witness', async () => {
    writeFileSync(join(root, 'registry.json'), JSON.stringify([row()]), { mode: 0o600 })
    const codec = createSessionImageCodec(root)
    const prior = await codec.read({ kind: 'registry' })
    if (prior.state !== 'image' || !prior.json) throw new Error('fixture image was not readable')
    writeFileSync(join(root, 'registry.json'), JSON.stringify([{ ...row(), title: 'peer' }]), { mode: 0o600 })
    const current = await codec.read({ kind: 'registry' })
    if (current.state !== 'image' || !current.json) throw new Error('fixture image was not readable')
    const selected = (prior.value as Array<{ gridLaunch: StoredGridLaunch }>)[0].gridLaunch
    await expect(codec.resolve(selected)).rejects.toMatchObject({ code: 'changed' })
    const prepared = await codec.prepare({ kind: 'registry' }, current.proof, prior.value, reservation())
    expect(readFileSync(join(root, prepared.temporary), 'utf8').includes(key)).toBe(true)
    unlinkSync(join(root, prepared.temporary))
    await codec.discard(prepared.temporary, prepared.proof.identity)
  })

  it('proves original bytes even when the legacy UTF-8 decoder replaces an invalid byte', async () => {
    const bytes = Buffer.concat([Buffer.from('[{"title":"'), Buffer.from([0xff]), Buffer.from('"}]')])
    writeFileSync(join(root, 'registry.json'), bytes, { mode: 0o600 })
    const image = await createSessionImageCodec(root).read({ kind: 'registry' })
    if (image.state !== 'image') throw new Error('fixture image was not readable')
    expect(image.proof.bytes).toBe(bytes.length)
    expect(image.proof.sha256 === createHash('sha256').update(bytes).digest('hex')).toBe(true)
  })

  it('actually closes a replacement child inherited descriptor when its prior image is released', async () => {
    const file = join(root, 'registry.json')
    writeFileSync(file, JSON.stringify([row()]), { mode: 0o600 })
    const image = await createSessionImageCodec(root).read({ kind: 'registry' })
    if (image.state !== 'image' || !image.json) throw new Error('fixture image was not readable')
    const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)), lease = randomUUID()
    const replacement = createSessionImageCodec(root, [{ fd, proof: image.proof, lease }])
    unlinkSync(file)
    const selected = (image.value as Array<{ gridLaunch: StoredGridLaunch }>)[0].gridLaunch
    expect((await replacement.resolve(selected)).apiKey === key).toBe(true)
    replacement.release(lease)
    expect(() => fstatSync(fd)).toThrow(expect.objectContaining({ code: 'EBADF' }))
  })
})
