import { join } from 'node:path'
import { HERMES_INTERFACE } from '../hermes/contract.js'
import { readYamlSetting } from './yamlSetting.js'

/** Whether [home]'s config sets Hermes to start its TUI. Read each time: a person may change it between two installs. */
export async function hermesHomeIsTui(home: string): Promise<boolean> {
  const value = await readYamlSetting(join(home, HERMES_INTERFACE.file), HERMES_INTERFACE.section, HERMES_INTERFACE.key, HERMES_INTERFACE.maxBytes)
  return value?.trim().toLowerCase() === HERMES_INTERFACE.tui
}
