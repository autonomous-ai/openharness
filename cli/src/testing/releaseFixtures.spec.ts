import { describe, expect, it } from 'vitest'
import { LEAN_CORE_ENTRY, LEAN_ENTRY, readLeanBundle } from '../harnessd/leanBundle.js'

const { atVersion, withFault, withLean } = await import('../../e2e/harness/release.js' as string) as {
  atVersion: (bundle: string, from: string, to: string) => string
  withFault: (bundle: string, code: string) => string
  withLean: (bundle: string, files: Record<string, string>) => string
}
const { leanBlock } = await import('../../scripts/lib/leanBlock.mjs' as string) as {
  leanBlock: (files: Record<string, string>, options?: { quality: number }) => string
}

describe('release fixtures keep the real lean bundle contract', () => {
  const files = {
    [LEAN_ENTRY]: '// master\nexport const version = "43.0.1";\n',
    [LEAN_CORE_ENTRY]: '// core\nexport const version = "43.0.1";\n',
    'shared.mjs': 'export const version = "43.0.1";\n',
  }
  const header = '#!/usr/bin/env node\nconsole.log("43.0.1");\n'
  const bundle = header + leanBlock(files)
  const decoded = (text: string): Record<string, string> => {
    const lean = readLeanBundle(Buffer.from(text))
    expect(lean, 'the production reader verifies the fixture checksum').not.toBeNull()
    return Object.fromEntries([...lean!.files].map(([name, code]) => [name, code.toString('utf8')]))
  }

  it('keeps maximum compression as the default for production builds', () => {
    expect(leanBlock(files)).toBe(leanBlock(files, { quality: 11 }))
    expect(decoded(bundle)).toEqual(files)
  })

  it('changes the version in the CLI, master, core and shared modules', () => {
    const next = atVersion(bundle, '43.0.1', '43.0.2')
    expect(next.startsWith(header.replaceAll('43.0.1', '43.0.2'))).toBe(true)
    expect(decoded(next)).toEqual(Object.fromEntries(Object.entries(files).map(([name, code]) => [name, code.replaceAll('43.0.1', '43.0.2')])))
  })

  it('puts a startup fault in all three entries, without changing shared code', () => {
    const fault = 'if (process.argv[2] === "__run") process.exit(3);'
    const broken = withFault(bundle, fault)
    expect(broken.startsWith(header.replace('\n', `\n${fault}\n`))).toBe(true)
    expect(decoded(broken)).toEqual({
      ...files,
      [LEAN_ENTRY]: files[LEAN_ENTRY]!.replace('\n', `\n${fault}\n`),
      [LEAN_CORE_ENTRY]: files[LEAN_CORE_ENTRY]!.replace('\n', `\n${fault}\n`),
    })
    expect(withFault(bundle, '')).toBe(bundle)
  })

  it('replaces the payload and keeps version and fault helpers working without a lean block', () => {
    expect(decoded(withLean(bundle, { [LEAN_ENTRY]: '// replacement\n' }))).toEqual({ [LEAN_ENTRY]: '// replacement\n' })
    expect(atVersion(header, '43.0.1', '43.0.2')).toBe(header.replaceAll('43.0.1', '43.0.2'))
    expect(withFault(header, 'throw Error("test fault")')).toBe(header.replace('\n', '\nthrow Error("test fault")\n'))
  })
})
