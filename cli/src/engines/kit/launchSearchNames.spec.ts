import { expect, it } from 'vitest'
import { launchSearchNames } from './launchExecutable.js'

it('never looks for an engine named cmd on Windows, where that finds C:\\Windows\\System32\\cmd.exe (F7)', () => {
  expect(launchSearchNames('command-code', ['cmd', 'command-code'], 'win32')).toEqual(['command-code'])
  expect(launchSearchNames('CMD', ['command-code'], 'win32')).toEqual(['command-code'])
})

it('searches every name elsewhere, the command first', () => {
  expect(launchSearchNames('cmd', ['cmd', 'command-code'], 'darwin')).toEqual(['cmd', 'command-code'])
  expect(launchSearchNames('claude', ['claude'], 'win32')).toEqual(['claude'])
})
