// Found by QA on a quiet machine: a failed process-environment probe leaves a valid agent without
// codexHome. Keep process identity and every other filesystem/process observation real.
import childProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'

const denied = () => Object.assign(new Error('fixture: process environment is unreadable'), { code: 'EACCES' })
const execFile = childProcess.execFile
childProcess.execFile = function (file, args, ...rest) {
  if (file === 'ps' && args?.[0] === 'eww') {
    const child = new EventEmitter()
    const callback = rest.find(value => typeof value === 'function')
    queueMicrotask(() => { callback?.(denied(), '', ''); child.emit('close', 1) })
    return child
  }
  return execFile.call(this, file, args, ...rest)
}
const readFile = fs.readFile
fs.readFile = async function (path, ...rest) {
  if (/^\/proc\/\d+\/environ$/.test(String(path))) throw denied()
  return readFile.call(this, path, ...rest)
}
syncBuiltinESMExports()
