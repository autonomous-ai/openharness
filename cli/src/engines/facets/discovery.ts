import type { FolderSetting } from './hooks.js'

/**
 * How core recognises an engine's process and reads its facts off argv, environment and transcript paths.
 * Declared data, applied in core by the kit (kit/processFacts.ts, kit/projectFolder.ts) on every discovery
 * pass, as the registry loads and at start-up. Session binding never waits on an engine worker
 * (docs/design/2026-10-08-engine-launch.md, (c3)).
 */
export interface DiscoveryContract {
  process: {
    /** Vendor-supported native names, matched against the executable's and the entrypoint's basenames. */
    basenames: readonly RegExp[]
    /** Launcher and package entrypoints, independent of install prefix. */
    entrypoints: readonly RegExp[]
    /**
     * A native install whose binary is named only by its version, in a folder of versions at this path
     * (lowercase, `/`-separated, under any prefix). Never a bare version: an unrelated process called
     * `2.1.246` is not evidence.
     */
    versionedInstall?: string
  }
  /**
   * How the engine names an existing session on its command line: the flags, what its ids look like (a
   * filter: a flag that takes a name must not register a title), and the flags under which the named id is
   * a parent's (a fork writes a new session) and must not bind.
   */
  resumeArgs: { flags: readonly string[]; id: RegExp; unless?: readonly string[] }
  /** A grid launch writes the model into argv as `-m <model>`. */
  modelInArgv?: boolean
  /** The engine home a process carries in `variable` when launched under a profile, and the setting naming
   *  this machine's default. */
  profile?: { variable: string; setting: FolderSetting; trimTrailingSlashes?: boolean }
  /**
   * Transcripts kept by the folder the session began in, `<root>/<folder's directory name>/<id>`, never
   * moved: the directory name is the folder with every character `mangle` matches replaced by `with`, and
   * starts with `marker` (as every absolute folder's does). A transcript names its folder on a line whose
   * `field` maps to the directory's name, within the first `scanBytes`.
   */
  projectFolder?: { mangle: RegExp; with: string; marker: string; field: string; scanBytes: number }
}
