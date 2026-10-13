import { expect, it } from 'vitest'
import { isManagedHookCommand } from './notifyHooks.js'

it.each([
  "node '/fixture/notify.mjs' --port 19473 --data-dir '/fixture/harness'",
  "'/fixture/node' '/fixture/has space/notify.mjs' --data-dir '/fixture/harness' --port 19473 --engine codex",
  "'/fixture/node' '/fixture/home/.harness/cli/hook/notify.mjs' 19473 codex",
  "node '/fixture/notify.mjs' --port 19473 --data-dir '/fixture/harness' --engine copilot --copilot-event sessionStart",
])('recognizes a literal managed hook protocol: %s', command => {
  expect(isManagedHookCommand(command)).toBe(true)
})

it.each([
  undefined, 42, '', 'node /project/notify.mjs',
  'node /project/notify.mjs --port 19473',
  'echo node /fixture/notify.mjs --port 19473 --data-dir /fixture/harness',
  'node /fixture/notify.mjs --port 19473 --data-dir /fixture/harness; echo foreign',
  'node /fixture/notify.mjs --port 19473 --data-dir /fixture/harness --data-dir /other',
  'node /fixture/notify.mjs --port 19473 --data-dir',
  'node /fixture/notify.mjs --port 19473 --data-dir relative',
  'node /fixture/notify.mjs --port 19473 --data-dir "$HOME"',
  "node '/unterminated/notify.mjs --port 19473 --data-dir /fixture/harness",
])('does not claim a foreign or nonliteral command: %s', command => {
  expect(isManagedHookCommand(command)).toBe(false)
})
