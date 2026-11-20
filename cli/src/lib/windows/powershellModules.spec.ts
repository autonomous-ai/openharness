/**
 * Every PowerShell script the CLI runs from these files turns module autoload off before its first command, then imports
 * each module it calls by its folder in Windows PowerShell's own $PSHOME (`modulesByPath`, ./powershell.ts). With
 * autoload on, the first command a 5.1 process had to find cost it 22-29 s on windows-11-arm (docs/windows-rules.md);
 * with it off, a command of a module not imported is "not recognized". Read as text, so this names that before Windows
 * does; windows.yml runs the scripts themselves (peerAccount.windows.real.spec.ts and the other real specs).
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
import { buildWindowsGuestInstallScript, buildWindowsGuestProcessorScript } from './guestScript.js'
import { modulesByPath, type PowershellModule } from './powershell.js'
import { SIGNATURES_SCRIPT } from './ptySignatures.js'
import { SCRIPT as STORE_PACKAGE_SCRIPT } from './storePackage.js'

const AUTOLOAD_OFF = "$PSModuleAutoLoadingPreference = 'None'"
/** Microsoft.PowerShell.Core's: in every session, autoload or not. */
const CORE = new Set(['ForEach-Object', 'Import-Module', 'Out-Null', 'Where-Object'])
/** Where Windows PowerShell 5.1 keeps each command these scripts call. */
const MODULES: Record<PowershellModule, readonly string[]> = {
  'Microsoft.PowerShell.Management': ['Copy-Item', 'Get-ChildItem', 'Get-Content', 'Get-Item', 'Get-ItemProperty', 'Join-Path', 'Move-Item',
    'New-Item', 'New-ItemProperty', 'Remove-Item', 'Remove-ItemProperty', 'Set-Content', 'Split-Path', 'Stop-Process', 'Test-Path'],
  'Microsoft.PowerShell.Utility': ['Add-Type', 'ConvertFrom-Json', 'ConvertTo-Json', 'Get-Date', 'New-Object', 'Select-Object', 'Sort-Object', 'Start-Sleep'],
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
const BY_PATH = /^Import-Module -Name "\$PSHOME\\Modules\\([\w.]+)"$/

/**
 * What is wrong with [script]: a command that runs before autoload is off, one whose module is not imported before it,
 * one no module here is known to hold, an import by any other path, and a module imported for none of its commands.
 */
function problems(script: string): string[] {
  // A comment line names commands too, and runs none.
  const code = script.split('\n').filter((line) => !line.trimStart().startsWith('#')).join('\n')
  const own = new Set([...code.matchAll(/\bfunction\s+([A-Za-z]+-[A-Za-z]+)/g)].map((match) => match[1]!))
  const off = code.indexOf(AUTOLOAD_OFF)
  const found = new Set<string>()
  const imported = new Map<string, number>()
  for (const match of code.matchAll(/Import-Module\b[^\n;]*/g)) {
    const module = BY_PATH.exec(match[0].trim())?.[1]
    if (module) imported.set(module, match.index)
    else found.add(`${match[0].trim()} is not by its folder in $PSHOME`)
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
  for (const module of imported.keys()) if (!used.has(module)) found.add(`${module} is imported for none of its commands`)
  return [...found]
}

const OWNER = { owner: 'owner', ownerHome: 'C:\\Users\\owner', ownerSid: 'S-1-5-21-1111111111-2222222222-3333333333-1001' }
/** Every script these files run, by the file that holds it (from cli/src). */
const SCRIPTS: Record<string, Record<string, () => string>> = {
  'lib/peerAccount.ts': { windowsPeerQuery: () => windowsPeerQuery(1, 2).script, windowsListenerQuery: () => windowsListenerQuery(1).script },
  'lib/signOut.ts': { windowsProcessQuery: () => windowsProcessQuery(1) },
  'lib/uninstall/removal.ts': { START_OUTSIDE_JOB: () => START_OUTSIDE_JOB },
  'lib/uninstall/windowsPath.ts': { READ_USER_PATH: () => READ_USER_PATH, WRITE_USER_PATH: () => WRITE_USER_PATH },
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
const rows = Object.entries(SCRIPTS).flatMap(([file, scripts]) => Object.entries(scripts).map(([name, script]) => [file, name, script] as const))

describe('the check', () => {
  it('names a command that runs before autoload is off, Core ones too', () => {
    expect(problems(`Where-Object { $_ }\n${AUTOLOAD_OFF}`)).toEqual(['Where-Object runs with autoload on'])
  })

  it('names a Management or Utility command whose module is not imported before it', () => {
    expect(problems(`${AUTOLOAD_OFF}\nJoin-Path $a 'b' | Select-Object -First 1\nImport-Module -Name "$PSHOME\\Modules\\Microsoft.PowerShell.Utility"`)).toEqual([
      'Join-Path needs Microsoft.PowerShell.Management imported before it',
      'Select-Object needs Microsoft.PowerShell.Utility imported before it',
    ])
  })

  it('names a command no module here is known to hold', () => {
    expect(problems(`${AUTOLOAD_OFF}\nGet-HarnessThing`)).toEqual(['Get-HarnessThing is in no module this spec knows'])
  })

  it('names an import by any other path, and a module imported for none of its commands', () => {
    expect(problems([AUTOLOAD_OFF, "Import-Module -Name (Join-Path $PSHOME 'Modules\\Appx\\Appx.psd1')",
      'Import-Module -Name "$PSHOME\\Modules\\NetTCPIP"'].join('\n'))).toEqual([
      "Import-Module -Name (Join-Path $PSHOME 'Modules\\Appx\\Appx.psd1') is not by its folder in $PSHOME",
      'Join-Path needs Microsoft.PowerShell.Management imported before it',
      'NetTCPIP is imported for none of its commands',
    ])
  })

  it("takes Core commands, the script's own functions and its comments", () => {
    expect(problems(`# Get-HarnessThing\n${AUTOLOAD_OFF}\nfunction Get-Own { 1 }\nGet-Own | ForEach-Object { $_ } | Out-Null`)).toEqual([])
  })
})

describe('PowerShell scripts import their modules by path, with autoload off', () => {
  it('modulesByPath turns autoload off, then imports each module by its folder in $PSHOME', () => {
    expect(modulesByPath('Microsoft.PowerShell.Utility', 'NetTCPIP')).toBe([
      AUTOLOAD_OFF,
      'Import-Module -Name "$PSHOME\\Modules\\Microsoft.PowerShell.Utility"',
      'Import-Module -Name "$PSHOME\\Modules\\NetTCPIP"',
    ].join('\n'))
  })

  it.each(rows)('%s %s', (_file, _name, script) => {
    expect(problems(script())).toEqual([])
  })

  // Management and Utility are left out: many files call those, and this table holds the scripts that call the rest.
  it('every file under cli/src that names a command of another module is in the table', () => {
    const src = fileURLToPath(new URL('../..', import.meta.url))
    const others = Object.entries(MODULES)
      .filter(([module]) => module !== 'Microsoft.PowerShell.Management' && module !== 'Microsoft.PowerShell.Utility')
      .flatMap(([, cmdlets]) => cmdlets)
    const naming = readdirSync(src, { recursive: true, encoding: 'utf8' })
      .map((file) => file.split('\\').join('/'))
      .filter((file) => /\.(ts|mts|js|mjs)$/.test(file) && !/\.(spec|test)\.ts$/.test(file))
      .filter((file) => { const text = readFileSync(join(src, file), 'utf8'); return others.some((cmdlet) => text.includes(cmdlet)) })
    expect(naming.length).toBeGreaterThan(0)
    expect(naming.filter((file) => !(file in SCRIPTS))).toEqual([])
  })
})
