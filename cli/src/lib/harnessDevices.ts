import { z } from 'zod'
import type { DeviceSettingsPatch, DialStatus } from '../cable/cableSession.js'
import { DEVICES_REQUESTS } from '../core/api.js'
import { frameUrl, previewFrames, sheetStrips } from '../cable/pets/preview.js'
import type { PetDialState } from '../cable/pets/sync.js'
import { decodePack } from '../cable/pets/pack.js'
import { PET_ROWS, PetSheetError, type PetRow, type PetRows } from '../cable/pets/sheet.js'
import { PetStoreError, type PetMapping, type PetStore } from '../cable/pets/store.js'

export interface HarnessDevicesService {
  status(): DialStatus
  revision?(): number
  set(id: string, patch: DeviceSettingsPatch): Promise<{ ok: boolean; error?: string }>
  pets(): PetStore
  petDial(): PetDialState
  /** The mapping changed: the dials are brought in line with it. */
  petsChanged(): void
}

// The pet requests are the pet_ names of the devices' request list: one list, so a name cannot be added to one and not the other.
export const PET_REQUESTS = DEVICES_REQUESTS.filter((name) => name.startsWith('pet_'))
// Which sheet row plays each state: a state left out takes the default, a row the sheet format has not is refused.
const petRow = z.enum(PET_ROWS as [PetRow, ...PetRow[]]).optional()
const petRows = z.object({ rest: petRow, working: petRow, listening: petRow, sending: petRow, asking: petRow })
const petPath = z.object({ path: z.string().min(1).max(4096), name: z.string().max(1024).optional(), rows: petRows.optional() })
const petApply = z.object({ target: z.string().min(1).max(64), id: z.string().min(1).max(64) })
const petReset = z.object({ target: z.string().min(1).max(64) })

const thumbCache = new WeakMap<PetStore, Map<string, string>>()
function thumbsOf(store: PetStore): Map<string, string> {
  let cache = thumbCache.get(store)
  if (!cache) thumbCache.set(store, (cache = new Map()))
  return cache
}

// A store that cannot write is the user's disk, not a bug: say what to look at.
const STORAGE_REASONS: Record<string, string> = {
  EACCES: 'permission denied', EPERM: 'permission denied', ENOSPC: 'the disk is full', EROFS: 'the disk is read-only',
}

async function petRequest(service: HarnessDevicesService, type: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const store = service.pets()
  try {
    if (type === 'pet_status') {
      const pets: Record<string, { name: string; thumb: string; rows: PetRows | null }> = {}
      const cache = thumbsOf(store)
      const ids = store.mappedIds()
      for (const id of cache.keys()) if (!ids.includes(id)) cache.delete(id)
      for (const id of ids) {
        // A pack never changes under its id, so its picture is drawn once; polling must not decode packs every second.
        let thumb = cache.get(id)
        if (thumb === undefined) {
          thumb = ''
          try {
            const pet = decodePack(await store.pack(id))
            thumb = frameUrl(pet.frames[pet.small.loops.idle[0]], pet.palette)
            cache.set(id, thumb)
          } catch { /* a pack that cannot be read has no picture (and is tried again); the name still shows */ }
        }
        pets[id] = { name: await store.name(id), thumb, rows: await store.rows(id) }
      }
      return { mapping: store.mapping(), dial: service.petDial(), pets }
    }
    if (type === 'pet_preview') {
      const parsed = petPath.safeParse(payload)
      if (!parsed.success) return { error: 'BAD_PET_REQUEST' }
      const { id, bytes, pet: converted, rows, sheet } = await store.prepare(parsed.data.path, parsed.data.name, parsed.data.rows)
      // The preview is what the dial gets: drawn from the stored pack, not from the conversion. sheetRows is every
      // drawn row of the sheet, for the app's row picker.
      const pet = decodePack(await store.pack(id))
      return {
        ok: true, id, name: await store.name(id), bytes, colours: pet.palette.length - 1, warnings: converted.warnings, ...previewFrames(pet),
        rows, sheetRows: sheetStrips(sheet),
      }
    }
    if (type === 'pet_apply') {
      const parsed = petApply.safeParse(payload)
      if (!parsed.success) return { error: 'BAD_PET_REQUEST' }
      const mapping: PetMapping = await store.apply(parsed.data.target, parsed.data.id)
      service.petsChanged()
      return { ok: true, mapping }
    }
    const parsed = petReset.safeParse(payload)
    if (!parsed.success) return { error: 'BAD_PET_REQUEST' }
    const mapping = await store.reset(parsed.data.target)
    service.petsChanged()
    return { ok: true, mapping }
  } catch (error) {
    if (error instanceof PetSheetError || error instanceof PetStoreError) return { error: error.code, message: error.message }
    const reason = STORAGE_REASONS[(error as NodeJS.ErrnoException | null)?.code ?? '']
    if (reason) return { error: 'STORAGE', message: `Couldn’t save the pet: ${reason}` }
    throw error
  }
}

export const deviceSettingsPatchSchema = z.object({
  brightness: z.number().int().min(0).max(100).optional(),
  muted: z.boolean().optional(),
  quiet: z.boolean().optional(),
  scrollReversed: z.boolean().optional(),
  voiceLang: z.string().regex(/^[a-z]{2}(?:-[A-Z]{2})?$/).optional(),
  character: z.number().int().min(0).max(255).optional(),
  straightTitle: z.boolean().optional(),
  focusFace: z.boolean().optional(),
  followCompanion: z.boolean().optional(),
}).strict().refine(value => Object.keys(value).length > 0)
const change = z.object({ id: z.string().min(1).max(256), patch: deviceSettingsPatchSchema })

/** The authenticated connection selects the host; payloads only select its USB device. */
export async function harnessDevicesRequest(
  service: HarnessDevicesService | null, type: string, payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!service) return { error: 'UNSUPPORTED' }
  if ((PET_REQUESTS as readonly string[]).includes(type)) return petRequest(service, type, payload)
  if (type === 'harness_devices_list') return { protocol: 1, revision: service.revision?.() ?? 0, status: service.status() }
  const parsed = change.safeParse({ id: payload.id, patch: payload.patch })
  if (!parsed.success) return { error: 'BAD_DEVICE_SETTINGS' }
  const snapshot = service.status()
  const device = (snapshot.devices ?? [snapshot]).find(item => item.id === parsed.data.id)
  if (!device?.attached) return { error: 'DEVICE_OFFLINE' }
  if (device.updating) return { error: 'DEVICE_UPDATING' }
  if (!device.settings) return { error: 'DEVICE_NOT_READY' }
  const sent = await service.set(parsed.data.id, parsed.data.patch)
  if (!sent.ok) return { error: 'DEVICE_WRITE_FAILED' }
  // Acceptance is not firmware acknowledgment. The subsequent status event
  // reports what the device actually holds, including a refused setting.
  return { ok: true, revision: service.revision?.() ?? 0, status: service.status() }
}
