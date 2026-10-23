import { existsSync, readFileSync } from 'node:fs'
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
    for (const file of ['harness-pty.exe', 'harness-launch.exe', 'harness.exe', 'conpty.dll', 'OpenConsole.exe', 'harness-serial.exe']) expect(pty).toContain(file)
    expect(pty).toContain('src/scripts/installPs1.spec.ts')
    // The target-specific build is not where installPs1.spec.ts looks by default (pty/target/<profile>/).
    expect(pty).toContain('HARNESS_EXE_BIN:')
  })

  it('runs the rollover and payload-install specs against two real builds of the host', () => {
    const pty = read('windows.yml')
    // The previous build: a numeric version, as an install's folder under runtime\pty\ is named.
    expect(pty).toMatch(/- name: Build the previous host\n\s+if: \$\{\{ !inputs\.release \}\}\n[\s\S]*?HARNESS_PTY_VERSION: '0\.0\.1'\n/)
    expect(pty).toContain('HARNESS_PTY_BIN_PREV: ${{ github.workspace }}\\pty\\target\\${{ matrix.target }}\\previous\\harness-pty.exe')
    // The Rust two-build test runs on that build too: without HARNESS_PTY_BIN_OLD it returns at once.
    expect(pty).toMatch(/- name: 'Rust: two versions side by side'\n\s+if: \$\{\{ !inputs\.release \}\}\n[\s\S]*?HARNESS_PTY_BIN_OLD: \$\{\{ github\.workspace \}\}\\pty\\target\\\$\{\{ matrix\.target \}\}\\previous\\harness-pty\.exe\n\s+run: cargo test --locked --target \$\{\{ matrix\.target \}\} --test control two_versions_serve_side_by_side -- --nocapture\n/)
    for (const spec of ['src/lib/hostMove/hostMove.real.spec.ts', 'src/lib/ptyHost/drain.spec.ts', 'src/lib/windows/ptyInstall.windows.real.spec.ts']) expect(pty).toContain(spec)
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

  it('keeps the Windows desktop test matrix and adds a staging-only release mode with native package proof', () => {
    const desktop = read('windows-desktop.yml')
    expect(desktop).toMatch(/workflow_dispatch:\n\s+inputs:\n[\s\S]*?\s+release:\n/)
    expect(desktop).toMatch(/\n  mode:\n/)
    expect(desktop).toMatch(/\n  build-test:\n    needs: mode\n    if: \$\{\{ needs\.mode\.outputs\.release != 'true' \}\}\n/)
    expect(desktop).toMatch(/\n  release-build:\n    needs: mode\n    if: \$\{\{ needs\.mode\.outputs\.release == 'true' \}\}\n/)
    expect(desktop).toMatch(/\n  release-staging:\n    needs: \[mode, release-build\]\n/)
    expect(desktop).toContain('cancel-in-progress: "${{ !inputs.release }}"')
    expect(desktop).toContain('C4.7 package smoke')
    expect(desktop).toContain('pwsh desktop/scripts/package-windows.ps1')
    expect(desktop).toContain('tar.exe')
    expect(desktop).toContain('harness_pipe_io.dll')
    expect(desktop).toContain('--build-name ${{ env.VERSION }}')
    expect(desktop).toContain('--dart-define=HARNESS_STAGING=true')
    expect(desktop).not.toContain('HARNESS_INSTALL_PS1_URL')
    expect(desktop).not.toContain('DESKTOP_UPDATE_METADATA_URL=')
    expect(desktop).toContain('bash desktop/scripts/publish-desktop-windows-staging.sh')
    expect(desktop).toContain('DRY_RUN=1 DRY_RUN_OUT=.dry-run bash desktop/scripts/publish-desktop-windows-staging.sh')
    expect(desktop).toContain('STAGING_PREFIX: harness/staging')
    expect(desktop).not.toMatch(/harness\/desktop\/metadata\.json/)
    for (const existing of ['cargo test --locked --lib desktop', 'desktop_install', 'flutter test --no-pub', 'windows_test_baseline.py', 'windows_pipe_test.dart', 'windows_runner_test.dart']) {
      expect(desktop).toContain(existing)
    }
  })

  it('runs the Windows desktop workflow on demand only', () => {
    const desktop = read('windows-desktop.yml')
    expect(desktop).toMatch(/^on:\n(?:\s+#[^\n]*\n)*\s+workflow_dispatch:/m)
    expect(desktop).not.toMatch(/^\s+push:/m)
    expect(desktop).not.toContain('feat/windows-desktop')
    expect(desktop).not.toContain('TEMPORARY')
    expect(desktop).not.toContain('head_commit')
  })

  it('runs the Windows PTY workflow on demand or from the release only, with no branch-only workflow left', () => {
    const pty = read('windows.yml')
    expect(pty).not.toMatch(/^\s+push:/m)
    expect(pty).not.toContain('TEMPORARY')
    expect(pty).not.toMatch(/feat\/windows-/)
    expect(existsSync(join(workflows, 'windows-cli-staging-c.yml'))).toBe(false)
  })

  // Installer spec §2.4 and §4.2.
  it('tests harness-install.exe on both runners and publishes a staging one with the staging zips', () => {
    const desktop = read('windows-desktop.yml')
    expect(desktop).toMatch(/- name: harness-install\.exe tests\n\s+working-directory: installer\n\s+run: \|\n\s+cargo test --locked\n/)
    expect(desktop).toContain('HARNESS_INSTALL_BIN: ${{ github.workspace }}\\installer\\target\\debug\\harness-install.exe')
    expect(desktop).toContain('HARNESS_INSTALL_BASE: https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/staging/')
    expect(desktop).toContain('windows-arm64.zip" .zips/harness-install.exe')
    expect(desktop).toContain("'desktop-windows-installer': 'harness-install.exe'")
  })

  // Installer spec §2.2: every desktop release ships Windows, unsigned, from the same manifest write.
  it('builds Windows in the desktop release and publishes it with the other platforms', () => {
    const release = read('release-desktop.yml')
    const job = (name: string) => release.match(new RegExp(`\n  ${name}:\n([\\s\\S]*?)(?=\n  [\\w-]+:\n|$)`))?.[1] ?? ''
    const build = job('build-windows')
    expect(build).toContain('{ runner: windows-latest, arch: x64, target: x86_64-pc-windows-msvc }')
    expect(build).toContain('{ runner: windows-11-arm, arch: arm64, target: aarch64-pc-windows-msvc }')
    expect(build).toContain("if: needs.preflight.outputs.reused != 'true'")
    expect(build).toContain('flutter build windows --release --build-name $env:VERSION')
    expect(build).not.toContain('HARNESS_STAGING')
    expect(build).toContain('HARNESS_INSTALL_BASE: https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/\n')
    expect(build).toContain("if: matrix.arch == 'x64'")
    expect(build).not.toContain('gcloud')
    expect(job('upload-windows')).toContain('bash desktop/scripts/upload-desktop-windows.sh "$VERSION" windows-release')
    expect(release).toMatch(/publish:\n\s+needs: \[version, preflight, build-macos, build-linux, build-windows, upload-windows\]/)
    expect(release).toContain("needs.build-linux.result == 'success' && needs.upload-windows.result == 'success'")
    expect(release).toMatch(/candidate:\n\s+needs: \[version, build-macos, build-linux, upload-windows\]/)
    expect(release).toMatch(/cleanup:\n\s+needs: \[version, preflight, build-macos, build-linux, build-windows, upload-windows, candidate, publish\]/)
    expect(release).toContain('[harness-install.exe](${base}/harness-install.exe)')
  })
})
