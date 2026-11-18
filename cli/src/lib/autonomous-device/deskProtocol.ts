import { boundedJsonBytes } from '../boundedJsonBytes.js'

export const DESK_WAIT_MS = 5_000
export type DeskDirection = 'next' | 'previous'
export type DeskPhase = 'down' | 'move' | 'up'
export type DeskRequest = { machineId: string } & (
  { kind: 'probe' } | { kind: 'step'; direction: DeskDirection; currentAgentId?: string; expiresAt: number }
  | { kind: 'scroll'; phase: DeskPhase; dy: number; velocity: number })
const id = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max
export function deskStroke(phase: unknown, dy: unknown, velocity: unknown): phase is DeskPhase {
  return (phase === 'down' || phase === 'move' || phase === 'up')
    && Number.isSafeInteger(dy) && Math.abs(dy as number) <= 4096
    && Number.isSafeInteger(velocity) && Math.abs(velocity as number) <= 100000
}

/** Detach only bounded primitives before an external request crosses an await. */
export function deskRequest(frame: string, value: unknown): DeskRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value) || boundedJsonBytes(value, 4096) === null) return null
  const p = value as Record<string, unknown>
  if (!id(p.machineId, 200)) return null
  const exact = (keys: string[]): boolean => Object.keys(p).every(key => keys.includes(key))
  if (frame === 'harness_device_scroll') {
    if (!exact(['machineId', 'phase', 'dy', 'velocity']) || !deskStroke(p.phase, p.dy, p.velocity)) return null
    return { kind: 'scroll', machineId: p.machineId, phase: p.phase, dy: p.dy as number, velocity: p.velocity as number }
  }
  if (!id(p.requestId, 128)) return null
  if (p.probe === true) return exact(['machineId', 'requestId', 'probe']) ? { kind: 'probe', machineId: p.machineId } : null
  if (!exact(['machineId', 'requestId', 'direction', 'currentAgentId', 'expiresAt'])
    || (p.direction !== 'next' && p.direction !== 'previous')
    || (p.currentAgentId !== undefined && !id(p.currentAgentId, 128)) || !Number.isSafeInteger(p.expiresAt)) return null
  return { kind: 'step', machineId: p.machineId, direction: p.direction, currentAgentId: p.currentAgentId as string | undefined, expiresAt: p.expiresAt as number }
}
