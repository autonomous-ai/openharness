/**
 * The terminal host payload's Authenticode signatures, checked before the updater runs any of its files.
 *
 * Smart App Control (Windows 11) blocks a program without a valid signature. From 2026-11-04 to 11-09 production
 * named an unsigned host, and on a computer with it on, the blocked harness-launch.exe left Harness unable to start,
 * so unable to update itself. install.ps1 (Assert-HarnessPtySigned) refuses such a host on install, release.yml
 * (pty-signatures) before promotion, and this before an update: a payload is staged only when every file is signed by
 * its signer, on every computer, not only on one whose Smart App Control would block the canary.
 */
import { runPowershellAsync, type PowershellResult } from './powershell.js'

/** The certificate name our files are signed with (docs/windows-code-signing.md); install.ps1 $HarnessPublisher. */
export const WINDOWS_PUBLISHER = 'AUTONOMOUS INC.'
/** ConPTY's two files, Microsoft's own and signed by Microsoft; install.ps1 $HarnessMicrosoftFiles. */
export const MICROSOFT_PAYLOAD_FILES: readonly string[] = ['conpty.dll', 'OpenConsole.exe']
const MICROSOFT_PUBLISHER = 'Microsoft Corporation'

/** A file's signature as Get-AuthenticodeSignature reads it: its status (`Valid`, `NotSigned`, `HashMismatch`, ...) and
 *  the signer certificate's simple name, empty when there is none. */
export interface SignatureRow { name: string; status: string; signer: string }

/** The signer [name] must carry. */
export function expectedSigner(name: string): string {
  return MICROSOFT_PAYLOAD_FILES.includes(name) ? MICROSOFT_PUBLISHER : WINDOWS_PUBLISHER
}

/** One line per file in [files] whose row is missing, not Valid, or by another signer; none when all are right. */
export function signatureProblems(files: readonly string[], rows: readonly SignatureRow[]): string[] {
  const problems: string[] = []
  for (const name of files) {
    const row = rows.find((one) => one.name === name)
    const want = expectedSigner(name)
    if (!row) problems.push(`${name} was not read`)
    else if (row.status !== 'Valid') problems.push(`${name} is ${row.status}`)
    else if (row.signer !== want) problems.push(`${name} is signed by '${row.signer}', not '${want}'`)
  }
  return problems
}

/**
 * One tab-separated line per file: name, status, signer. Windows itself judges Valid (the chain, the timestamp, the
 * bytes), as Smart App Control does. Get-AuthenticodeSignature's module is imported by its path in this PowerShell's
 * own folder: a PowerShell 7 PSModulePath handed to the daemon would make autoload take 7's (install.ps1 says why).
 * Plain lines, so no other module is needed to print them.
 */
const SIGNATURES_SCRIPT = [
  "Import-Module -Name (Join-Path $PSHOME 'Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1')",
  'foreach ($name in ($env:HARNESS_SIGNATURE_FILES -split "`n")) {',
  '  $signature = Get-AuthenticodeSignature -LiteralPath (Join-Path $env:HARNESS_SIGNATURE_DIR $name)',
  "  $signer = if ($signature.SignerCertificate) { $signature.SignerCertificate.GetNameInfo('SimpleName', $false) } else { '' }",
  '  [Console]::Out.WriteLine("$name`t$($signature.Status)`t$signer")',
  '}',
].join('\n')

/** Parse the script's lines; a line that is not three fields is left out, so its file is "not read". */
export function parseSignatureRows(stdout: string): SignatureRow[] {
  const rows: SignatureRow[] = []
  for (const line of stdout.split(/\r?\n/)) {
    const fields = line.split('\t')
    if (fields.length === 3) rows.push({ name: fields[0]!, status: fields[1]!, signer: fields[2]! })
  }
  return rows
}

export type PowershellAsync = (script: string, inputs: Record<string, string>) => Promise<PowershellResult>

/**
 * The problems with the signatures of [files] in [dir] (Windows). Throws when PowerShell could not read them, which
 * the updater treats as transient (it asks again at the next check), never as a pass.
 */
export async function readSignatureProblems(dir: string, files: readonly string[], run: PowershellAsync = runPowershellAsync): Promise<string[]> {
  const result = await run(SIGNATURES_SCRIPT, { HARNESS_SIGNATURE_DIR: dir, HARNESS_SIGNATURE_FILES: files.join('\n') })
  if (result.status !== 0) {
    const why = result.stderr.trim() || result.error?.message || `exit ${result.status ?? 'without a status'}`
    throw new Error(`could not read the payload's signatures: ${why}`)
  }
  return signatureProblems(files, parseSignatureRows(result.stdout))
}

/** HARNESS_ALLOW_UNSIGNED=1 is for a developer's own build on a test computer (docs/windows-code-signing.md). */
export function unsignedAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.HARNESS_ALLOW_UNSIGNED === '1'
}
