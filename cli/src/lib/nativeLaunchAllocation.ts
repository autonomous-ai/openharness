/** Original pane and server identity survives engine exit. No reader may fill
 * missing legacy fields from a later tmux server or a reused numeric PID. */
import { isAbsolute } from 'node:path'
import { validNativeHookWriter, type NativeHookWriter } from '../engines/kit/nativeHookWriter.js'
import type { NativePaneAllocation } from './nativePaneAllocation.js'

export interface NativeLaunchAllocation extends NativePaneAllocation {
  readonly root: Readonly<NativeHookWriter>
  readonly endpoint: { readonly binary: string; readonly socket: string; readonly server: Readonly<NativeHookWriter> }
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const exact = (value: Record<string, unknown>, keys: string) => Object.keys(value).sort().join(',') === keys
const path = (value: unknown): value is string => typeof value === 'string' && isAbsolute(value)
  && value.length <= 4096 && !/[\0\r\n]/.test(value)
const writer = (value: unknown): value is NativeHookWriter => object(value) && exact(value, 'birth,boot,namespace,pid')
  && validNativeHookWriter(value as unknown as NativeHookWriter)

/** The pre-rc gate owns a pane before there is an exec-shell incarnation. */
export function parseNativeLaunchPlacement(value: unknown): NativeLaunchAllocation | null {
  if (!object(value) || !exact(value, 'endpoint,owner,pane,root,rootPid,token')
    || typeof value.pane !== 'string' || !/^%[0-9]{1,20}$/.test(value.pane)
    || typeof value.token !== 'string' || !/^[a-zA-Z0-9_-]{16,96}$/.test(value.token)
    || typeof value.owner !== 'string' || !/^[a-f0-9]{16}$/.test(value.owner)
    || !writer(value.root) || value.root.pid !== value.rootPid
    || !object(value.endpoint) || !exact(value.endpoint, 'binary,server,socket')
    || !path(value.endpoint.binary) || !path(value.endpoint.socket) || !writer(value.endpoint.server)
    || value.endpoint.server.pid === value.root.pid
    || value.root.boot !== value.endpoint.server.boot || value.root.namespace !== value.endpoint.server.namespace) return null
  return Object.freeze({ pane: value.pane, rootPid: value.rootPid as number, token: value.token, owner: value.owner,
    root: Object.freeze({ ...value.root }), endpoint: Object.freeze({ binary: value.endpoint.binary,
      socket: value.endpoint.socket, server: Object.freeze({ ...value.endpoint.server }) }) })
}

export function parseNativeLaunchAllocation(value: unknown, engine: { boot: string; namespace?: string; pid: number }): NativeLaunchAllocation | null {
  const allocation = parseNativeLaunchPlacement(value)
  return allocation && allocation.root.pid !== engine.pid && allocation.endpoint.server.pid !== engine.pid
    && allocation.root.boot === engine.boot && allocation.root.namespace === engine.namespace ? allocation : null
}
