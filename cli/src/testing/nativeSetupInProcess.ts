/** Fixture composition: real native preparation with explicitly local probes and bounded file rendering. */
import { inspectNativeLaunch as inspect } from '../engines/nativeLaunch.js'
import { nativeSetupProbes } from '../services/nativeSetup.js'
import { env } from '../config/env.js'
import type { NativeSetup, NativeSetupProbes } from '../engines/kit/nativeSetup.js'

const setup: NativeSetupProbes & Pick<NativeSetup, 'prepareFiles' | 'prepareSettings'> = {
  ...nativeSetupProbes,
  prepareSettings: async (input, _request, current, commit) =>
    (await import('../services/nativeLaunchSettings.js')).prepareNativeLaunchSettings(input, env.ADAPTER_DATA_DIR, current, commit),
  prepareFiles: async (input, _request, current) =>
    (await import('../services/nativeSetupFiles.js')).prepareNativeHookFiles(input, current),
}

export const inspectNativeLaunch: typeof inspect = (engine, source, deps) =>
  inspect(engine, source, { setup, ...deps })
