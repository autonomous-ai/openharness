import { describe, expect, it } from 'vitest'
import { runPowershell } from '../windows/powershell.js'
import { removeUserPathEntry } from './windowsPath.js'

// The real registry, on Windows only: a value of this test's own beside Path, never Path itself.
describe.runIf(process.platform === 'win32')('removeUserPathEntry on this account', () => {
  it('removes the folder from an ExpandString value and keeps its other entries unexpanded', () => {
    const name = `HarnessUninstallTest${process.pid}`
    const set = runPowershell(`[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true).SetValue('${name}', '%USERPROFILE%\\x;%USERPROFILE%\\.harness\\bin', [Microsoft.Win32.RegistryValueKind]::ExpandString)`)
    expect(set.status, set.stderr).toBe(0)
    try {
      expect(removeUserPathEntry(`${process.env.USERPROFILE}\\.harness\\bin`, runPowershell, process.env, name).state).toBe('removed')
      const read = runPowershell(`$k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment'); [Console]::Out.Write($k.GetValue('${name}', '', 'DoNotExpandEnvironmentNames') + '|' + $k.GetValueKind('${name}'))`)
      expect(read.stdout).toBe('%USERPROFILE%\\x|ExpandString')
    } finally {
      runPowershell(`[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true).DeleteValue('${name}', $false)`)
    }
  })

  it('removes a folder under a non-ASCII profile, and keeps a non-ASCII entry byte for byte', () => {
    const name = `HarnessUninstallTestU${process.pid}`
    const profile = 'C:\\Users\\J\u00f6 \u65e5'
    const kept = `${profile}\\tools`
    const inputs = { HARNESS_TEST_NAME: name, HARNESS_TEST_VALUE: `${kept};${profile}\\.harness\\bin` }
    const set = runPowershell(`[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true).SetValue($env:HARNESS_TEST_NAME, $env:HARNESS_TEST_VALUE, [Microsoft.Win32.RegistryValueKind]::ExpandString)`, inputs)
    expect(set.status, set.stderr).toBe(0)
    try {
      expect(removeUserPathEntry(`${profile}\\.harness\\bin`, runPowershell, process.env, name).state).toBe('removed')
      const read = runPowershell(`[Console]::Out.Write([Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment').GetValue($env:HARNESS_TEST_NAME, '', 'DoNotExpandEnvironmentNames'))`, inputs)
      expect(read.stdout).toBe(kept)
    } finally {
      runPowershell(`[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true).DeleteValue($env:HARNESS_TEST_NAME, $false)`, inputs)
    }
  })
})
