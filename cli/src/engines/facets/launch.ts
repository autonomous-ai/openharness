/** Literal argv contracts copied from the existing launch paths. No engine version behavior changes. */
export interface EngineLaunch {
  permissionModes: Readonly<Record<string, readonly string[]>>
  bypassPermission: string[]
  firstPromptArgs: readonly string[]
  resumeArgs: string[]
  forkArgs: { lead: string[]; after?: string[] }
  instructionFiles: readonly string[]
  contextArgs?: (contextFile: string) => string[]
  envArgs?: (env: Record<string, string>) => string[]
}
