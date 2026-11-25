/**
 * An engine settings file's bytes as its text: UTF-8 without one leading BOM. Windows PowerShell 5's
 * `Set-Content -Encoding utf8` starts the file with one, which JSON.parse refuses, and Claude Code and Codex read the
 * file either way (docs/plans/2026-11-25-win-hook-admission-design.md, D). Throws on bytes that are not UTF-8, so a
 * UTF-16 file (`Out-File`'s default) is never read, nor rewritten, as mojibake.
 */
export function settingsText(bytes: Uint8Array): string {
  // TextDecoder drops one leading BOM unless told to keep it.
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}
