import { expect, it } from 'vitest'
import { isMessagesBlock, isMessagesCommand, messagesCommand } from './messagesHook.js'

it.each(['/fixture/messages', "/fixture/space and ' quote"])('recognizes the complete literal Messages protocol at %s', root => {
  const command = messagesCommand(root, '/fixture/runtime/node')
  expect(isMessagesCommand(command)).toBe(true)
  expect(isMessagesBlock({ hooks: [{ type: 'command', command }] })).toBe(true)
  expect(isMessagesBlock({ hooks: [{ type: 'prompt', command }] })).toBe(false)
  expect(isMessagesCommand(command + '; echo foreign')).toBe(false)
  expect(isMessagesCommand(command.replace('--root', '--unrelated'))).toBe(false)
})

it('never infers ownership from a marker, basename, unrelated script or shell expansion', () => {
  const command = messagesCommand('/fixture/messages', '/fixture/runtime/node')
  for (const value of [null, '', 'echo harness-agent-messages', command.replace('/hook.mjs', '/foreign.mjs'),
    command.replace('/fixture/runtime/node', '/fixture/runtime/foreign'), command.replace("'/fixture/runtime/node'", '$(find-node)'),
    messagesCommand('relative', '/fixture/runtime/node'), command + '\0', 'x'.repeat(65537)]) {
    expect(isMessagesCommand(value), String(value).slice(0, 120)).toBe(false)
  }
})
