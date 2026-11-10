// Preloaded (`--import`) by team/bootGuard.spec.ts: this process runs as `harnessteam` and sees the root-owned Team config every
// computer set up before 2026-11-07 has, naming it, so it runs as an old Team account's boot job would. Nothing is written.
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import os from 'node:os'

const CONFIGS = new Set(['/Library/Application Support/Harness/team.json', '/etc/harness/team.json', 'C:\\ProgramData\\Harness\\team.json'])
const read = fs.readFileSync
fs.readFileSync = function (path, ...rest) {
  if (typeof path === 'string' && CONFIGS.has(path)) return JSON.stringify({ version: 1, user: 'harnessteam' })
  return read.call(this, path, ...rest)
}
const userInfo = os.userInfo
os.userInfo = (...args) => ({ ...userInfo(...args), username: 'harnessteam' })
syncBuiltinESMExports()
