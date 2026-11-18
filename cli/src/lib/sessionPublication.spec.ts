/** Final publication fences over private real files; child codec behavior has separate process tests. */
import { mkdtempSync, rmSync, writeFileSync, lstatSync } from 'node:fs'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as secure from './secureState.js'
import { prepareSessionPublication } from './sessionPublication.js'
import { AtomicWriteUnconfirmed, type RegistryWriteDeadline } from './registryPersistence.js'
import type { SessionImageSource, SessionStorage } from './sessionStorage.js'
import { sessionFileIdentity, type SessionDocument, type SessionImageProof, type SessionPreparedImage } from './sessionStorageWire.js'

vi.mock('node:fs', async original => ({ ...await original<object>() }))
vi.mock('./secureState.js', async original => ({ ...await original<object>() }))
let root: string, target: string, temporary: string, storage: SessionStorage, deadline: RegistryWriteDeadline
let prepare: ReturnType<typeof vi.fn>, discard: ReturnType<typeof vi.fn>
const proof = (document: SessionDocument, file: string): SessionImageProof => ({ document,
  identity: sessionFileIdentity(lstatSync(file, { bigint: true })), bytes: 2, sha256: 'a'.repeat(64) })
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'session-publication-'))
  target = join(root, 'state.json'); temporary = join(root, 'state.json.temporary')
  prepare = vi.fn(async (document: SessionDocument, _source: unknown, value: unknown) => {
    writeFileSync(temporary, '[]', { mode: 0o600 })
    return document.kind === 'registry'
      ? { temporary: 'state.json.temporary', proof: proof(document, temporary), projection: 'registry-credentials', credentials: [] }
      : { temporary: 'state.json.temporary', proof: proof(document, temporary), projection: 'value', value }
  })
  discard = vi.fn(async () => { rmSync(temporary, { force: true }) })
  storage = { root, path: () => target, prepare, discard } as unknown as SessionStorage
  deadline = { expires: Infinity, check: vi.fn(), beginPublication: vi.fn(), markPublished: vi.fn(), markAdmitted: vi.fn(), failedClose: false,
    failClosed: vi.fn(() => { throw new Error('fixture close unconfirmed') }) }
})
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }) })

it.each(['registry', 'legacy-registry', 'names', 'stopped'] as const)('settles a %s publication and exact final target once', async kind => {
  const document: SessionDocument = kind === 'stopped' ? { kind, agentId: 'fixture' } : { kind }
  const value = kind === 'registry' ? [] : null
  const published = await prepareSessionPublication(storage, document, null, value, deadline)
  expect(published.value).toEqual(value)
  expect(published.published).toBe(false)
  const renamed = vi.fn()
  published.publish(renamed)
  expect(renamed).toHaveBeenCalledOnce(); expect(deadline.markPublished).toHaveBeenCalledOnce()
  expect(published.published).toBe(true)
  expect(published.proof.identity).toBe(proof(document, target).identity)
  await published.sync(); published.finish(); await published.settle(); await published.discard()
  expect(discard).toHaveBeenCalledOnce()
})

it.each([null, [{}], [{ agentId: '', registeredAt: 1, gridLaunch: {} }], [{ agentId: 'fixture', registeredAt: Infinity, gridLaunch: {} }],
  [{ agentId: 'fixture', registeredAt: 1, gridLaunch: {} }]])('refuses malformed parent Registry input before publication (%#)', async value => {
  const invalid = value === null ? [null] : value
  // A row without a credential is valid owned metadata; give it an invalid declared credential here.
  if (invalid?.[0] && !('gridLaunch' in invalid[0])) Object.assign(invalid[0], { gridLaunch: {} })
  await expect(prepareSessionPublication(storage, { kind: 'registry' }, null, invalid, deadline)).rejects.toThrow('prepared session references changed')
  expect(discard).toHaveBeenCalledOnce()
  expect(fs.existsSync(target)).toBe(false)
})

it.each(['invalid-proof', 'extra-proof', 'foreign-document', 'wrong-projection', 'extra-value'])('rejects a %s child receipt before any rename', async fault => {
  const actual = prepare.getMockImplementation()! as (...args: any[]) => Promise<any>
  prepare.mockImplementation(async (...args) => {
    const result = await actual(...args) as any
    if (fault === 'invalid-proof') result.proof = null
    if (fault === 'extra-proof') result.proof.extra = true
    if (fault === 'foreign-document') result.proof.document = { kind: 'registry' }
    if (fault === 'wrong-projection') result.projection = 'registry-credentials'
    if (fault === 'extra-value') result.extra = true
    return result
  })
  await expect(prepareSessionPublication(storage, { kind: 'names' }, null, {}, deadline)).rejects.toThrow('prepared session references changed')
  expect(discard).toHaveBeenCalledOnce(); expect(fs.existsSync(target)).toBe(false)
})

it('requires one credential per exact parent row identity and rejects duplicate input identities', async () => {
  const row = { agentId: 'fixture', registeredAt: 1, gridLaunch: { networkId: 'fixture', networkName: 'Fixture',
    baseUrl: 'https://fixture.example.test', credential: { version: 1, binding: 'b'.repeat(64),
      row: { agentId: 'fixture', registeredAt: 1 }, source: { kind: 'import', lease: '12345678-1234-1234-1234-123456789012' } } } }
  await expect(prepareSessionPublication(storage, { kind: 'registry' }, null, [row, row], deadline)).rejects.toThrow('prepared session references changed')
  expect(discard).toHaveBeenCalledOnce()
})

it('updates only valid selected credential witnesses in a legacy image after publication', async () => {
  const credential = { version: 1 as const, binding: 'b'.repeat(64), row: { agentId: 'fixture', registeredAt: 1 },
    source: { kind: 'import' as const, lease: '12345678-1234-1234-1234-123456789012' } }
  const row = { gridLaunch: { networkId: 'fixture', networkName: 'Fixture', baseUrl: 'https://fixture.example.test', credential } }
  const document = { kind: 'legacy-registry' as const }, value = [null, false, row, {}]
  const publication = await prepareSessionPublication(storage, document, null, value, deadline)
  publication.publish(() => {})
  expect(row.gridLaunch.credential.source).toEqual({ kind: 'image', proof: publication.proof })
  publication.finish(); await publication.discard()
})

it('keeps the portable final target fences when directory fsync is unavailable', async () => {
  vi.spyOn(secure, 'directorySyncSupported').mockReturnValue(false)
  const publication = await prepareSessionPublication(storage, { kind: 'names' }, null, {}, deadline)
  publication.publish(() => {}); expect(publication.sync()).toBeUndefined()
  publication.finish(); await publication.discard()
  expect(deadline.markPublished).toHaveBeenCalledOnce()
})

it.each(['open', 'stat', 'private-mode'])('refuses failed directory %s authority before child preparation', async fault => {
  if (fault === 'open') vi.spyOn(fs, 'open').mockImplementation((...args: any[]) => args.at(-1)(new Error('fixture open refused')))
  if (fault === 'stat') vi.spyOn(fs, 'fstat').mockImplementation((...args: any[]) => args.at(-1)(new Error('fixture stat refused')))
  if (fault === 'private-mode') fs.chmodSync(root, 0o755)
  await expect(prepareSessionPublication(storage, { kind: 'names' }, null, {}, deadline)).rejects.toThrow()
  expect(prepare).not.toHaveBeenCalled(); expect(discard).not.toHaveBeenCalled()
})

it('revokes a replaced parent directory after awaited preparation', async () => {
  const moved = `${root}-moved`, actual = prepare.getMockImplementation()! as (...args: any[]) => Promise<any>
  prepare.mockImplementation(async (...args) => {
    const answer = await actual(...args)
    fs.renameSync(root, moved); fs.mkdirSync(root, { mode: 0o700 })
    return answer
  })
  try {
    await expect(prepareSessionPublication(storage, { kind: 'names' }, null, {}, deadline)).rejects.toThrow('state directory identity changed')
    expect(fs.existsSync(join(moved, 'state.json.temporary'))).toBe(true)
  } finally { rmSync(root, { recursive: true }); fs.renameSync(moved, root) }
})

it.each(['appeared', 'changed', 'missing', 'io'])('refuses %s source authority at the final fence', async kind => {
  let source: SessionImageSource | null = null
  if (kind === 'changed' || kind === 'missing') {
    writeFileSync(target, '[]', { mode: 0o600 })
    source = { image: { state: 'image', proof: proof({ kind: 'names' }, target), json: true, value: {} },
      lease: 'fixture', check: vi.fn(), release: async () => {} }
  }
  const publication = await prepareSessionPublication(storage, { kind: 'names' }, source, {}, deadline)
  if (kind === 'appeared' || kind === 'changed') writeFileSync(target, '[1]', { mode: 0o600 })
  if (kind === 'missing') rmSync(target)
  if (kind === 'io') {
    const stat = fs.lstatSync
    vi.spyOn(fs, 'lstatSync').mockImplementation(((...args: Parameters<typeof stat>) => {
      if (args[0] === target) throw Object.assign(new Error('fixture source unavailable'), { code: 'EIO' })
      return stat(...args)
    }) as typeof stat)
  }
  expect(() => publication.publish(() => {})).toThrow()
  expect(publication.published).toBe(false)
  await publication.discard()
})

it('refuses a changed prepared target before rename and an external final replacement after rename', async () => {
  const publication = await prepareSessionPublication(storage, { kind: 'names' }, null, {}, deadline)
  writeFileSync(temporary, '[1]', { mode: 0o600 })
  expect(() => publication.publish(() => {})).toThrow('prepared image changed')
  await publication.discard()
  const second = await prepareSessionPublication(storage, { kind: 'names' }, null, {}, deadline)
  second.publish(() => {})
  writeFileSync(target, '[1]', { mode: 0o600 })
  expect(() => second.finish()).toThrow(AtomicWriteUnconfirmed)
  await second.discard()
})

it('reports uncertainty when the target is displaced inside the publication callback', async () => {
  const publication = await prepareSessionPublication(storage, { kind: 'names' }, null, {}, deadline)
  expect(() => publication.publish(() => { fs.renameSync(target, `${target}.moved`); writeFileSync(target, '[]', { mode: 0o600 }) })).toThrow(AtomicWriteUnconfirmed)
  expect(publication.published).toBe(true)
  await publication.discard()
})

it('reports post-rename fsync and actual close failures without claiming settlement', async () => {
  const publication = await prepareSessionPublication(storage, { kind: 'names' }, null, {}, deadline)
  publication.publish(() => {})
  vi.spyOn(fs, 'fsync').mockImplementation((_fd, callback) => callback(Object.assign(new Error('fixture sync failure'), { code: 'ENOSPC' })))
  await expect(publication.sync()).rejects.toBeInstanceOf(AtomicWriteUnconfirmed)
  const close = fs.closeSync
  vi.spyOn(fs, 'closeSync').mockImplementation(fd => { close(fd); throw new Error('fixture ambiguous close') })
  expect(() => publication.finish()).toThrow('fixture close unconfirmed')
  expect(deadline.failClosed).toHaveBeenCalledOnce()
  await publication.discard()
})

it('preserves credential-free owned Registry rows without manufacturing references', async () => {
  const rows = [{ agentId: 'fixture', registeredAt: 1 }, { agentId: 'other', registeredAt: 2, gridLaunch: null }]
  const publication = await prepareSessionPublication(storage, { kind: 'registry' }, null, rows, deadline)
  expect(publication.value).toEqual(rows)
  publication.publish(() => {}); publication.finish(); await publication.discard()
})

it('publishes a stopped session projection with its selected row shape intact', async () => {
  const value = { session: { agentId: 'fixture', registeredAt: 1 } }
  const publication = await prepareSessionPublication(storage, { kind: 'stopped', agentId: 'fixture' }, null, value, deadline)
  expect(publication.value).toBe(value)
  publication.publish(() => {}); publication.finish(); await publication.discard()
})
