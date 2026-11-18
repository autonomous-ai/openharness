import type { execFile } from 'node:child_process'
import { dirname, join } from 'node:path'
import { writeBrowserShim } from './browserShim.js'
import type { DaemonAddress } from '../core/api.js'
import { OPENCODE_VERSION } from '../engines/opencode/contract.js'
import { nativeProcessEnvironment } from '../engines/kit/nativeLocations.js'
/** The local implementation is loaded by setup, or the explicit old-master/debug inline door. */
import { engineDownloading } from '../engines/kit/downloadMarker.js'
import type { NativeSetup, NativeSetupProbes } from '../engines/kit/nativeSetup.js'
import { OPENCLAW_RUNTIME_PROBE } from '../engines/openclaw/contract.js'
import { helpOf, readNativeProbe } from '../engines/kit/nativeProbe.js'

function setupProbes(execute?: typeof execFile, alongsideProbe?: () => void): NativeSetupProbes {
  return {
    probe: (executable, kind, environment) => {
      if (!executable.current()) return Promise.resolve(null)
      const result = kind === 'help' || kind === 'versionHelp' ? helpOf(executable, environment, kind === 'versionHelp' ? ['--version'] : undefined, execute)
        : readNativeProbe(executable.command, kind === 'runtime' ? OPENCLAW_RUNTIME_PROBE : ['--version'], environment, execute)
      alongsideProbe?.()
      return result
    },
    opencodeMajor: async () => {
      const { opencodeMajorVersion } = await import('../engines/opencode/version.js')
      if (!execute) return opencodeMajorVersion()
      const [{ captureLaunchExecutable }, { nativeVersionProbe }] = await Promise.all([
        import('../engines/kit/launchExecutable.js'), import('../engines/kit/nativeVersion.js'),
      ])
      const selected = await captureLaunchExecutable('opencode', undefined, execute)
      return selected.state === 'ready' ? opencodeMajorVersion(nativeVersionProbe(OPENCODE_VERSION,
        () => selected.executable.command, nativeProcessEnvironment(selected.environment), execute)) : null
    },
    hermesKeepsRecord: async (executable, environment) => {
      const { hermesKeepsRecord } = await import('../engines/hermesRecord.js')
      if (!execute) return hermesKeepsRecord(executable, environment)
      const [{ captureLaunchExecutable }, { nativeVersionProbe }] = await Promise.all([
        import('../engines/kit/launchExecutable.js'), import('../engines/kit/nativeVersion.js'),
      ])
      return hermesKeepsRecord(executable, environment, {
        capture: engine => captureLaunchExecutable(engine, undefined, execute),
        probe: (rule, binary, env) => nativeVersionProbe(rule, binary, env, execute),
      })
    },
  }
}

export const nativeSetupProbes = setupProbes()

/** directory is the installation journal directory; its parent is the owning service's data root. */
export function createLocalNativeSetup(directory: string, execute?: typeof execFile, daemon?: Pick<DaemonAddress, 'command'>): NativeSetup {
  if (daemon && !writeBrowserShim(daemon.command, join(dirname(directory), 'bin', 'harness-browser'))) {
    console.warn('[engine-setup] BROWSER_SHIM_UNAVAILABLE')
  }
  const windows = process.platform === 'win32'
  let loading: Promise<NativeSetup['installations']> | undefined
  const installations = () => loading ??= (windows
    ? import('../engines/kit/windowsInstall.js').then(module => module.createWindowsInstallations({ directory }))
    : import('../engines/kit/nativeInstall.js').then(module => module.createNativeInstallations({ directory })))
    .catch(error => { console.warn('[engine-setup] INSTALLATION_MODULE_UNAVAILABLE'); throw error })
  // Load code while the child probes, without inspecting, reserving or dispatching an installation.
  const preload = () => { void installations().catch(() => {}) }
  return { ...setupProbes(execute, preload), downloading: engine => engineDownloading(engine, undefined, undefined, execute),
    prepareSettings: async (input, _request, current, commit) =>
      (await import('./nativeLaunchSettings.js')).prepareNativeLaunchSettings(input, dirname(directory), current, commit),
    prepareFiles: async (input, _request, current) =>
      (await import('./nativeSetupFiles.js')).prepareNativeHookFiles(input, current),
    prepareTrust: async (input, _request, current) => (await import('./nativeSetupTrust.js')).prepareNativeTrust(input, current),
    installations: {
      ensure: async (...args) => (await installations()).ensure(...args),
      status: async (...args) => (await installations()).status(...args),
    } }
}
