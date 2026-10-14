/** Deterministic kernel and tmux for the emitted hook test. Never queries host processes. */
import fs from 'node:fs'
import childProcess from 'node:child_process'
import http from 'node:http'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'

const root = process.env.HARNESS_ORIGIN_FIXTURE
if (!root) throw Error('A private origin fixture is required')
const mode = process.env.HARNESS_ORIGIN_CASE
let parent = 4101, posted = false
Object.defineProperties(process, { platform: { value: 'linux' }, pid: { value: 4102 }, ppid: { get: () => parent } })
const originalOpen = fs.openSync, originalAsyncOpen = fs.promises.open
const originalReadlink = fs.readlinkSync, originalRequest = http.request
const map = value => {
  const path = String(value)
  if (!path.startsWith('/proc/')) return value
  if (posted) throw Error('The origin must not be recaptured after POST')
  return join(root, path)
}
fs.openSync = (path, ...args) => originalOpen(map(path), ...args)
fs.promises.open = (path, ...args) => mode === 'stuck boot' && String(path).endsWith('/boot_id')
  ? new Promise(() => {}) : originalAsyncOpen(map(path), ...args)
fs.readlinkSync = (path, ...args) => String(path).startsWith('/proc/')
  ? '/fixture/node' : originalReadlink(path, ...args)
childProcess.execFile = (command, ...args) => {
  if (command !== 'tmux') throw Error(`Unexpected native executable: ${command}`)
  // The pane has no routing override. There is no real tmux invocation.
  queueMicrotask(() => args.at(-1)(null, '999|fixture-session|\n', ''))
  return { kill() {} }
}
http.request = (...args) => {
  posted = true
  if (mode === 'late reparent') parent = 1
  return originalRequest(...args)
}
syncBuiltinESMExports()
