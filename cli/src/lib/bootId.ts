/**
 * Which boot of the machine this is: how the registry knows, at start, that the machine rebooted while
 * the daemon was down, and so that every process it remembers is gone and every agent is dormant.
 *
 * Linux and macOS each give a boot its own id: the kernel's boot_id, and `kern.bootsessionuuid`. Where
 * neither can be read, the boot is named by the moment it began, the wall clock less the uptime, and
 * two such marks are the same boot when they are within two minutes of each other. That rule is wrong
 * after any step of the wall clock: an NTP correction, a virtual machine resumed or a laptop's clock set
 * after a long sleep moves the boot's moment by the whole step, and a daemon restarted then decided the
 * machine had rebooted and marked every agent dormant. On macOS that was the only rule there was.
 *
 * A mark written by an older build, a number, is compared by time once, against the moment this boot
 * began; the boot's own id is written after it, so the comparison happens on one migration only.
 *
 * hook/notify.mjs reads and writes the same file and keeps its own copy of these rules: change both.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { uptime } from 'node:os'

/** Clock and NTP drift is seconds; a reboot moves the boot's moment by the whole uptime. */
export const BOOT_TOLERANCE_SEC = 120
const BOOT_UUID_RE = /^[0-9a-f-]{36}$/i

export interface BootSources {
  platform: NodeJS.Platform
  /** The Linux kernel's id for this boot. */
  linuxBootId: () => string
  /** macOS's id for this boot (`sysctl -n kern.bootsessionuuid`). */
  macosBootId: () => string
  /** When this boot began, by the wall clock, in seconds. */
  bootTimeSec: () => number
}

export const SYSTEM_BOOT_SOURCES: BootSources = {
  platform: process.platform,
  linuxBootId: () => readFileSync('/proc/sys/kernel/random/boot_id', 'utf8'),
  // By its full path: a daemon started from a shell whose PATH lacks /usr/sbin still finds it.
  macosBootId: () => execFileSync('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], { encoding: 'utf8', timeout: 2_000 }),
  bootTimeSec: () => Math.round(Date.now() / 1000 - uptime()),
}

/** This boot's mark: `linux:<id>`, `macos:<id>`, or `time:<seconds>` where neither id can be read. */
export function currentBootId(sources: BootSources = SYSTEM_BOOT_SOURCES): string {
  try {
    const value = sources.linuxBootId().trim()
    if (BOOT_UUID_RE.test(value)) return `linux:${value}`
  } catch { /* not Linux */ }
  if (sources.platform === 'darwin') {
    try {
      const value = sources.macosBootId().trim()
      if (BOOT_UUID_RE.test(value)) return `macos:${value}`
    } catch { /* sysctl unavailable: the moment the boot began, below */ }
  }
  return `time:${sources.bootTimeSec()}`
}

/** Whether `current` is a later boot than the one `saved` was written in. Nothing saved is no reboot. */
export function bootChanged(saved: string | null, current: string, sources: BootSources = SYSTEM_BOOT_SOURCES): boolean {
  if (!saved) return false
  if (saved.startsWith('linux:')) return saved !== current
  // A macOS id that cannot be read now is no evidence of a reboot.
  if (saved.startsWith('macos:')) return !current.startsWith('time:') && saved !== current
  const savedNumber = Number(saved.replace(/^time:/, ''))
  const currentNumber = current.startsWith('time:') ? Number(current.slice(5)) : sources.bootTimeSec()
  return !Number.isFinite(savedNumber) || Math.abs(currentNumber - savedNumber) > BOOT_TOLERANCE_SEC
}
