import type { PrismaClient } from '@prisma/client'
import { logger } from '../src/utils/logger.js'

type CommanderMsg = { type?: string; payload?: unknown }

function payloadOf(msg: CommanderMsg): Record<string, unknown> {
  return msg.payload && typeof msg.payload === 'object' ? msg.payload as Record<string, unknown> : {}
}

/**
 * The released backend's write of a device hello (main at ac285a931a, src/lib/deviceWs.ts handleHello's version line and
 * its recordHello call, src/services/DeviceService.ts recordHello), word for word but for three changes: `prisma` is
 * [db], `deviceService.recordHello` is the copy below, and the call is awaited (released: `void`) so a test reads the
 * row after it.
 */
export async function oldBackendHello(db: PrismaClient, deviceId: string, msg: CommanderMsg): Promise<void> {
  const payload = payloadOf(msg)
  const deviceFirmwareVersion = typeof payload.firmwareVersion === 'string' && payload.firmwareVersion ? payload.firmwareVersion : null
  const rssiRaw = typeof payload.rssi === 'number' ? payload.rssi
    : typeof payload.rssi === 'string' ? Number(payload.rssi)
      : null
  await recordHello(db, {
    deviceId,
    firmwareVersion: deviceFirmwareVersion,
    chip: typeof payload.chip === 'string' ? payload.chip : null,
    ssid: typeof payload.ssid === 'string' ? payload.ssid : null,
    rssi: rssiRaw !== null && Number.isFinite(rssiRaw) ? rssiRaw : null,
  })
}

async function recordHello(db: PrismaClient, input: {
  deviceId: string
  firmwareVersion?: string | null
  chip?: string | null
  ssid?: string | null
  rssi?: number | null
}): Promise<void> {
  const data: Record<string, unknown> = {}
  if (input.firmwareVersion) data.firmwareVersion = input.firmwareVersion
  if (input.chip) data.chip = input.chip
  if (input.ssid) data.ssid = input.ssid
  if (typeof input.rssi === 'number' && Number.isFinite(input.rssi) && input.rssi !== 0) data.rssi = Math.trunc(input.rssi)
  if (Object.keys(data).length === 0) return
  await db.deviceBinding
    .updateMany({ where: { deviceId: input.deviceId }, data })
    .catch((err: unknown) => logger.warn('recordHello failed', { deviceId: input.deviceId, error: String(err) }))
}
