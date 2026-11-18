// PR CI's typecheck reads cli/src alone (tsconfig.json's rootDir), so the VS Code extension's sources are checked here,
// on the CLI's installed TypeScript and VS Code's types.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const EXTENSION = fileURLToPath(new URL('../../../plugins/harness-device-vscode/', import.meta.url))

function where(diagnostic: ts.Diagnostic): string {
  if (!diagnostic.file || diagnostic.start === undefined) return ''
  const { line } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
  return `${relative(EXTENSION, diagnostic.file.fileName)}:${line + 1}: `
}

describe('the Harness Device extension for VS Code', () => {
  it("typechecks against VS Code 1.75's API", () => {
    // The API at the manifest's engines floor: types of a later VS Code would let a call 1.75 lacks pass.
    expect(createRequire(import.meta.url)('@types/vscode/package.json').version).toMatch(/^1\.75\./)
    const config = ts.getParsedCommandLineOfConfigFile(join(EXTENSION, 'tsconfig.json'), {}, {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
        throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
      },
    })!
    const program = ts.createProgram({ rootNames: config.fileNames, options: config.options })
    const diagnostics = [...config.errors, ...ts.getPreEmitDiagnostics(program)]
    expect(diagnostics.map((diagnostic) => where(diagnostic) + ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))).toEqual([])
  })

  it('its manifest contributes nothing and wakes at startup alone', () => {
    const manifest = JSON.parse(readFileSync(join(EXTENSION, 'package.json'), 'utf8'))
    expect(`${manifest.publisher}.${manifest.name}`).toBe('autonomous-ai.harness-device')
    expect(manifest).not.toHaveProperty('contributes')
    expect(manifest.activationEvents).toEqual(['onStartupFinished'])
    expect(manifest.engines).toEqual({ vscode: '^1.75.0' })
    expect(manifest).not.toHaveProperty('dependencies')
  })

  it('its manifest runs in Restricted Mode, so an agent in an untrusted folder still reaches the dial', () => {
    // Safe: it reads nothing of the workspace, and runs only the launcher in the home or on the extension host's PATH.
    // Virtual workspaces keep VS Code's default.
    const manifest = JSON.parse(readFileSync(join(EXTENSION, 'package.json'), 'utf8'))
    expect(manifest.capabilities).toEqual({ untrustedWorkspaces: { supported: true } })
  })
})
