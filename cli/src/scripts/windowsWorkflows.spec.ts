import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const workflows = join(process.cwd(), '..', '.github', 'workflows')
const read = (name: string) => readFileSync(join(workflows, name), 'utf8')

describe('the Windows release workflows', () => {
  it('lets the release call the Windows PTY workflow for a payload stamped with the CLI version', () => {
    const pty = read('windows.yml')
    expect(pty).toMatch(/workflow_call:\n\s+inputs:\n\s+version:/)
    expect(pty).toContain('HARNESS_PTY_VERSION: ${{ inputs.version }}')
    expect(pty).toContain("if: ${{ !inputs.release }}")
    for (const file of ['harness-pty.exe', 'harness-launch.exe', 'harness.exe', 'conpty.dll', 'OpenConsole.exe']) expect(pty).toContain(file)
    expect(pty).toContain('src/scripts/installPs1.spec.ts')
    // The target-specific build is not where installPs1.spec.ts looks by default (pty/target/<profile>/).
    expect(pty).toContain('HARNESS_EXE_BIN:')
  })

  it('publishes the Windows bits to staging only, beside a CLI publish that never waits for them', () => {
    const release = read('release.yml')
    expect(release).toContain('uses: ./.github/workflows/windows.yml')
    expect(release).toContain('staging_prefix=')
    expect(release).toContain('METADATA_PATH="$STAGING_PREFIX/pty/metadata.json"')
    expect(release).toMatch(/windows-staging:\n\s+needs: \[version, preflight, publish, pty-build\]/)
    expect(release).toMatch(/github-release:\n\s+needs: \[version, publish\]/)
    expect(release).toMatch(/publish:\n\s+needs: \[version, preflight, process-images\]/)
    expect(release).not.toMatch(/METADATA_PATH=harness\/pty\/metadata\.json/)
    expect(release).not.toContain('upload-install-ps1.sh --production')
  })
})
