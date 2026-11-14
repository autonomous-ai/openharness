# macOS dial discovery: a narrow ioreg query

## Problem

On a Mac under load the daemon never attaches a round dial. The wave 0 device run (2026-11-14, daemon 0.6.56) logged
`cable: USB discovery failed: SerialToolTimeoutError: ioreg did not answer in 5 s` 2,282 times since 09:49 local, and
no dial attached.

Discovery on macOS (`findDarwin` in `cli/src/cable/serial.ts`) runs
`ioreg -r -c IOUSBHostDevice -w0 -l`: every USB device with every property of every node below it. Measured on the
reporting Mac (M-series, 10 cores, a dial attached as `/dev/cu.usbmodem21101`), three runs each:

| Query | Wall | User | Sys | Output |
|---|---|---|---|---|
| `ioreg -r -c IOUSBHostDevice -w0 -l` (today) | 7.7 s | 0.15 s | 7.5 s | 4.5 MB, 66 nodes |
| `ioreg -r -c IOSerialBSDClient -t -w0 -l` (new) | 0.07 s | 0.01 s | 0.06 s | 336 KB |

The time is kernel time spent reading the properties of the DriverKit HID drivers below the keyboard and trackpad
devices (`AppleUserHIDEventDriver` alone is 2.7 MB of the 4.5 MB). It is not caused by load: the query costs this on
an idle machine too, and load only pushes it further past the 5 s timeout. Each failed scan leaves the gate's cache
empty, so the next 2 s tick spawns ioreg again and burns another 5 s of a core before it is killed.

The scans themselves already run one at a time (`CableFleet.scan` joins the running `scanTask`), so the daemon never
runs two ioreg calls at once; nothing changes there.

## Change

This is a new query, not a longer timeout.

1. **Query only the serial ports, with their ancestors.** `runIoreg` runs
   `ioreg -r -c IOSerialBSDClient -t -w0 -l`. Every `/dev/cu.*` node on macOS is an `IOSerialBSDClient`, so every
   dial's tty is in it; `-t` prints, for each one, the chain of nodes from `Root` down to it with their properties,
   which includes the USB device node that carries `idVendor`, `idProduct`, `USB Serial Number` and `sessionID`. No
   HID subtree is read. `parseDarwinDialPorts` already reads this shape: on the real dump it returns the same path and
   serial number as on today's dump (each chain starts at a depth-0 `Root`, which closes any armed subtree).
2. **The timeout stays 5 s,** and `TOOL_TIMEOUT_MS`, `withinToolTimeout`, the `/dev/cu.*` fingerprint gate and the
   5-minute safety rescan are unchanged. No adaptive timeout and no serving of a stale result: at 0.07 s neither is
   needed, and a query that does time out is still reported by name as today.
3. **Read the USB device's `sessionID` in either property order.** On real dumps the device node lists `sessionID`
   before `idVendor`/`idProduct`, and the parser only records `sessionID` after the node has matched, so on macOS a
   dial's `session` is never set (with either query). Without it a "not a dial" verdict cannot outlast a daemon
   restart or end at an unplug, as `DialPort.session` says it should. The parser keeps the current node's
   `sessionID` as it does its serial number, and arms with it when the node matches. A `sessionID` on a node below
   the device (an interface) still never counts.
4. **The comments say why,** with the measurement above: the query comment on `runIoreg` and the CPU-cost comment
   above `DIAL_RESCAN_MS`.

Files: `cli/src/cable/serial.ts` and its tests (`cli/src/cable/serial.spec.ts`, `cli/src/cable/cableFleet.spec.ts`),
plus a fixture. Linux (`/sys`) and Windows (`harness-serial.exe`) never run ioreg and are unchanged. Nothing in the
core changes; the devices process owns this code.

## Tests

- **Fixture from the real dump.** A trimmed copy of the new query's output on the reporting Mac: the chains of the
  dial, a USB hub above it, `debug-console` and the Bluetooth port, with the `Root` and platform property blocks cut
  and the USB serial number replaced by a made-up one (no machine names, console users or real serials in the repo).
  Only USB nodes and serial ports keep their properties (IOResources, the USB controller and the Bluetooth nodes carry
  console users, the platform UUID and network and Bluetooth addresses), the serial is also replaced inside
  `UsbDeviceSignature`, the hub's `kUSBContainerID` is zeroed, and the Mac's model code in the platform node's name
  becomes `J000AP`: the repo is public, so it holds no detail of a real machine.
  `parseDarwinDialPorts` on it returns exactly the dial: its path, serial number and `session` (the device node's
  `sessionID`, not the hub's or the interface's). Red today on `session`.
- **Property order.** The existing "either property order" case gains a device whose `sessionID` comes before its ids.
  Red today.
- **Wiring.** The macOS wiring test expects the new arguments (`['-r', '-c', 'IOSerialBSDClient', '-t', '-w0', '-l']`)
  and the 5 s timeout. Red today.
- The timeout, gate and overlap tests stay as they are and pass.

## Verification

On the reporting Mac, read-only (it runs ioreg, opens no port, and needs no access to the shared dial): the built CLI's
`findDialPorts()` returns the attached dial with its `session`, and the new query's wall and CPU time are recorded
before and after. The daemon's own attach is covered by the existing fleet tests; a live attach would need the shared
dial and the running daemon's port, so it is left to the next device run.

## Measures

None new. The existing log line names a failed or slow discovery; the PR records the before/after numbers above.
