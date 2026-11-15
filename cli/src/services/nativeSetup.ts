import type { execFile } from 'node:child_process'
import type { AgentEngine } from '../engines/types.js'
import { OPENCODE_VERSION } from '../engines/opencode/contract.js'
import { nativeVersionProbe } from '../engines/kit/nativeVersion.js'
import { nativeProcessEnvironment } from '../engines/kit/nativeLocations.js'
/** The local implementation is loaded by setup, or the explicit old-master/debug inline door. */
import { captureLaunchExecutable } from '../engines/kit/launchExecutable.js'
import { engineDownloading } from '../engines/kit/downloadMarker.js'
import { createNativeInstallations } from '../engines/kit/nativeInstall.js'
import { createWindowsInstallations } from '../engines/kit/windowsInstall.js'
import type { NativeSetup, NativeSetupProbes } from '../engines/kit/nativeSetup.js'
import { hermesKeepsRecord } from '../engines/hermesRecord.js'
import { opencodeMajorVersion } from '../engines/opencode/version.js'
import { OPENCLAW_RUNTIME_PROBE } from '../engines/openclaw/contract.js'
import { helpOf, readNativeProbe } from '../engines/kit/nativeProbe.js'

export const nativeSetupProbes: NativeSetupProbes = {
  probe: (executable, kind, environment) => {
    if (!executable.current()) return Promise.resolve(null)
    return kind === 'help' || kind === 'versionHelp'
      ? helpOf(executable, environment, kind === 'versionHelp' ? ['--version'] : undefined)
      : readNativeProbe(executable.command, kind === 'runtime' ? OPENCLAW_RUNTIME_PROBE : ['--version'], environment)
  },
  opencodeMajor: () => opencodeMajorVersion(),
  hermesKeepsRecord: (executable, environment) => hermesKeepsRecord(executable, environment),
}

export function createLocalNativeSetup(directory: string, execute?: typeof execFile): NativeSetup {
  const capture = (engine: AgentEngine) => captureLaunchExecutable(engine, undefined, execute)
  const probes: NativeSetupProbes = execute ? {
    probe: (executable, kind, environment) => {
      if (!executable.current()) return Promise.resolve(null)
      return kind === 'help' || kind === 'versionHelp' ? helpOf(executable, environment, kind === 'versionHelp' ? ['--version'] : undefined, execute)
        : readNativeProbe(executable.command, kind === 'runtime' ? OPENCLAW_RUNTIME_PROBE : ['--version'], environment, execute)
    },
    opencodeMajor: async () => {
      const selected = await capture('opencode')
      return selected.state === 'ready' ? opencodeMajorVersion(nativeVersionProbe(OPENCODE_VERSION,
        () => selected.executable.command, nativeProcessEnvironment(selected.environment), execute)) : null
    },
    hermesKeepsRecord: (executable, environment) => hermesKeepsRecord(executable, environment, { capture,
      probe: (rule, binary, env) => nativeVersionProbe(rule, binary, env, execute) }),
  } : nativeSetupProbes
  return { ...probes, downloading: engine => engineDownloading(engine, undefined, undefined, execute),
    installations: (process.platform === 'win32' ? createWindowsInstallations : createNativeInstallations)({ directory }) }
}
