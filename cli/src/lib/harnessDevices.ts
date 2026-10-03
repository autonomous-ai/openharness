import { z } from 'zod'
import type { DeviceSettingsPatch, DialStatus } from '../cable/cableSession.js'

export interface HarnessDevicesService {
  status(): DialStatus
  revision?(): number
  set(id: string, patch: DeviceSettingsPatch): Promise<{ ok: boolean; error?: string }>
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
