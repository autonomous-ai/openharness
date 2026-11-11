import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PTY_PAYLOAD_FILES } from './ptyPayload.js'
import { expectedSigner, parseSignatureRows, readSignatureProblems, signatureProblems, unsignedAllowed, type PowershellAsync } from './ptySignatures.js'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const valid = (name: string) => ({ name, status: 'Valid', signer: expectedSigner(name) })

describe('signatureProblems', () => {
  it('passes a payload whose files are ours, and ConPTY Microsoft\'s, all Valid', () => {
    expect(signatureProblems(PTY_PAYLOAD_FILES, PTY_PAYLOAD_FILES.map(valid))).toEqual([])
    expect(expectedSigner('harness-launch.exe')).toBe('AUTONOMOUS INC.')
    expect(expectedSigner('OpenConsole.exe')).toBe('Microsoft Corporation')
  })

  it('names each file that is unsigned, changed after signing, by another signer, or not read at all', () => {
    const rows = PTY_PAYLOAD_FILES.map(valid)
      .map((row) => (row.name === 'harness-launch.exe' ? { ...row, status: 'NotSigned', signer: '' } : row))
      .map((row) => (row.name === 'harness.exe' ? { ...row, status: 'HashMismatch' } : row))
      .map((row) => (row.name === 'conpty.dll' ? { ...row, signer: 'AUTONOMOUS INC.' } : row))
      .filter((row) => row.name !== 'harness-tui.exe')
    expect(signatureProblems(PTY_PAYLOAD_FILES, rows)).toEqual([
      'harness-launch.exe is NotSigned',
      'harness.exe is HashMismatch',
      "conpty.dll is signed by 'AUTONOMOUS INC.', not 'Microsoft Corporation'",
      'harness-tui.exe was not read',
    ])
  })
})

describe('parseSignatureRows', () => {
  it('reads name, status and signer per line, with or without a signer, and leaves out any other line', () => {
    expect(parseSignatureRows('harness.exe\tValid\tAUTONOMOUS INC.\r\nharness-launch.exe\tNotSigned\t\r\nnoise\n')).toEqual([
      { name: 'harness.exe', status: 'Valid', signer: 'AUTONOMOUS INC.' },
      { name: 'harness-launch.exe', status: 'NotSigned', signer: '' },
    ])
  })
})

describe('readSignatureProblems', () => {
  it('hands PowerShell the folder and the names in its environment, never in the script, and judges its rows', async () => {
    const calls: Array<{ script: string; inputs: Record<string, string> }> = []
    const run: PowershellAsync = async (script, inputs) => {
      calls.push({ script, inputs })
      return { status: 0, stdout: PTY_PAYLOAD_FILES.map((name) => `${name}\tValid\t${expectedSigner(name)}`).join('\r\n'), stderr: '' }
    }
    const dir = "C:\\Users\\Jö 日 & 'co'\\.harness\\runtime\\pty\\.staging-1"
    await expect(readSignatureProblems(dir, PTY_PAYLOAD_FILES, run)).resolves.toEqual([])
    expect(calls[0]!.inputs).toEqual({ HARNESS_SIGNATURE_DIR: dir, HARNESS_SIGNATURE_FILES: PTY_PAYLOAD_FILES.join('\n') })
    expect(calls[0]!.script).not.toContain('staging')
    // Its own copy of the module, by path: never what a PowerShell 7 PSModulePath would autoload.
    expect(calls[0]!.script).toContain("Import-Module -Name (Join-Path $PSHOME 'Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1')")
  })

  it('throws, and never passes, when PowerShell could not read them', async () => {
    const failed: PowershellAsync = async () => ({ status: 1, stdout: '', stderr: 'Import-Module: not found' })
    await expect(readSignatureProblems('C:\\x', PTY_PAYLOAD_FILES, failed)).rejects.toThrow("could not read the payload's signatures: Import-Module: not found")
    const notStarted: PowershellAsync = async () => ({ status: null, stdout: '', stderr: '', error: new Error('spawn ENOENT') })
    await expect(readSignatureProblems('C:\\x', PTY_PAYLOAD_FILES, notStarted)).rejects.toThrow('spawn ENOENT')
  })

  // Windows itself: a text file is no program (UnknownError; an unsigned program is NotSigned), and node.exe is Valid
  // but the OpenJS Foundation's.
  it.runIf(process.platform === 'win32')('reads real signatures through Windows PowerShell', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'harness-pty-sig-'))
    dirs.push(dir)
    writeFileSync(join(dir, 'harness.exe'), 'not a program')
    writeFileSync(join(dir, 'harness-launch.exe'), readFileSync(process.execPath))
    await expect(readSignatureProblems(dir, ['harness.exe', 'harness-launch.exe'])).resolves.toEqual([
      'harness.exe is UnknownError',
      "harness-launch.exe is signed by 'OpenJS Foundation', not 'AUTONOMOUS INC.'",
    ])
  }, 60_000)
})

describe('unsignedAllowed', () => {
  it('only for HARNESS_ALLOW_UNSIGNED=1', () => {
    expect(unsignedAllowed({ HARNESS_ALLOW_UNSIGNED: '1' })).toBe(true)
    expect(unsignedAllowed({ HARNESS_ALLOW_UNSIGNED: 'true' })).toBe(false)
    expect(unsignedAllowed({})).toBe(false)
  })
})
