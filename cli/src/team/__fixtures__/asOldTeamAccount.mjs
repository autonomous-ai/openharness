// Preloaded (`--import`) by team/bootGuard.spec.ts: this process sees the root-owned Team config every computer set up before
// 2026-11-07 has, naming the account it runs as, so it runs as an old Team account's boot job would. Nothing is written.
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { userInfo } from 'node:os'

const CONFIGS = new Set(['/Library/Application Support/Harness/team.json', '/etc/harness/team.json', 'C:\\ProgramData\\Harness\\team.json'])
const read = fs.readFileSync
fs.readFileSync = function (path, ...rest) {
  if (typeof path === 'string' && CONFIGS.has(path)) return JSON.stringify({ version: 1, user: userInfo().username })
  return read.call(this, path, ...rest)
}
syncBuiltinESMExports()
