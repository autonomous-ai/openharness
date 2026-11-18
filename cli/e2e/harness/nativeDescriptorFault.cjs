// Private e2e fault: deny only complete native descriptor reads while a fixture flag exists.
// An independent optional-discovery fault checks that its cooldown cannot gate control.
// Preloaded with --require: unlike --import, it also runs in the eval workers where the core's probes run. CommonJS,
// since a daemon run from the sources has tsx's loader hooks, under which Node cannot require() an ES module.
const childProcess = require('node:child_process')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const promises = require('node:fs/promises')
const { syncBuiltinESMExports } = require('node:module')
const { promisify } = require('node:util')

const blocked = () => !!process.env.HARNESS_DESCRIPTOR_FAULT_FILE && fs.existsSync(process.env.HARNESS_DESCRIPTOR_FAULT_FILE)
const denied = () => Object.assign(new Error('fixture: native descriptor evidence is unavailable'), { code: 'EACCES' })
const isDescriptor = path => /^\/proc\/\d+\/fd$/.test(String(path))
const execFile = childProcess.execFile, execAsync = promisify(execFile)
const rejectProbe = (file, args) => file === 'lsof' && args?.includes('-F0pftDin') && blocked()
const rejectDiscovery = (file, args) => String(file).includes('/process-images/') && args?.[0] === '--paths'
  && process.env.HARNESS_NATIVE_DISCOVERY_FAULT_FILE && fs.existsSync(process.env.HARNESS_NATIVE_DISCOVERY_FAULT_FILE)
childProcess.execFile = function (file, args, ...rest) {
  if (rejectDiscovery(file, args)) {
    const observed = process.env.HARNESS_NATIVE_DISCOVERY_FAULT_FILE + '.observed'
    if (!fs.existsSync(observed)) fs.writeFileSync(observed, String(Date.now()), { mode: 0o600 })
    const child = new EventEmitter(), callback = rest.find(value => typeof value === 'function')
    queueMicrotask(() => {
      callback?.(Object.assign(new Error('fixture optional discovery timeout'), { code: 'ETIMEDOUT' }), '', '')
      child.emit('close', 1)
    })
    return child
  }
  if (!rejectProbe(file, args)) return execFile.call(this, file, args, ...rest)
  const child = new EventEmitter(), callback = rest.find(value => typeof value === 'function')
  queueMicrotask(() => { callback?.(denied(), Buffer.from('p1\0\n'), Buffer.alloc(0)); child.emit('close', 1) })
  return child
}
childProcess.execFile[promisify.custom] = (file, args, ...rest) => rejectProbe(file, args) ? Promise.reject(denied()) : execAsync(file, args, ...rest)
const opendir = promises.opendir, opendirSync = fs.opendirSync
promises.opendir = async function (path, ...rest) {
  if (isDescriptor(path) && blocked()) throw denied()
  return opendir.call(this, path, ...rest)
}
fs.opendirSync = function (path, ...rest) {
  if (isDescriptor(path) && blocked()) throw denied()
  return opendirSync.call(this, path, ...rest)
}
syncBuiltinESMExports()
