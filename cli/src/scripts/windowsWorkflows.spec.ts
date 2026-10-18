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
    // The zips under the staging prefix too, where promote-pty-payload.sh finds them through the staging manifest, and
    // a dry run's under harness/staging-dry-run, so it never takes a real version's immutable harness/pty/<version>/.
    expect(release).toContain('OBJECT_PREFIX="$STAGING_PREFIX" METADATA_PATH="$STAGING_PREFIX/pty/metadata.json" bash cli/scripts/publish-pty-payload.sh')
    expect(release).toMatch(/staging=harness\/staging; else staging=harness\/staging-dry-run; fi/)
    expect(release).not.toMatch(/bash cli\/scripts\/promote-pty-payload\.sh/)
    expect(release).toMatch(/windows-staging:\n\s+needs: \[version, preflight, publish, pty-build\]/)
    expect(release).toMatch(/github-release:\n\s+needs: \[version, publish\]/)
    expect(release).toMatch(/publish:\n\s+needs: \[version, preflight, process-images\]/)
    expect(release).not.toMatch(/METADATA_PATH=harness\/pty\/metadata\.json/)
    expect(release).not.toContain('upload-install-ps1.sh --production')
  })

  it('lets the Node runtime workflow write only a runtime manifest, and fail plainly when the read-back is not served', () => {
    const node = read('release-node-runtime-windows.yml')
    // Final review R3-4: never the fleet's harness/cli/metadata.json, whatever is typed into the dispatch.
    expect(node).toContain('[[ "$METADATA_PATH" =~ ^harness/(staging[a-z0-9-]*/)?runtime/metadata\\.json$ ]]')
    // Carried B1.11: a 404 failed as "served bytes differ"; it now says what the fetch answered.
    expect(node).toMatch(/if \(!response\.ok\) throw new Error\(`\$\{key\}: GET \$\{entry\.url\} -> \$\{response\.status\}`\)/)
  })
})
