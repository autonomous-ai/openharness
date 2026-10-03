import { homedir } from 'node:os'
import { join } from 'node:path'

export const installedTuiPath = (): string => join(homedir(), '.harness', 'bin', 'harness-tui')
