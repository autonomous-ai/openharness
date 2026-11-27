import { join } from 'node:path'
import { harnessPath } from '../config/harnessHome.js'

export const installedTuiPath = (): string => join(harnessPath('bin'), 'harness-tui')
