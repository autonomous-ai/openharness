import { ENGINES, isTerminalEngine, type AgentEngine } from '../engines/types.js'
import { sessionFactoryOwners } from '../harnessd/services.js'

/** Fixtures use the installed declaration, as core composition does, without a second engine roster. */
const owner = sessionFactoryOwners(ENGINES)
export const nativeFactory = (value: unknown): value is AgentEngine => owner(value)?.kind === 'native'
export const deviceFactory = (value: unknown): boolean => typeof value === 'string' && !isTerminalEngine(value) && owner(value) !== undefined
export const cloudFactory = (value: unknown): boolean => {
  const selected = owner(value)
  return selected?.kind === 'service' && selected.service === 'cloud'
}
