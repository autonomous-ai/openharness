/**
 * Secrets blanked in text that leaves the computer or is written where others read it: a log export, a prompt's
 * record, a handoff, a search snippet. In a file of its own: the core's input path loaded the whole log export and
 * its zip writer for this one function (the audit of 2026-11-12).
 */

/** The same denylist the desktop app's `redactSecretsInText` applies — keep the two in step. */
export function redactSecretsInText(input: string): string {
  return input
    .replace(/(Bearer\s+)[A-Za-z0-9._-]{8,}/gi, '$1<redacted>')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-<redacted>')
    .replace(/(["']?\b\w*(?:token|secret|password|passphrase|credential|api[_-]?key)\w*\b["']?\s*[:=]\s*["']?)([^\s"',}]{6,})/gi, '$1<redacted>')
    .replace(/([?&][^=\s&]*(?:token|key|secret|sig|signature)[^=\s&]*=)[^\s&]+/gi, '$1<redacted>')
}
