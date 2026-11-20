import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createStoppedList } from './stoppedList.js'
import { createSessionImageCodec } from './sessionImage.js'
import { SessionStorageUnavailable, type SessionDocument, type SessionImage } from '../lib/sessionStorageWire.js'

vi.mock('node:fs', async original => ({ ...await original<object>() }))

let root: string, directory: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stopped-list-'))
  directory = join(root, 'stopped-agents')
  mkdirSync(directory, { mode: 0o700 })
})
afterEach(() => { rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks() })
const deadline = () => performance.now() + 5000
const write = (id: string, extra: object = {}) => writeFileSync(join(directory, `${id}.json`),
  JSON.stringify({ version: 1, session: { agentId: id, registeredAt: 1, ...extra } }), { mode: 0o600 })
const fixture = () => {
  const codec = createSessionImageCodec(root)
  const read = vi.fn((document: SessionDocument) => codec.read(document))
  return { codec, read, listing: createStoppedList(directory, work => codec.readStoppedPage(async reader => {
    read.mockImplementation(reader)
    return work(read)
  })) }
}
const ids = (images: SessionImage[]) => images.map(image => image.state === 'image' && image.proof.document.kind === 'stopped' ? image.proof.document.agentId : '')

describe('display catalog page purpose', () => {
  it('refuses an unavailable catalog and binds a shared cursor to its original read purpose', async () => {
    for (let index = 0; index < 65; index++) write(`row-${index}`)
    const { listing: fresh } = fixture()
    await expect(fresh.page(null, deadline(), true)).rejects.toMatchObject({ code: 'invalid' })
    const codec = createSessionImageCodec(root)
    const listing = createStoppedList(directory, codec.readStoppedPage, codec.readStoppedCatalogPage)
    const first = await listing.page(null, deadline(), true)
    await expect(listing.page(first.cursor, deadline())).rejects.toMatchObject({ code: 'changed' })
    await expect(listing.page(null, deadline())).rejects.toMatchObject({ code: 'busy' })
    const last = await listing.page(first.cursor, deadline(), true)
    expect(new Set(ids([...first.images, ...last.images])).size).toBe(65)
    const selected = await listing.page(null, deadline())
    await expect(listing.page(selected.cursor, deadline(), true)).rejects.toMatchObject({ code: 'changed' })
    listing.close(selected.cursor)
    expect((await listing.page(null, deadline(), true)).images).toHaveLength(64)
  })

  it('keeps supported lookahead rows visible and observes mutation or removal on the next catalog', async () => {
    write('a', { title: 'a'.repeat(180_000) }); write('b', { title: 'b'.repeat(300_000) }); write('c')
    const codec = createSessionImageCodec(root)
    const listing = createStoppedList(directory, codec.readStoppedPage, codec.readStoppedCatalogPage)
    const first = await listing.page(null, deadline(), true)
    expect(first).toMatchObject({ next: 1, total: 3, done: false })
    const second = await listing.page(first.cursor, deadline(), true)
    expect(second).toMatchObject({ offset: 1, next: 2, done: false })
    expect(ids(second.images)).toEqual(['b'])
    rmSync(join(directory, 'c.json'))
    expect(await listing.page(first.cursor, deadline(), true)).toMatchObject({ next: 3, done: true, images: [] })
    write('a', { title: 'Changed display' })
    const changed = await listing.page(null, deadline(), true)
    expect(changed.images[0]).toMatchObject({ value: { session: { title: 'Changed display' } } })
    listing.close(changed.cursor)
  })

  it.skipIf(process.platform === 'win32')('fails the whole warmed catalog if a caught directory refusal is restored during a page', async () => {
    write('a'); write('b')
    const codec = createSessionImageCodec(root)
    let sabotage = false
    const listing = createStoppedList(directory, codec.readStoppedPage, work => codec.readStoppedCatalogPage(read => work(async document => {
      if (!sabotage) return read(document)
      sabotage = false
      chmodSync(directory, 0o777)
      try { return await read(document) } finally { chmodSync(directory, 0o700) }
    })))
    expect((await listing.page(null, deadline(), true)).images).toHaveLength(2)
    sabotage = true
    await expect(listing.page(null, deadline(), true)).rejects.toMatchObject({ code: 'unsafe' })
    expect((await listing.page(null, deadline(), true)).images).toHaveLength(2)
  })
})

describe('child-owned stopped list pages', () => {
  it.skipIf(process.platform === 'win32')('reuses directory opens within a page while reading every exact image', async () => {
    for (let index = 0; index < 64; index++) write(`row-${index}`)
    const open = vi.spyOn(fs, 'openSync'), { listing } = fixture()
    const page = await listing.page(null, deadline())
    expect(page).toMatchObject({ done: true, next: 64, total: 64 })
    expect(new Set(ids(page.images)).size).toBe(64)
    for (const image of page.images) {
      expect(image.state).toBe('image')
      if (image.state !== 'image') throw new Error('fixture image was missing')
      expect(image.proof.sha256).toMatch(/^[a-f0-9]{64}$/)
      expect(image.json).toBe(true)
    }
    expect(open.mock.calls.filter(([file]) => file === directory)).toHaveLength(1)
  })

  it('considers at most64 names and completes every row without retaining a whole projection', async () => {
    for (let index = 0; index < 129; index++) write(`row-${String(index).padStart(3, '0')}`)
    const { read, listing } = fixture()
    const first = await listing.page(null, deadline())
    expect(first).toMatchObject({ offset: 0, next: 64, total: 129, done: false })
    expect(read).toHaveBeenCalledTimes(64)
    const second = await listing.page(first.cursor, deadline())
    expect(second).toMatchObject({ offset: 64, next: 128, total: 129, done: false })
    const last = await listing.page(first.cursor, deadline())
    expect(last).toMatchObject({ offset: 128, next: 129, total: 129, done: true })
    expect(new Set(ids([...first.images, ...second.images, ...last.images])).size).toBe(129)
    await expect(listing.page(first.cursor, deadline())).rejects.toMatchObject({ code: 'changed' })
    expect((await listing.page(null, deadline())).offset).toBe(0)
    listing.close(first.cursor)
    await expect(listing.page(null, deadline())).rejects.toMatchObject({ code: 'busy' })
  })

  it('keeps a projected lookahead unsettled until delivery, including a supported oversized single row', async () => {
    write('a', { title: 'a'.repeat(180_000) }); write('b', { title: 'b'.repeat(300_000) }); write('c')
    const { read, listing } = fixture()
    const first = await listing.page(null, deadline())
    expect(first).toMatchObject({ next: 1, total: 3, done: false })
    expect(ids(first.images)).toEqual(['a'])
    expect(read).toHaveBeenCalledTimes(2)
    const second = await listing.page(first.cursor, deadline())
    expect(second).toMatchObject({ offset: 1, next: 2, done: false })
    expect(ids(second.images)).toEqual(['b'])
    expect(read).toHaveBeenCalledTimes(2)
    const third = await listing.page(first.cursor, deadline())
    expect(third).toMatchObject({ offset: 2, next: 3, done: true })
    expect(ids(third.images)).toEqual(['c'])
  })

  it('skips individually damaged files while preserving name progress and cleanup failure identity', async () => {
    for (const id of ['a', 'b', 'c', 'd', 'e']) write(id)
    writeFileSync(join(directory, 'invalid name.json'), '{}', { mode: 0o600 })
    const { read, listing } = fixture()
    read.mockRejectedValueOnce(new SessionStorageUnavailable('unsafe'))
      .mockRejectedValueOnce(new SessionStorageUnavailable('invalid'))
      .mockRejectedValueOnce(new SessionStorageUnavailable('changed'))
      .mockRejectedValueOnce(new SessionStorageUnavailable('missing'))
    const page = await listing.page(null, deadline())
    expect(page).toMatchObject({ next: 6, total: 6, done: true })
    expect(ids(page.images)).toEqual(['e'])
    read.mockRejectedValueOnce(new SessionStorageUnavailable('cleanup-unconfirmed'))
    await expect(listing.page(null, deadline())).rejects.toMatchObject({ code: 'cleanup-unconfirmed' })
  })

  it('snapshots names once while writes interleave, and skips a name removed before its read', async () => {
    for (let index = 0; index < 65; index++) write(`row-${String(index).padStart(3, '0')}`)
    const { listing } = fixture()
    const first = await listing.page(null, deadline())
    rmSync(join(directory, 'row-064.json')); write('added-later')
    write('row-000', { title: 'New owner metadata' })
    const last = await listing.page(first.cursor, deadline())
    expect(last).toMatchObject({ offset: 64, next: 65, total: 65, done: true, images: [] })
    const fresh = await listing.page(null, deadline())
    expect(ids(fresh.images)).toContain('added-later')
    expect(JSON.stringify(fresh.images).includes('New owner metadata')).toBe(true)
    expect(JSON.stringify(first.images).includes('New owner metadata')).toBe(false)
    listing.close(fresh.cursor)
  })

  it('does not create a missing container and reads replacement rows with fresh proofs', async () => {
    rmSync(directory, { recursive: true })
    const { listing } = fixture()
    expect(await listing.page(null, deadline())).toEqual({ cursor: '', offset: 0, next: 0, total: 0, images: [], done: true })
    mkdirSync(directory, { mode: 0o700 })
    for (let index = 0; index < 65; index++) write(`row-${String(index).padStart(3, '0')}`)
    const first = await listing.page(null, deadline())
    renameSync(directory, `${directory}-old`)
    mkdirSync(directory, { mode: 0o700 }); write('row-064', { title: 'Replacement image' })
    const last = await listing.page(first.cursor, deadline())
    expect(last).toMatchObject({ done: true, next: 65 })
    expect(JSON.stringify(last.images).includes('Replacement image')).toBe(true)
    if (process.platform !== 'win32') {
      chmodSync(directory, 0o777)
      await expect(listing.page(null, deadline())).rejects.toThrow()
    }
  })

  it('rejects expired pages and foreign tokens, and closes only the exact cursor', async () => {
    for (let index = 0; index < 65; index++) write(`row-${index}`)
    const { listing } = fixture()
    await expect(listing.page(null, performance.now() - 1)).rejects.toMatchObject({ code: 'expired' })
    await expect(listing.page('invalid', deadline())).rejects.toMatchObject({ code: 'invalid' })
    const first = await listing.page(null, deadline())
    expect(() => listing.close('invalid')).toThrow()
    listing.close(randomUUID())
    await expect(listing.page(null, deadline())).rejects.toMatchObject({ code: 'busy' })
    await expect(listing.page(randomUUID(), deadline())).rejects.toMatchObject({ code: 'changed' })
    listing.close(first.cursor); listing.close(first.cursor)
    expect((await listing.page(null, deadline())).offset).toBe(0)
  })

  it('drops an interrupted listing without converting arbitrary read failure into partial success', async () => {
    write('a'); write('b')
    const { listing, read } = fixture()
    read.mockRejectedValueOnce(new Error('fixture read failed'))
    await expect(listing.page(null, deadline())).rejects.toMatchObject({ code: 'unsafe' })
    expect((await listing.page(null, deadline())).images).toHaveLength(2)
  })

  it.skipIf(process.platform === 'win32')('refuses a page whose directory became writable after its last readable image', async () => {
    write('a')
    const { listing, read, codec } = fixture()
    read.mockImplementationOnce(async document => {
      const image = await codec.read(document)
      chmodSync(directory, 0o777)
      return image
    })
    await expect(listing.page(null, deadline())).rejects.toMatchObject({ code: 'unsafe' })
    chmodSync(directory, 0o700)
    expect((await listing.page(null, deadline())).images).toHaveLength(1)
  })

  it.skipIf(process.platform === 'win32').each(['writable', 'replacement'] as const)(
    'keeps a caught %s directory admission failure fatal after the directory is restored', async fault => {
      write('a'); write('b')
      const { listing, read } = fixture()
      read.mockImplementationOnce(async document => {
        if (fault === 'writable') chmodSync(directory, 0o777)
        else {
          renameSync(directory, directory + '-held'); mkdirSync(directory, { mode: 0o700 })
          write('a')
        }
        try { return await read.getMockImplementation()!(document) }
        finally {
          if (fault === 'writable') chmodSync(directory, 0o700)
          else { rmSync(directory, { recursive: true }); renameSync(directory + '-held', directory) }
        }
      })
      await expect(listing.page(null, deadline())).rejects.toMatchObject({ code: fault === 'writable' ? 'unsafe' : 'changed' })
      expect(ids((await listing.page(null, deadline())).images)).toEqual(['a', 'b'])
    })
})


it.each(['busy', 'expired', 'disconnected', 'cleanup-unconfirmed'] as const)(
  'keeps %s fatal after a readable archive instead of returning a partial catalog', async code => {
    write('a'); write('b')
    const { listing, read, codec } = fixture()
    read.mockImplementationOnce(document => codec.read(document)).mockRejectedValueOnce(new SessionStorageUnavailable(code))
    await expect(listing.page(null, deadline())).rejects.toMatchObject({ code })
    expect((await listing.page(null, deadline())).images).toHaveLength(2)
  })

it.each(['ENOSPC', 'EDQUOT', 'EROFS', 'EACCES', 'EPERM'] as const)(
  'skips only the individual %s archive read and keeps exact cursor progress', async code => {
    write('a'); write('b')
    const { listing, read } = fixture()
    read.mockRejectedValueOnce(new SessionStorageUnavailable(code))
    const page = await listing.page(null, deadline())
    expect(page).toMatchObject({ next: 2, total: 2, done: true })
    expect(ids(page.images)).toEqual(['b'])
  })
