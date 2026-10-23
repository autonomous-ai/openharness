// Engine hooks are on for Windows (spec section 4): neither the installer nor the Windows run turns them off.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

it.each(['../../../scripts/install.ps1', '../../../scripts/windows-pty-e2e/env.cmd'])('%s leaves engine hooks on', (file) => {
  expect(readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8')).not.toMatch(/DISABLE_HOOK_INSTALL/)
})
