// Reset a board over its USB cable, the way esptool's hard reset does.
//
// A user's Harness Pro started beside a booting Mac sent nothing for days at a time (20-26 Oct): no greeting, no
// console text, and a reopen of the port did not bring it back, only a replug did. The USB-Serial/JTAG peripheral
// resets the chip when the host raises RTS while DTR is low, which a person cannot do but the daemon can.
//
// Node cannot set a tty's modem lines (no ioctl), and macOS ships perl, so a few lines of it do the TIOCMSET calls.
// Windows has neither the ioctl nor perl here; it is told "no" and the caller falls back to asking the person.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

type Run = (file: string, args: string[], options: { timeout: number }) => Promise<unknown>

/** TIOCMSET: _IOW('t', 109, int) on macOS, 0x5418 on Linux. */
const TIOCMSET: Partial<Record<NodeJS.Platform, string>> = { darwin: '0x8004746d', linux: '0x5418' }
/** RTS high with DTR low holds the chip in reset; both low lets it boot normally (DTR high would ask for the ROM's download mode). */
const PULSE = ['4:200', '0:200']
// Path, request, then `bits:ms` steps. The port is opened without blocking on carrier and without becoming the
// daemon's controlling terminal (serial.ts says why that matters).
const SCRIPT = 'use Fcntl;sysopen(my $f,shift,O_RDWR|O_NONBLOCK|O_NOCTTY) or exit 2;my $r=hex shift;'
  + 'for(@ARGV){my($b,$ms)=split /:/;ioctl($f,$r,pack("i",$b)) or exit 3;select(undef,undef,undef,$ms/1000)}'

/** True when the pulse was sent. Never throws: a board that cannot be reset is an ordinary answer. */
export async function resetBoard(path: string, deps: { platform?: NodeJS.Platform; run?: Run } = {}): Promise<boolean> {
  const request = TIOCMSET[deps.platform ?? process.platform]
  if (!request) return false
  try {
    await (deps.run ?? promisify(execFile))('perl', ['-e', SCRIPT, path, request, ...PULSE], { timeout: 5000 })
    return true
  } catch {
    return false
  }
}
