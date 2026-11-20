/**
 * Every PowerShell script the CLI runs from these files turns module autoload off before its first command, then imports
 * each module it calls by its folder in Windows PowerShell's own $PSHOME (`modulesByPath`, ./powershell.ts). With
 * autoload on, the first command a 5.1 process had to find cost it 22-29 s on windows-11-arm (docs/windows-rules.md);
 * with it off, a command of a module not imported is "not recognized". Read as text, so this names that before Windows
 * does; windows.yml runs the scripts themselves (peerAccount.windows.real.spec.ts and the other real specs).
 *
 * Importing a module can run commands of another: CimCmdlets' Set-Alias (its OnImport, CimCmdletModuleInitialize.cs in
 * PowerShell's source), NetTCPIP's New-Alias (NetIPConfiguration.psm1 and Test-NetConnection.psm1, beside its CDXML) and
 * Appx's Set-Alias (Appx.psm1), all Utility's. With autoload off and no Utility, those imports stopped the peer,
 * listener and uninstall scripts on both Windows runners (windows.yml run 44827687986: "The term 'New-Alias' is not
 * recognized"). So Utility is the first module every such script imports.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildWindowsRemoveScript } from '../../team/windowsRemoveScript.js'
import { windowsListenerQuery, windowsPeerQuery } from '../peerAccount.js'
import { windowsProcessQuery } from '../signOut.js'
import { START_OUTSIDE_JOB } from '../uninstall/removal.js'
import { READ_USER_PATH, WRITE_USER_PATH } from '../uninstall/windowsPath.js'
import { ELEVATED_PS1, uacPromptScript } from './elevated.js'
import { buildWindowsGuestInstallScript, buildWindowsGuestProcessorScript } from './guestScript.js'
import { modulesByPath, POWERSHELL_PRELUDE, type PowershellModule } from './powershell.js'
import { SIGNATURES_SCRIPT } from './ptySignatures.js'
import { SCRIPT as STORE_PACKAGE_SCRIPT } from './storePackage.js'

const AUTOLOAD_OFF = "$PSModuleAutoLoadingPreference = 'None'"
const UTILITY = 'Microsoft.PowerShell.Utility'
const UTILITY_FIRST = `${AUTOLOAD_OFF}\nImport-Module -Name "$PSHOME\\Modules\\${UTILITY}" -ErrorAction Stop`
/** Microsoft.PowerShell.Core's: in every session, autoload or not. */
const CORE = new Set(['ForEach-Object', 'Import-Module', 'Out-Null', 'Where-Object'])
/** Where Windows PowerShell 5.1 keeps each command these scripts call. */
const MODULES: Record<PowershellModule, readonly string[]> = {
  'Microsoft.PowerShell.Management': ['Copy-Item', 'Get-ChildItem', 'Get-Content', 'Get-Item', 'Get-ItemProperty', 'Join-Path', 'Move-Item',
    'New-Item', 'New-ItemProperty', 'Remove-Item', 'Remove-ItemProperty', 'Set-Content', 'Split-Path', 'Start-Process', 'Stop-Process', 'Test-Path'],
  'Microsoft.PowerShell.Utility': ['Add-Type', 'ConvertFrom-Json', 'ConvertTo-Json', 'Get-Date', 'New-Object', 'Out-File', 'Select-Object', 'Sort-Object', 'Start-Sleep'],
  'Microsoft.PowerShell.Security': ['Get-Acl', 'Get-AuthenticodeSignature'],
  'Microsoft.PowerShell.LocalAccounts': ['Add-LocalGroupMember', 'Get-LocalGroup', 'Get-LocalGroupMember', 'Get-LocalUser', 'New-LocalGroup',
    'New-LocalUser', 'Remove-LocalGroupMember', 'Remove-LocalUser'],
  CimCmdlets: ['Get-CimInstance', 'Invoke-CimMethod', 'New-CimInstance', 'Remove-CimInstance'],
  NetTCPIP: ['Get-NetTCPConnection'],
  Appx: ['Get-AppxPackage'],
  ScheduledTasks: ['Disable-ScheduledTask', 'Enable-ScheduledTask', 'Get-ScheduledTask', 'Start-ScheduledTask', 'Stop-ScheduledTask',
    'Unregister-ScheduledTask'],
}
const moduleOf = new Map(Object.entries(MODULES).flatMap(([module, cmdlets]) => cmdlets.map((cmdlet) => [cmdlet, module] as const)))
const CMDLET = /(?<![\w$.-])[A-Z][A-Za-z]+-[A-Z][A-Za-z0-9]+(?![\w-])/g
const BY_PATH = /^Import-Module -Name "\$PSHOME\\Modules\\([\w.]+)"( -ErrorAction Stop)?$/

/**
 * What is wrong with [script]: a command that runs before autoload is off, one whose module is not imported before it,
 * one no module here is known to hold, an import by any other path or one that goes on when it fails, a script that
 * turns autoload off and imports another module, or none, before Utility, and a module but Utility imported for none of
 * its commands.
 */
function problems(script: string): string[] {
  // A comment line names commands too, and runs none.
  const code = script.split('\n').filter((line) => !line.trimStart().startsWith('#')).join('\n')
  const own = new Set([...code.matchAll(/\bfunction\s+([A-Za-z]+-[A-Za-z]+)/g)].map((match) => match[1]!))
  const off = code.indexOf(AUTOLOAD_OFF)
  const found = new Set<string>()
  const imported = new Map<string, number>()
  for (const match of code.matchAll(/Import-Module\b[^\n;]*/g)) {
    const [, module, stops] = BY_PATH.exec(match[0].trim()) ?? []
    if (!module) { found.add(`${match[0].trim()} is not by its folder in $PSHOME`); continue }
    // Before a script's own `$ErrorActionPreference = 'Stop'`, and under -File, a failed import is only printed.
    if (!stops) found.add(`${match[0].trim()} goes on when it fails`)
    imported.set(module, match.index)
  }
  const used = new Set<string>()
  for (const match of code.matchAll(CMDLET)) {
    const cmdlet = match[0]
    if (own.has(cmdlet)) continue
    if (off < 0 || match.index < off) found.add(`${cmdlet} runs with autoload on`)
    if (CORE.has(cmdlet)) continue
    const module = moduleOf.get(cmdlet)
    if (!module) { found.add(`${cmdlet} is in no module this spec knows`); continue }
    used.add(module)
    if (!(imported.get(module)! < match.index)) found.add(`${cmdlet} needs ${module} imported before it`)
  }
  if (off >= 0 && imported.keys().next().value !== UTILITY) found.add(`${UTILITY} is not the first module imported`)
  for (const module of imported.keys()) if (module !== UTILITY && !used.has(module)) found.add(`${module} is imported for none of its commands`)
  return [...found]
}

const OWNER = { owner: 'owner', ownerHome: 'C:\\Users\\owner', ownerSid: 'S-1-5-21-1111111111-2222222222-3333333333-1001' }
/** Every script these files run, by the file that holds it (from cli/src). */
const SCRIPTS: Record<string, Record<string, () => string>> = {
  'lib/peerAccount.ts': { windowsPeerQuery: () => windowsPeerQuery(1, 2).script, windowsListenerQuery: () => windowsListenerQuery(1).script },
  'lib/signOut.ts': { windowsProcessQuery: () => windowsProcessQuery(1) },
  'lib/uninstall/removal.ts': { START_OUTSIDE_JOB: () => START_OUTSIDE_JOB },
  'lib/uninstall/windowsPath.ts': { READ_USER_PATH: () => READ_USER_PATH, WRITE_USER_PATH: () => WRITE_USER_PATH },
  'lib/windows/elevated.ts': { uacPromptScript: () => uacPromptScript('C:\\Users\\owner\\AppData\\Local\\Temp\\harness-admin-1\\elevated.ps1'), ELEVATED_PS1: () => ELEVATED_PS1 },
  'lib/windows/guestScript.ts': {
    install: () => buildWindowsGuestInstallScript({ ...OWNER, processor: '', version: '1.2.3' }),
    processor: () => buildWindowsGuestProcessorScript(OWNER),
  },
  'lib/windows/ptySignatures.ts': { SIGNATURES_SCRIPT: () => SIGNATURES_SCRIPT },
  'lib/windows/storePackage.ts': { SCRIPT: () => STORE_PACKAGE_SCRIPT },
  'team/windowsRemoveScript.ts': {
    buildWindowsRemoveScript: () => buildWindowsRemoveScript({ user: 'harnessteam', home: 'C:\\Users\\harnessteam', owner: 'owner', ownerHome: OWNER.ownerHome }),
  },
}
/** Files that start a powershell.exe whose script is not one this table holds, and why. A vendor's installer keeps
 *  autoload on: it may call any module (docs/windows-rules.md). */
const NOT_IN_THE_TABLE: Record<string, string> = {
  'engines/kit/windowsInstall.ts': "an engine vendor's installer",
  'lib/gridInstall.ts': "grid's installer",
  'lib/flash.ts': 'the flasher, a script the website serves',
  'lib/windows/powershell.ts': 'the runner: each script is its caller\'s',
  'lib/uninstall/deps.ts': "it runs windowsPath.ts's scripts",
  'lib/windows/shell.ts': "a pane's shell, where a person types any command",
  'lib/terminalBackend.contract.ts': "a test pane's shell",
  'testing/windowsPowerShell.ts': "the specs' own scripts",
}
const rows = Object.entries(SCRIPTS).flatMap(([file, scripts]) => Object.entries(scripts).map(([name, script]) => [file, name, script] as const))

describe('the check', () => {
  it('names a command that runs before autoload is off, Core ones too', () => {
    expect(problems(`Where-Object { $_ }\n${UTILITY_FIRST}`)).toEqual(['Where-Object runs with autoload on'])
  })

  it('names a Management or Utility command whose module is not imported before it', () => {
    expect(problems(`${AUTOLOAD_OFF}\nJoin-Path $a 'b' | Select-Object -First 1\nImport-Module -Name "$PSHOME\\Modules\\Microsoft.PowerShell.Utility" -ErrorAction Stop`)).toEqual([
      'Join-Path needs Microsoft.PowerShell.Management imported before it',
      'Select-Object needs Microsoft.PowerShell.Utility imported before it',
    ])
  })

  it('names a command no module here is known to hold', () => {
    expect(problems(`${UTILITY_FIRST}\nGet-HarnessThing`)).toEqual(['Get-HarnessThing is in no module this spec knows'])
  })

  it('names an import by any other path, and a module imported for none of its commands', () => {
    expect(problems([UTILITY_FIRST, "Import-Module -Name (Join-Path $PSHOME 'Modules\\Appx\\Appx.psd1')",
      'Import-Module -Name "$PSHOME\\Modules\\NetTCPIP" -ErrorAction Stop'].join('\n'))).toEqual([
      "Import-Module -Name (Join-Path $PSHOME 'Modules\\Appx\\Appx.psd1') is not by its folder in $PSHOME",
      'Join-Path needs Microsoft.PowerShell.Management imported before it',
      'NetTCPIP is imported for none of its commands',
    ])
  })

  it('names an import that goes on when it fails', () => {
    expect(problems([UTILITY_FIRST, 'Import-Module -Name "$PSHOME\\Modules\\Microsoft.PowerShell.Management"', 'Join-Path $a b'].join('\n'))).toEqual([
      'Import-Module -Name "$PSHOME\\Modules\\Microsoft.PowerShell.Management" goes on when it fails',
    ])
  })

  it("takes Core commands, the script's own functions and its comments", () => {
    expect(problems(`# Get-HarnessThing\n${UTILITY_FIRST}\nfunction Get-Own { 1 }\nGet-Own | ForEach-Object { $_ } | Out-Null`)).toEqual([])
  })

  it('names a script that turns autoload off and imports another module, or none, before Utility', () => {
    expect(problems([AUTOLOAD_OFF, 'Import-Module -Name "$PSHOME\\Modules\\CimCmdlets" -ErrorAction Stop', 'Get-CimInstance Win32_Process'].join('\n')))
      .toEqual([`${UTILITY} is not the first module imported`])
    expect(problems(`${AUTOLOAD_OFF}\n[Console]::Out.Write('x')`)).toEqual([`${UTILITY} is not the first module imported`])
  })
})

describe('PowerShell scripts import their modules by path, with autoload off', () => {
  it('modulesByPath turns autoload off, then imports Utility and each module by its folder in $PSHOME, stopping if one fails', () => {
    expect(modulesByPath('NetTCPIP')).toBe([
      AUTOLOAD_OFF,
      'Import-Module -Name "$PSHOME\\Modules\\Microsoft.PowerShell.Utility" -ErrorAction Stop',
      'Import-Module -Name "$PSHOME\\Modules\\NetTCPIP" -ErrorAction Stop',
    ].join('\n'))
  })

  it.each(rows)('%s %s', (_file, _name, script) => {
    expect(problems(script())).toEqual([])
  })

  // runPowershell puts it before each script, where autoload is still on.
  it('the prelude calls no command', () => {
    expect(problems(POWERSHELL_PRELUDE)).toEqual([])
  })

  const src = fileURLToPath(new URL('../..', import.meta.url))
  const sources = readdirSync(src, { recursive: true, encoding: 'utf8' })
    .map((file) => file.split('\\').join('/'))
    .filter((file) => /\.(ts|mts|js|mjs)$/.test(file) && !/\.(spec|test)\.ts$/.test(file))
    .map((file) => [file, readFileSync(join(src, file), 'utf8')] as const)

  // Management and Utility are left out: many files call those, and this table holds the scripts that call the rest.
  it('every file under cli/src that names a command of another module is in the table', () => {
    const others = Object.entries(MODULES)
      .filter(([module]) => module !== 'Microsoft.PowerShell.Management' && module !== 'Microsoft.PowerShell.Utility')
      .flatMap(([, cmdlets]) => cmdlets)
    const naming = sources.filter(([, text]) => others.some((cmdlet) => text.includes(cmdlet))).map(([file]) => file)
    expect(naming.length).toBeGreaterThan(0)
    expect(naming.filter((file) => !(file in SCRIPTS))).toEqual([])
  })

  // A script of Management and Utility alone pays autoload as much as any: the elevation wrapper's two did, before the
  // person's prompt.
  it('every file under cli/src that starts a powershell.exe is in the table, or says why its script is not', () => {
    const starting = sources.filter(([, text]) => /powershell\.exe['"`]|powershellPath\(|runPowershell/.test(text)).map(([file]) => file)
    expect(starting.length).toBeGreaterThan(0)
    expect(starting.filter((file) => !(file in SCRIPTS) && !(file in NOT_IN_THE_TABLE))).toEqual([])
    // A file listed here that no longer starts one goes from the list.
    expect(Object.keys(NOT_IN_THE_TABLE).filter((file) => !starting.includes(file))).toEqual([])
  })
})
