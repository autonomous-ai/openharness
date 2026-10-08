import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PNG } from 'pngjs'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { decodePack } from '../cable/pets/pack.js'
import { PetStore } from '../cable/pets/store.js'
import { harnessDevicesRequest, type HarnessDevicesService } from './harnessDevices.js'
import type { DialStatus, DeviceSettings } from '../cable/cableSession.js'
import { encryptDownFrame, encryptRpcResult } from './e2ee/applicationFrames.js'
import { ENCRYPTED_UP_TYPES } from './e2ee/core.js'

// The real decoder, counted: the status poll must not decode a pack it has already drawn.
vi.mock('../cable/pets/pack.js', async (original) => {
  const actual = await original<typeof import('../cable/pets/pack.js')>()
  return { ...actual, decodePack: vi.fn(actual.decodePack) }
})

const settings: DeviceSettings = { brightness: 80, muted: false, quiet: false, character: 2,
  face: 466, round: true, voiceLang: 'en', scrollReversed: false, straightTitle: true, focusFace: false }
describe('owner device management', () => {
  const fixture = () => {
    const devices: DialStatus[] = [
      { id: 'usb-a', attached: true, settings },
      { id: 'usb-b', attached: true, settings },
      { id: 'offline', attached: false, settings },
      { id: 'updating', attached: true, settings, updating: 'next' },
    ]
    const set = vi.fn(async () => ({ ok: true }))
    const service: HarnessDevicesService = { status: () => ({ attached: true, devices }), revision: () => 4, set, ...petStubs() }
    return { service, set }
  }
  it('reads the whole host and sends a sparse patch only to the named device', async () => {
    const { service, set } = fixture()
    expect(await harnessDevicesRequest(service, 'harness_devices_list', {})).toMatchObject({ protocol: 1, revision: 4, status: { devices: expect.any(Array) } })
    const reply = await harnessDevicesRequest(service, 'harness_device_settings', { id: 'usb-b', patch: { brightness: 35 } })
    expect(set).toHaveBeenCalledExactlyOnceWith('usb-b', { brightness: 35 })
    expect(reply).toMatchObject({ ok: true, status: { devices: [{ settings: { brightness: 80 } }, { settings: { brightness: 80 } }, {}, {}] } })
  })
  it('refuses missing, disconnected, updating and invalid targets without a write', async () => {
    const { service, set } = fixture()
    for (const id of ['missing', 'offline']) expect(await harnessDevicesRequest(service, 'harness_device_settings', { id, patch: { muted: true } })).toMatchObject({ error: 'DEVICE_OFFLINE' })
    expect(await harnessDevicesRequest(service, 'harness_device_settings', { id: 'updating', patch: { muted: true } })).toMatchObject({ error: 'DEVICE_UPDATING' })
    for (const patch of [{ brightness: 101 }, { id: 'usb-a' }, { face: 720 }, {}, { muted: 'true' }]) {
      expect(await harnessDevicesRequest(service, 'harness_device_settings', { id: 'usb-b', patch })).toMatchObject({ error: 'BAD_DEVICE_SETTINGS' })
    }
    expect(set).not.toHaveBeenCalled()
  })
  it('does not report a failed cable delivery as success', async () => {
    const { service, set } = fixture()
    set.mockResolvedValue({ ok: false })
    expect(await harnessDevicesRequest(service, 'harness_device_settings', { id: 'usb-a', patch: { muted: true } })).toMatchObject({ error: 'DEVICE_WRITE_FAILED' })
  })
  it('encrypts requests, replies and device snapshots over remote relays', () => {
    for (const type of ['harness_devices_list', 'harness_device_settings']) {
      expect(encryptDownFrame(type)).toBe(true)
      expect(encryptRpcResult(`${type}_result`)).toBe(true)
    }
    expect(ENCRYPTED_UP_TYPES.has('harness_devices_changed')).toBe(true)
  })
})

const roots: string[] = []
afterAll(async () => { await Promise.all(roots.map(d => rm(d, { recursive: true, force: true }))) })

function petStubs() {
  return { pets: () => new PetStore(join(tmpdir(), 'unused-pets')), petDial: () => ({ supported: false, held: [], sending: null }), petsChanged: () => {} }
}

// What the defaults come to on sheetPng: only idle and running are drawn.
const DEFAULT_ROWS_IDLE = { rest: 'idle', working: 'running', listening: 'idle', sending: 'idle', asking: 'idle' }

// A 768 x 936 sheet with an idle and a running row.
function sheetPng(): Buffer {
  const png = new PNG({ width: 768, height: 936 })
  for (const row of [0, 7]) for (let c = 0; c < 2; c++) for (let y = 0; y < 30; y++) for (let x = 0; x < 30; x++) {
    png.data.set([200, 90 + c * 40, (x * 5 + y) & 255, 255], ((row * 104 + 30 + y) * 768 + c * 96 + 30 + x) * 4)
  }
  return PNG.sync.write(png)
}

describe('pet requests', () => {
  const fixture = async () => {
    const work = await mkdtemp(join(tmpdir(), 'pet-requests-'))
    roots.push(work)
    const petsChanged = vi.fn()
    const store = new PetStore(join(work, 'pets'))
    const service: HarnessDevicesService = {
      status: () => ({ attached: false }), set: async () => ({ ok: true }),
      pets: () => store, petDial: () => ({ supported: true, held: ['x'], sending: null }), petsChanged,
    }
    const sheet = join(work, 'sheet.png')
    await writeFile(sheet, sheetPng())
    const bad = join(work, 'bad.png')
    await writeFile(bad, PNG.sync.write(new PNG({ width: 10, height: 10 })))
    return { service, petsChanged, sheet, bad, work }
  }
  const PNG_URL = /^data:image\/png;base64,/

  it('pet_preview on a valid sheet returns frames per scene as data URLs', async () => {
    const { service, sheet } = await fixture()
    const reply = await harnessDevicesRequest(service, 'pet_preview', { path: sheet }) as Record<string, any>
    expect(reply).toMatchObject({ ok: true, id: expect.stringMatching(/^[0-9a-f]{16}$/), warnings: expect.any(Array), stepMs: { small: 120 } })
    expect(reply.bytes).toBeGreaterThan(0)
    expect(reply.colours).toBeGreaterThan(0)
    for (const scene of ['small', 'working', 'listening', 'sending']) {
      expect(reply.frames[scene].length).toBeGreaterThan(0)
      for (const url of reply.frames[scene]) {
        expect(url).toMatch(PNG_URL)
        const png = PNG.sync.read(Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'))
        expect(png.width).toBeGreaterThan(0)
      }
      expect(reply.stepMs[scene]).toBeGreaterThan(0)
    }
    expect(Object.keys(reply.frames).sort()).toEqual(['asking', 'listening', 'sending', 'small', 'working'])
    expect(reply.name).toBe('sheet')
    expect(reply.stepMs).toEqual({ small: 120, asking: 120, working: 120, listening: 120, sending: 120 })
  })
  it('pet_preview with a name stores it, sanitized: control characters stripped, trimmed, cut to 40; empty falls back to the file name', async () => {
    const { service, sheet } = await fixture()
    const nameOf = async (name: unknown) => {
      const reply = await harnessDevicesRequest(service, 'pet_preview', { path: sheet, name }) as Record<string, any>
      return reply.name
    }
    expect(await nameOf('  ddo-zvzo ')).toBe('ddo-zvzo')
    expect(await nameOf('a\u0000b\u001b[31mc\n')).toBe('ab[31mc')
    expect(await nameOf('x'.repeat(100))).toBe('x'.repeat(40))
    expect(await nameOf('\u0000\u0007 \n')).toBe('sheet')
    expect(await harnessDevicesRequest(service, 'pet_preview', { path: sheet, name: 5 })).toEqual({ error: 'BAD_PET_REQUEST' })
  })
  it("pet_preview on a bad sheet returns the sheet error's code and message", async () => {
    const { service, bad } = await fixture()
    const reply = await harnessDevicesRequest(service, 'pet_preview', { path: bad })
    expect(reply).toMatchObject({ error: 'BAD_SIZE', message: expect.stringMatching(/\S/) })
    expect(await harnessDevicesRequest(service, 'pet_preview', {})).toEqual({ error: 'BAD_PET_REQUEST' })
  })
  it('pet_preview answers the rows it used and a strip per drawn row of the sheet', async () => {
    const { service, sheet } = await fixture()
    const reply = await harnessDevicesRequest(service, 'pet_preview', { path: sheet }) as Record<string, any>
    expect(reply.rows).toEqual(DEFAULT_ROWS_IDLE)
    expect(reply.sheetRows.map((r: { row: string; frames: number }) => [r.row, r.frames])).toEqual([['idle', 2], ['running', 2]])
    for (const { strip } of reply.sheetRows) {
      const png = PNG.sync.read(Buffer.from(strip.slice(strip.indexOf(',') + 1), 'base64'))
      expect([png.width, png.height]).toEqual([2 * 59, 64])
    }
  })
  it('pet_preview with rows: a chosen row per state, the defaults for the rest; another choice is another pack', async () => {
    const { service, sheet } = await fixture()
    const plain = await harnessDevicesRequest(service, 'pet_preview', { path: sheet }) as Record<string, any>
    const swapped = await harnessDevicesRequest(service, 'pet_preview', { path: sheet, rows: { rest: 'running', working: 'idle', other: 'x' } }) as Record<string, any>
    expect(swapped.ok).toBe(true)
    expect(swapped.id).not.toBe(plain.id)
    expect(swapped.rows).toEqual({ rest: 'running', working: 'idle', listening: 'running', sending: 'running', asking: 'running' })
    const same = await harnessDevicesRequest(service, 'pet_preview', { path: sheet, rows: { listening: 'idle' } }) as Record<string, any>
    expect(same.id).toBe(plain.id)
    await harnessDevicesRequest(service, 'pet_apply', { target: 'all', id: swapped.id })
    const status = await harnessDevicesRequest(service, 'pet_status', {}) as { pets: Record<string, { rows: unknown }> }
    expect(status.pets[swapped.id].rows).toEqual(swapped.rows)
  })
  it('pet_preview refuses an unknown row name and explains an empty chosen row', async () => {
    const { service, sheet } = await fixture()
    expect(await harnessDevicesRequest(service, 'pet_preview', { path: sheet, rows: { rest: 'sideways' } })).toEqual({ error: 'BAD_PET_REQUEST' })
    expect(await harnessDevicesRequest(service, 'pet_preview', { path: sheet, rows: { working: 5 } })).toEqual({ error: 'BAD_PET_REQUEST' })
    expect(await harnessDevicesRequest(service, 'pet_preview', { path: sheet, rows: 'idle' })).toEqual({ error: 'BAD_PET_REQUEST' })
    expect(await harnessDevicesRequest(service, 'pet_preview', { path: sheet, rows: { working: 'jumping' } }))
      .toEqual({ error: 'NO_WORKING', message: 'The row chosen for Working is empty' })
    expect(await harnessDevicesRequest(service, 'pet_preview', { path: sheet, rows: { rest: 'review' } }))
      .toEqual({ error: 'NO_REST', message: 'The row chosen for Rest is empty' })
  })
  it('pet_apply with an unknown id answers UNKNOWN_PET and does not announce a change', async () => {
    const { service, petsChanged } = await fixture()
    expect(await harnessDevicesRequest(service, 'pet_apply', { target: 'all', id: '0123456789abcdef' })).toMatchObject({ error: 'UNKNOWN_PET' })
    expect(await harnessDevicesRequest(service, 'pet_apply', { target: 'all', id: 'nope' })).toMatchObject({ error: 'UNKNOWN_PET' })
    expect(petsChanged).not.toHaveBeenCalled()
  })
  it('pet_apply and pet_reset change the mapping and call petsChanged; pet_status reports it', async () => {
    const { service, petsChanged, sheet } = await fixture()
    const { id } = await harnessDevicesRequest(service, 'pet_preview', { path: sheet }) as { id: string }
    expect(await harnessDevicesRequest(service, 'pet_apply', { target: 'claude', id })).toEqual({ ok: true, mapping: { all: null, engines: { claude: id } } })
    expect(petsChanged).toHaveBeenCalledTimes(1)
    expect(await harnessDevicesRequest(service, 'pet_status', {})).toEqual({
      mapping: { all: null, engines: { claude: id } }, dial: { supported: true, held: ['x'], sending: null },
      pets: { [id]: { name: 'sheet', thumb: expect.stringMatching(PNG_URL), rows: DEFAULT_ROWS_IDLE } },
    })
    expect(await harnessDevicesRequest(service, 'pet_reset', { target: 'claude' })).toEqual({ ok: true, mapping: { all: null, engines: {} } })
    expect(petsChanged).toHaveBeenCalledTimes(2)
    expect(await harnessDevicesRequest(service, 'pet_reset', { target: '' })).toMatchObject({ error: 'BAD_PET_REQUEST' })
    expect(await harnessDevicesRequest(service, 'pet_reset', { target: '../x' })).toMatchObject({ error: 'BAD_TARGET' })
  })
  it('pet_status draws a pack once however often it is polled', async () => {
    const { service, sheet } = await fixture()
    const { id } = await harnessDevicesRequest(service, 'pet_preview', { path: sheet }) as { id: string }
    await harnessDevicesRequest(service, 'pet_apply', { target: 'all', id })
    vi.mocked(decodePack).mockClear()
    const first = await harnessDevicesRequest(service, 'pet_status', {}) as { pets: Record<string, { thumb: string }> }
    expect(decodePack).toHaveBeenCalledTimes(1)
    const second = await harnessDevicesRequest(service, 'pet_status', {}) as { pets: Record<string, { thumb: string }> }
    expect(decodePack).toHaveBeenCalledTimes(1)
    expect(second.pets[id].thumb).toBe(first.pets[id].thumb)
    expect(first.pets[id].thumb).toMatch(PNG_URL)
  })
  it('a store that cannot write answers STORAGE with a short reason', async () => {
    const { service } = await fixture()
    const denied = (code: string) => ({ ...service, pets: () => ({ mappedIds: () => [], mapping: () => ({ all: null, engines: {} }), reset: async () => { throw Object.assign(new Error('x'), { code }) } }) as unknown as PetStore })
    expect(await harnessDevicesRequest(denied('EACCES'), 'pet_reset', { target: 'all' })).toEqual({ error: 'STORAGE', message: 'Couldn’t save the pet: permission denied' })
    expect(await harnessDevicesRequest(denied('ENOSPC'), 'pet_reset', { target: 'all' })).toEqual({ error: 'STORAGE', message: 'Couldn’t save the pet: the disk is full' })
    expect(await harnessDevicesRequest(denied('EROFS'), 'pet_reset', { target: 'all' })).toMatchObject({ error: 'STORAGE' })
  })
})
