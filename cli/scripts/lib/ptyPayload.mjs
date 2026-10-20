/**
 * The Harness PTY host, the windowless `harness-launch.exe` (pty/src/launcher.rs), the `harness.exe` command
 * (pty/src/command.rs) and the host's ConPTY payload,
 * copied beside a Windows bundle in `<out>/pty/` for local Windows
 * testing (src/lib/ptyHost/launch.ts `ptyHostBinary` looks there last). The host loads `conpty.dll`, and through it
 * `OpenConsole.exe`, from its own folder (tui/vendor/alacritty_terminal/src/tty/windows/conpty.rs), so those three
 * travel together; `pty/scripts/fetch-conpty.ps1` puts the payload in `pty/vendor/conpty/<arch>/`.
 *
 * Only on Windows, and only what is there: a Unix bundle, or one built without the host, is unchanged. Releases publish the same six
 * files as one zip per architecture (scripts/publish-pty-payload.sh), and install.ps1 lays them down per version under
 * the runtime folder.
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { basename, join } from 'node:path'

/** The files to copy, from the repository's `pty/` folder: the release host, the launcher, the command, then the
 *  payload for [arch], then harness-serial from `serial/` beside it (sub-project E). */
export function ptyPayloadSources(ptyDir, arch) {
  const release = join(ptyDir, 'target', 'release')
  const payload = join(ptyDir, 'vendor', 'conpty', arch === 'arm64' ? 'arm64' : 'x64')
  const serial = join(ptyDir, '..', 'serial', 'target', 'release', 'harness-serial.exe')
  return [join(release, 'harness-pty.exe'), join(release, 'harness-launch.exe'), join(release, 'harness.exe'), join(payload, 'conpty.dll'), join(payload, 'OpenConsole.exe'), serial]
}

/** Copies what is present into `<outDir>/pty/`, on win32 and when the host itself was built; the names it copied. */
export function copyPtyPayload({ ptyDir, outDir, platform = process.platform, arch = process.arch }) {
  if (platform !== 'win32') return []
  const [host, ...payload] = ptyPayloadSources(ptyDir, arch)
  if (!existsSync(host)) return []
  const target = join(outDir, 'pty')
  mkdirSync(target, { recursive: true })
  const copied = []
  for (const file of [host, ...payload.filter((file) => existsSync(file))]) {
    copyFileSync(file, join(target, basename(file)))
    copied.push(basename(file))
  }
  return copied
}
