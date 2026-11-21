import { describe, expect, it } from 'vitest'
import * as launch from './engineLaunch.js'

describe('native launch implementation boundary', () => {
  it.each(['buildEngineInstallationArgv', 'shellAgentArgv', 'commandAvailableInInteractiveShell',
    'commandOutputInInteractiveShell', 'commandSupportsFlagInInteractiveShell', 'unsupportedLaunchModelFlag'])
  ('leaves %s to the setup or CLI implementation', name => {
    expect(Object.keys(launch)).not.toContain(name)
  })
})
