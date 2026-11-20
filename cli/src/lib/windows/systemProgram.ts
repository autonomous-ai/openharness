import { win32 } from 'node:path'

/** One of Windows' own programs by its full path in System32: Node on Windows looks for a bare name in the folder it
 *  runs in before PATH (systemProgram.spec.ts). */
export function systemProgram(name: string, env: NodeJS.ProcessEnv = process.env): string {
  return win32.join(env.SystemRoot ?? env.windir ?? 'C:\\Windows', 'System32', name)
}
