/** The two desk gestures shared by the device components when they occupy the same worker. */
import { errorKind } from '../lib/log.js'
import { resolve } from 'node:path'
import { DeviceWorkBudget } from '../lib/autonomous-device/pendingWork.js'

export type DeskStep = { machineId: string; agentId: string } | 'no_agents' | 'no_app'
type Direction = 'next' | 'previous'
type Phase = 'down' | 'move' | 'up'
export interface DeviceDesk {
  stepFocus(direction: Direction, agentId: string | undefined, current: () => boolean): Promise<DeskStep>
  scroll(phase: Phase, dy: number, velocity: number, current: () => boolean): void
}
export interface DeviceDeskClient {
  stepFocus(direction: Direction, agentId: string | undefined, current: () => boolean): Promise<DeskStep>
  scroll(phase: Phase, dy: number, velocity: number, current: () => boolean): boolean
}
interface Published {
  dataDir: string
  machineId: string
  current(): boolean
  peer: DeviceDeskClient
}
// One worker has one devices owner. Old in-flight calls retain their charge across publication changes.
let published: Published | null = null
const work = new DeviceWorkBudget()

export function publishDeviceDesk(options: {
  dataDir: string; machineId: string; current(): boolean; hasWindow(): boolean; desk: DeviceDesk
  faults?: ReadonlySet<string>; log?: (line: string) => void
}): () => void {
  const log = options.log ?? (line => console.warn(line))
  const active = (): boolean => published === own && options.current()
  const own: Published = { dataDir: resolve(options.dataDir), machineId: options.machineId, current: active, peer: {
    stepFocus: (direction, agentId, callerCurrent) => {
      if (!active() || !callerCurrent()) return Promise.resolve('no_agents')
      const release = work.reserve({ direction, agentId })
      if (!release) { log('[devices] DESK_BACKPRESSURE'); return Promise.resolve('no_agents') }
      return new Promise<DeskStep>(resolve => {
        let expired = false
        const current = (): boolean => !expired && active() && callerCurrent()
        const timer = setTimeout(() => {
          expired = true; log('[devices] DESK_TIMEOUT'); resolve('no_agents')
        }, 5_000)
        timer.unref?.()
        const actual = async (): Promise<DeskStep> => {
          if (options.faults?.has('devices.stepFocus')) throw new Error('DESK_FAILED')
          return options.desk.stepFocus(direction, agentId, () => current() && options.hasWindow())
        }
        void actual().then(result => resolve(current() ? options.hasWindow() ? result : 'no_app' : 'no_agents'), (caughtFailure) => {
          log(('[devices] DESK_FAILED') + ' · ' + errorKind(caughtFailure)); resolve('no_agents')
        }).finally(() => { clearTimeout(timer); release() })
      })
    },
    scroll: (phase, dy, velocity, callerCurrent) => {
      if (!active() || !callerCurrent() || !options.hasWindow()) return false
      try {
        if (options.faults?.has('devices.scroll')) throw new Error('DESK_FAILED')
        options.desk.scroll(phase, dy, velocity, () => active() && callerCurrent() && options.hasWindow())
      } catch (caughtFailure) { log(('[devices] DESK_FAILED') + ' · ' + errorKind(caughtFailure)) }
      // Like the existing core notice, a stroke is accepted, not an acknowledged mutation.
      return true
    },
  } }
  published = own
  return () => { if (published === own) published = null }
}

/** Absence selects the existing mixed-host route before dispatch; a failed direct call is never replayed. */
export function deviceDeskFor(dataDir: string, machineId: string): DeviceDeskClient | null {
  return published?.dataDir === resolve(dataDir) && published.machineId === machineId && published.current() ? published.peer : null
}
