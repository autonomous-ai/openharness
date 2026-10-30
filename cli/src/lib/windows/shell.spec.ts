import { describe, expect, it } from 'vitest'
import { defaultWindowsShell } from './shell.js'

describe('defaultWindowsShell', () => {
  it('prefers pwsh, then Windows PowerShell, then cmd', () => {
    expect(defaultWindowsShell((b) => b === 'pwsh.exe' ? 'C:/pwsh.exe' : null)).toEqual(['pwsh.exe', '-NoLogo'])
    expect(defaultWindowsShell((b) => b === 'powershell.exe' ? 'C:/ps.exe' : null)).toEqual(['powershell.exe', '-NoLogo'])
    expect(defaultWindowsShell(() => null)).toEqual([process.env.ComSpec ?? 'cmd.exe'])
  })

  it('takes pwsh over Windows PowerShell when both are there', () => {
    expect(defaultWindowsShell(() => true)).toEqual(['pwsh.exe', '-NoLogo'])
  })

  it.runIf(process.platform === 'win32')('finds Windows PowerShell on a real Windows PATH', () => {
    // Every Windows has System32\WindowsPowerShell\v1.0 on PATH; pwsh only when installed.
    expect(defaultWindowsShell()[0]).toMatch(/^(?:pwsh|powershell)\.exe$/)
  })
})
