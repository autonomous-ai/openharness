/** Trust preparation uses fixed engine destinations and indexed replacement bytes. */
import { join } from 'node:path'
import { launchContract } from '../launches.js'
import { homeIsAbsolute, homeIsNetworkOrDevice } from './homeAdoption.js'
import { boundedHookInput, type NativeHookInput } from './nativeHookWire.js'

export interface NativeTrustInput {
  engine: 'claude' | 'codex'
  cwd: string
  home: string
  userHome?: string
  source?: string
  files: NativeHookInput['files']
}

export function trustDestinations(input: Pick<NativeTrustInput, 'engine' | 'home' | 'cwd'>): string[] {
  const contract = launchContract(input.engine)!
  return [join(input.home, contract.trust!.file), ...(contract.inheritedMcp ? [join(input.cwd, contract.inheritedMcp.settings)] : [])]
}

export function boundedTrustInput(value: unknown): value is NativeTrustInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const input = value as Record<string, unknown>
  if (Object.keys(input).some(key => !['engine', 'cwd', 'home', 'userHome', 'source', 'files'].includes(key))
    || input.engine !== 'claude' && input.engine !== 'codex') return false
  const path = (value: unknown): value is string => typeof value === 'string' && value.length > 0
    && Buffer.byteLength(value) <= 4096 && !value.includes('\0') && homeIsAbsolute(value) && !homeIsNetworkOrDevice(value)
  if (!path(input.cwd) || !path(input.home) || input.source !== undefined && !path(input.source)
    || (input.engine === 'claude' ? !path(input.userHome) : input.userHome !== undefined)) return false
  // Reuse exactly the native-file envelope bounds; trust itself has no hook port or environment on the wire.
  if (!boundedHookInput({ engine: input.engine, environment: {}, port: 1, files: input.files })) return false
  const expected = trustDestinations(input as unknown as NativeTrustInput)
  const files = input.files as NativeTrustInput['files']
  return files.length === expected.length && files.every((file, index) => file.file === expected[index])
}
