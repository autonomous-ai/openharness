# macOS dial discovery, a narrow ioreg query: Implementation Plan

> **For agentic workers:** REQUIRED: execute with **diegodev phase 3**. Tasks 1 and 3 are test-first: a red commit
> (the test alone), then the code commit. Task 2 adds a data file and is one commit. Steps use checkbox (`- [ ]`)
> syntax for tracking.

**Goal:** On a Mac the daemon finds its dials with `ioreg -r -c IOSerialBSDClient -t -w0 -l` (0.07 s, where today's
query takes 7.7 s and never beats the 5 s timeout), and every dial it finds carries its USB attachment's `session`.

**Architecture:** One file of product code, `cli/src/cable/serial.ts`, which runs in the devices process. `runIoreg`
asks for the serial ports with their ancestors instead of every USB device with its whole subtree.
`parseDarwinDialPorts` keeps the current node's `sessionID` as it keeps its serial number, so the order of a node's
properties no longer matters. The timeout, the `/dev/cu.*` gate and the 5-minute rescan are not touched.

**Tech Stack:** TypeScript, Vitest 4, Node (v22.21.1 on this Mac), macOS `ioreg`. No new dependency.

**Spec:** [docs/plans/2026-11-14-ioreg-usb-discovery-timeout-design.md](2026-11-14-ioreg-usb-discovery-timeout-design.md).
Read it with this plan, the root `AGENTS.md` and `cli/AGENTS.md`. The spec is the authority.

## Open questions

None.

## Global Constraints

- A new query, not a longer timeout. `TOOL_TIMEOUT_MS` stays `5000`; `withinToolTimeout`, the `/dev/cu.*`
  fingerprint gate and `DIAL_RESCAN_MS = 300_000` are unchanged. No adaptive timeout, no stale result served.
- The query, verbatim: `ioreg -r -c IOSerialBSDClient -t -w0 -l`, as
  `['-r', '-c', 'IOSerialBSDClient', '-t', '-w0', '-l']`. `maxBuffer` and the error text
  `Could not enumerate USB dials` stay.
- The measurement the comments and the pull request record (the reporting Mac, three runs each, 2026-11-14):
  wall 7.7 s to 0.07 s, user 0.15 s to 0.01 s, sys 7.5 s to 0.06 s, output 4.5 MB (66 nodes) to 336 KB.
- Files: `cli/src/cable/serial.ts`, `cli/src/cable/serial.spec.ts`, `cli/src/cable/cableFleet.spec.ts` and the new
  `cli/src/cable/__fixtures__/ioregSerialClients.txt`. Nothing else: not `cli/src/lib/periodicCpu.integration.spec.ts`
  (its dump stays), not `findLinux`, not `windowsSerial.ts`, nothing under `cli/src/core/`, nothing under
  `devices/harness-pro/`.
- The lines `export const DIAL_VENDOR_ID = 0x303a` and `export const DIAL_PRODUCT_ID = 0x1001` stay as they are, to
  the character: `os/tests/test_lock_and_screenshot.py:81` reads them as text.
- No real serial number, computer name, console user, network address or platform identifier in the repo, a commit
  message or the pull request body. The fixture is trimmed by Task 2's rule and nothing of the capture is pasted
  anywhere else.
- Nobody opens the dial's port, and nobody touches the running daemon (port 18473) or its data: `ioreg` and a
  listing of `/dev/cu.*` are the only reads of this Mac.
- Comments say why, in plain sentences, with the measurement and the incident (2,282 failed scans, daemon 0.6.56,
  2026-11-14).
- A task runs only the specs of what it changed. No full local suite: PR CI runs it.
- A commit adds its files by name. The two documents under `docs/plans/` are untracked here and are no task's.
- This checkout has `cli/node_modules`. A task run in another checkout installs once first:
  `cd cli && npm ci --no-audit --no-fund`.
- Platforms: macOS only. Linux (`/sys`) and Windows (`harness-serial.exe`) never run `ioreg` and are unchanged. One
  pull request; its body names the platforms and carries each task's red and green output, the measurement and the
  Verification results.

## Found while reading the code

Checked at `447b4a07e3`, on the reporting Mac (macOS 26, arm64), a dial plugged in behind a USB hub.

- **Baseline.** `npx vitest run src/cable/serial.spec.ts src/cable/cableFleet.spec.ts src/lib/periodicCpu.integration.spec.ts`:
  `71 passed | 1 skipped (72)` (23, 45, and 3 with 1 skipped). `npm run typecheck`: clean, about a minute.
- **Today's real path fails here every time.** The built `findDialPorts()` at this commit:
  `SerialToolTimeoutError: ioreg did not answer in 5 s` after 5011 ms. The whole process took `real 7.47`,
  `sys 7.26`: ioreg ran on past the kill at 5 s, so a failed scan costs the full 7 s of a core, not 5.
- **Today's parser reads the new query's shape.** On the real output of both queries it returns the same one port,
  with its path and serial number and no `session`.
- **Property order is not fixed.** In the same dump the hub lists `idVendor`, `idProduct`, then `sessionID`; the
  dial lists `sessionID` first, then `idProduct`, then `idVendor`, then `USB Serial Number`. The interface and the
  CDC driver below the dial repeat its `idVendor` and `idProduct`, and the interface its serial number.
- **The spec's trimming rule is not enough alone.** Besides `Root` and the platform node, `IOResources` carries
  the console users and the platform UUID, the USB controller node a network address, and the Bluetooth nodes the
  Bluetooth address. Task 2 keeps the properties of the USB nodes and the serial ports only, and cuts every other
  node's.
- **What `session` switches on, on macOS.** Code that exists and is tested with sessions already: a "not a dial"
  verdict holds 6 hours for the same attachment instead of 10 minutes (`dialPortVerdicts.ts:45-46`), and a silent
  Pro is looked at afresh when it is plugged back into the same port (`cableFleet.ts:205`). A verdict saved without
  a session still reads as unknown and ends in 10 minutes: nothing to migrate.
- **The real-dump test is red on `session` only,** so it is one of the parse fix's red tests (Task 3), not a task
  of its own: after the fix it would arrive green. The file it reads is Task 2, which can be made beside Task 1.
- **A file, not an inline string.** The trimmed dump is 231 lines with lines up to 574 characters. It goes in
  `cli/src/cable/__fixtures__/`, read as `serial.real.spec.ts` reads its neighbours
  (`fileURLToPath(new URL('./__fixtures__/…', import.meta.url))`), as `vectors/cable_frame.txt` is a file. On a
  CRLF checkout it still parses: every value the parser takes is trimmed (rehearsed).
- **The wiring test runs on a Mac only** (`it.skipIf(process.platform !== 'darwin')`, `serial.spec.ts:254`). PR CI's
  Linux shards skip it, so its red and green are recorded on this Mac.
- **Local gate.** `python3 scripts/local-checks.py --list` on the File map's paths names `cli-serial`
  (`npx vitest run src/cable/serial.real.spec.ts --maxWorkers=1`, macOS). `process-checks` refuses the pull request
  without its receipt.
- **Nothing else runs or documents the old query** besides `serial.ts:153` and `serial.spec.ts:261`. The
  `<class IOUSBHostDevice>` in the tests' small dumps is a node line and stays.

## File map

| File | Change | Task |
| --- | --- | --- |
| `cli/src/cable/serial.ts` | `runIoreg`'s arguments and comment; the cost comment above `DIAL_RESCAN_MS` | 1 |
| `cli/src/cable/serial.spec.ts` | the wiring test expects the new arguments (line 261) | 1 |
| `cli/src/cable/__fixtures__/ioregSerialClients.txt` | new: the trimmed real dump | 2 |
| `cli/src/cable/serial.ts` | `parseDarwinDialPorts` keeps the current node's `sessionID` (lines 161-208) | 3 |
| `cli/src/cable/cableFleet.spec.ts` | the property-order case gains a device; two new cases; two imports | 3 |

## Review Focus

Each line is pinned by a test, in Task 3 unless it says otherwise.

- Two dials behind one hub: `-t` prints one chain per port, each from its own `Root`, and both repeat the hub. Each
  port keeps its own serial number and session. New case "one chain per serial port".
- A `sessionID` on a node above the dial (the hub's) never becomes the session of a dial that lists none. The real
  dump cannot show it, since its dial has one of its own. Same new case, the second dial.
- An interface below the dial that repeats its ids and carries a `sessionID` of its own neither arms again nor
  replaces the device's. The property-order case, device `Tam`.
- The chain after the dial's (the Bluetooth port) starts at a depth-0 `Root`, which closes the armed subtree: its
  port is not returned as a dial. The real-dump case expects exactly one port.
- A Mac with no serial port: `ioreg -r -c <a class with no node> -t -w0 -l` prints nothing and exits 0 (measured),
  which reads as no dial and is cached. Existing cases, unchanged: `parseDarwinDialPorts('')` and "treats an empty
  /dev/cu.* set as a valid fingerprint".

---

### Task 1: `runIoreg` asks for the serial ports

**Depends on:** nothing. **Effort:** medium. Shares `serial.ts` with Task 3, on other lines: neither waits for the
other's result.

**Files:**
- Modify: `cli/src/cable/serial.ts:118-126` (the comment above `DIAL_RESCAN_MS`) and `:150-157` (`runIoreg`)
- Test: `cli/src/cable/serial.spec.ts:261`

**The test that fails before the change:** `macOS dial discovery wiring › stats only cu.* entries, gates ioreg on
them and keeps the error text`, in `cli/src/cable/serial.spec.ts`, with the new arguments. It runs on a Mac only.

- [ ] **Step 1: The wiring test expects the new query**

Line 261 becomes (line 262, the `timeout: 5000` check, stays):

```ts
    expect(io.configure.mock.calls[0].slice(0, 2)).toEqual(['ioreg', ['-r', '-c', 'IOSerialBSDClient', '-t', '-w0', '-l']])
```

- [ ] **Step 2: See it fail, on a Mac**

Run: `cd cli && npx vitest run src/cable/serial.spec.ts -t "stats only cu"`
Expected: `1 failed | 22 skipped (23)`; the diff shows `IOUSBHostDevice` received and no `-t`. On Linux the case is
skipped and proves nothing.

- [ ] **Step 3: Commit the red test**

```bash
git add cli/src/cable/serial.spec.ts
git commit -m "Cable: the macOS discovery test expects the serial-port ioreg query"
```

- [ ] **Step 4: The query and its comment**

In `runIoreg` the arguments become `['-r', '-c', 'IOSerialBSDClient', '-t', '-w0', '-l']`; the options and the
`catch` stay. The one-line comment above the call is replaced by:

```ts
      // Only the serial ports, each with the chain of nodes above it (-t): the USB device node in that chain carries
      // the ids, the serial number and the sessionID. Asking for every USB device with its whole subtree
      // (-c IOUSBHostDevice) also read the DriverKit HID drivers below a keyboard and a trackpad: 7.7 s wall, 7.5 s
      // of it in the kernel, 4.5 MB. The 5 s timeout ended every scan and no dial attached (2,282 failed scans in
      // one day's log, daemon 0.6.56, 2026-11-14). This query took 0.07 s wall, 0.06 s in the kernel and 336 KB on
      // the same Mac.
```

- [ ] **Step 5: The cost comment above `DIAL_RESCAN_MS`**

Its first two lines (118-119) are replaced by the four below, and `(~0.05%)` on line 122 becomes `(~0.02%)`
(70 ms every 300 s). The rest of the comment stays.

```ts
// `ioreg` costs CPU on every run, even with no dial attached: ~150 ms for the whole-USB query on 2026-10-06
// (~7.5% of a core at a scan every 2 s), 7.5 s of kernel time for it on a Mac with DriverKit HID devices on
// 2026-11-14, and still ~70 ms for the serial-port query that replaced it (runIoreg below, the same Mac). So it
// runs only when /dev/cu.* changes (~0.3 ms to fingerprint two cu.* nodes, measured 2026-10-06).
```

- [ ] **Step 6: Run the checks**

```bash
cd cli
npx vitest run src/cable/serial.spec.ts                                              # 23 passed
npx vitest run src/cable/cableFleet.spec.ts src/lib/periodicCpu.integration.spec.ts  # all pass, 1 skipped
npm run typecheck                                                                    # no error, about a minute
git diff -U0 -- src/cable/serial.ts | grep -c 'DIAL_VENDOR_ID\|DIAL_PRODUCT_ID\|TOOL_TIMEOUT_MS = '   # 0
```

- [ ] **Step 7: Commit**

```bash
git add cli/src/cable/serial.ts
git commit -m "Cable: macOS dial discovery asks ioreg for the serial ports only (0.07 s, was 7.7 s, past the 5 s timeout)"
```

---

### Task 2: The trimmed real dump

**Depends on:** nothing. **Effort:** high (a real machine's dump: what stays in it is checked line by line).

**Files:**
- Create: `cli/src/cable/__fixtures__/ioregSerialClients.txt`

**The test that fails before the change:** none: no behavior. It is a data file; Task 3's test reads it.

**Interfaces:**
- Produces: the fixture. In it, the dial's `IOCalloutDevice` is `/dev/cu.usbmodem21101`, its serial number
  `AA:BB:CC:DD:EE:01` (made up), its device node's `sessionID` `26004684572539`, the hub's `26004667014204`.

The capture is `narrow.txt`: the new query's output on the reporting Mac on 2026-11-14, in the orchestrator's
session scratchpad. Its path comes with the task brief, not with this plan: it names a local account. It holds the
Mac's serial numbers, addresses and console user, so it is read from where it is and never copied into the repo.

- [ ] **Step 1: Find the capture**

Run: `shasum -a 256 "$CAPTURE"`
Expected: `ac42c685dcab1a69fa40fbfa9022c2ef6a06a6e07e812bb54b34e046733144ee`.

If the file is gone (a scratchpad does not outlive a reboot), take a new one on this Mac with a dial plugged in
behind a hub, read-only: `ioreg -r -c IOSerialBSDClient -t -w0 -l > "$CAPTURE"`. The hash and the counts of Step 3
then differ, and Task 3 uses the new path and `sessionID`: say so, with both values, in the task report.

- [ ] **Step 2: Trim it with a throwaway script**

The rule: every node keeps its `+-o` line. A node keeps its properties only when it is a serial port
(`IOSerialBSDClient`), or a USB device (`IOUSBHostDevice`) or anything below one in its chain. The platform node's name
(the Mac's model code) becomes `J000AP`. The dial's serial
number is replaced wherever it stands (as text, and as hex inside `UsbDeviceSignature`), and the hub's
`kUSBContainerID` by zeros. Nothing else changes: the order of the chains, the `|` margins and the trailing spaces
stay as ioreg printed them. Save this outside the repo (the session's scratchpad) as `trim-ioreg.mjs`:

```js
// Throwaway: trims a capture of `ioreg -r -c IOSerialBSDClient -t -w0 -l` into the test fixture. Never committed.
import { readFileSync, writeFileSync } from 'node:fs'
const [capture, fixture] = process.argv.slice(2)
const MADE_UP = 'AA:BB:CC:DD:EE:01'
const hex = (text) => Buffer.from(text, 'ascii').toString('hex')

// One entry per node: its `+-o` line and the property lines under it.
const nodes = []
for (const line of readFileSync(capture, 'utf8').split('\n')) {
  if (line.includes('+-o')) nodes.push({ header: line, block: [] })
  else nodes.at(-1)?.block.push(line)
}
// A node keeps its properties when it is a serial port, or a USB device or anything below one in its chain.
let inUsb = false
const kept = nodes.flatMap(({ header, block }) => {
  if (header.startsWith('+-o')) inUsb = false // each chain starts again at its Root
  if (header.includes('<class IOUSBHostDevice,')) inUsb = true
  return inUsb || header.includes('<class IOSerialBSDClient,') ? [header, ...block] : [header]
})
// The dial's serial number, read from its own node, then replaced wherever it appears.
const dials = nodes.filter(({ header, block }) => header.includes('<class IOUSBHostDevice,')
  && block.some(line => /"idVendor" = 12346$/.test(line)) && block.some(line => /"idProduct" = 4097$/.test(line)))
const serials = dials.map(({ block }) => block.join('\n').match(/"USB Serial Number" = "([^"]+)"/)?.[1])
if (serials.length !== 1 || !serials[0]) throw new Error(`expected one dial with a serial number, found ${serials.length}`)
let text = kept.join('\n').replace(/\n+$/, '\n')
text = text.split(serials[0]).join(MADE_UP).split(hex(serials[0])).join(hex(MADE_UP))
text = text.replace(/("kUSBContainerID" = ")[^"]*"/g, '$100000000-0000-0000-0000-000000000000"')
// The repo is public: the Mac's model code (the platform node's name) becomes a generic one.
text = text.replace(/(\+-o )\S+(  <class IOPlatformExpertDevice,)/g, '$1J000AP$2')
writeFileSync(fixture, text)
```

Run, from the repo root: `node "$SCRATCH/trim-ioreg.mjs" "$CAPTURE" cli/src/cable/__fixtures__/ioregSerialClients.txt`

- [ ] **Step 3: Check what is in it**

```bash
F=cli/src/cable/__fixtures__/ioregSerialClients.txt
shasum -a 256 $F          # differs from the rehearsal's e4d03116… since the model code became J000AP (PM, 2026-11-14): report it
wc -lc < $F               # 231 lines, 15976 bytes
grep -c '+-o' $F          # 32 nodes: 9 (debug-console), 15 (the dial), 8 (Bluetooth), in that order
grep -c -E '^[ |]*\{$' $F # 9 nodes with properties: the hub, its driver, its port, the dial, its interface, the CDC driver, three serial ports
grep -n -i -E 'IOConsoleUsers|kCGSSession|IOPlatformUUID|IOPlatformSerialNumber|serial-number|mac-address|BD_ADDR|BTAddress|DeviceAddress|Build Version' $F   # prints nothing
node -e '
const [c, f] = process.argv.slice(1).map(p => require("fs").readFileSync(p, "utf8"))
const serials = [...new Set([...c.matchAll(/"(?:USB Serial Number|kUSBSerialNumberString)" = "([^"]+)"/g)].map(m => m[1]))].filter(s => s !== "000000001")
const left = serials.filter(s => f.includes(s) || f.includes(Buffer.from(s).toString("hex")))
console.log(serials.length, "real serial number(s) in the capture,", left.length, "left in the fixture")
' "$CAPTURE" $F           # 1 real serial number(s) in the capture, 0 left in the fixture
(cd cli && npx tsx -e "
import { readFileSync } from 'node:fs'
import { parseDarwinDialPorts } from './src/cable/serial.ts'
console.log(JSON.stringify(parseDarwinDialPorts(readFileSync(process.argv[1], 'utf8'))))
" "../$F")                # [{"path":"/dev/cu.usbmodem21101","vendorId":12346,"productId":4097,"serialNumber":"AA:BB:CC:DD:EE:01"}]
```

`000000001` is the hub's factory serial number, the same on every unit, and stays. Then read the 231 lines once:
USB descriptors, driver names and three serial ports, nothing that names this Mac's owner or the Mac itself beyond
Apple's driver class names (`AppleT600xIO`). The platform node is `J000AP` in all three chains: the capture's model
code is in no line of the fixture.

- [ ] **Step 4: Commit**

```bash
git add cli/src/cable/__fixtures__/ioregSerialClients.txt
git commit -m "Cable: a trimmed real dump of the serial-port ioreg query, for the discovery tests"
```

---

### Task 3: A dial's `sessionID` is read in either property order

**Depends on:** Task 2 (its test reads the fixture). **Effort:** high. Shares `serial.ts` with Task 1, on other
lines.

**Files:**
- Modify: `cli/src/cable/serial.ts:161-208` (`parseDarwinDialPorts`)
- Test: `cli/src/cable/cableFleet.spec.ts` (`describe('macOS USB inventory')`, lines 581-633; the imports on lines
  2 and 5)

**Interfaces:**
- Consumes: Task 2's fixture and its four values.
- Produces: `parseDarwinDialPorts(dump: string): DialPort[]`, signature unchanged; `session` is the USB device
  node's own `sessionID` wherever it stands among the node's properties.

**The tests that fail before the change:** three cases of `macOS USB inventory` in `cli/src/cable/cableFleet.spec.ts`:
the property-order case with its new device, and the two new cases. Each is red on a missing `session`.

- [ ] **Step 1: The property-order case gains a device**

In `associates each tty with its own matching USB parent and serial in either property order`, between the last
line of `Tux` and `+-o console`, add:

```
  +-o Tam
    "sessionID" = 26004684572539
    "idProduct" = 4097
    "idVendor" = 12346
    "USB Serial Number" = "CC:03"
    +-o interface
      "idProduct" = 4097
      "sessionID" = 98
      "idVendor" = 12346
      "USB Serial Number" = "CC:03"
      +-o serial
        "IOCalloutDevice" = "/dev/tam"
```

and the comment and the expectation become:

```ts
    // The attachment identity is the USB device's own sessionID, wherever it stands among the ids (a real dump
    // lists it first), not one from a node below it.
    expect(parseDarwinDialPorts(dump)).toEqual([
      device('/dev/tim', 'AA:01'),
      { ...device('/dev/tux', 'BB:02'), session: '14351572441873' },
      { ...device('/dev/tam', 'CC:03'), session: '26004684572539' },
    ])
```

- [ ] **Step 2: Two new cases, after it and before `describe('dial scan gate')`**

`readFileSync` joins the `node:fs` import and `fileURLToPath` the `node:url` import.

```ts
  it('reads one chain per serial port, as ioreg -t prints them: two dials behind one hub keep their own serial and session', () => {
    const dump = `+-o Root
  +-o hub
    "idVendor" = 8457
    "idProduct" = 10261
    "sessionID" = 100
    +-o Tim
      "sessionID" = 101
      "idProduct" = 4097
      "idVendor" = 12346
      "USB Serial Number" = "AA:01"
      +-o serial
          "IOCalloutDevice" = "/dev/cu.usbmodem1101"
+-o Root
  +-o hub
    "idVendor" = 8457
    "idProduct" = 10261
    "sessionID" = 100
    +-o Tux
      "idProduct" = 4097
      "idVendor" = 12346
      "USB Serial Number" = "BB:02"
      +-o serial
          "IOCalloutDevice" = "/dev/cu.usbmodem1201"
+-o Root
  +-o bluetooth
    +-o serial
        "IOCalloutDevice" = "/dev/cu.Bluetooth-Incoming-Port"`
    // Tux lists no sessionID: the hub's above it is not its attachment.
    expect(parseDarwinDialPorts(dump)).toEqual([{ ...device('/dev/cu.usbmodem1101', 'AA:01'), session: '101' }, device('/dev/cu.usbmodem1201', 'BB:02')])
  })

  it('finds exactly the dial in a real dump of the serial-port query, with its device node\'s own session', () => {
    // `ioreg -r -c IOSerialBSDClient -t -w0 -l` on the Mac of the 2026-11-14 report: the chains of debug-console, a
    // dial behind a USB hub, and the Bluetooth port. Trimmed: only the USB nodes and the serial ports keep their
    // properties (the others name the console user, the Mac's serial numbers and its addresses), and the dial's
    // serial number is made up.
    const dump = readFileSync(fileURLToPath(new URL('./__fixtures__/ioregSerialClients.txt', import.meta.url)), 'utf8')
    // 26004684572539 is the dial's own sessionID, listed before its ids; the hub above it has 26004667014204.
    expect(parseDarwinDialPorts(dump)).toEqual([{ ...device('/dev/cu.usbmodem21101', 'AA:BB:CC:DD:EE:01'), session: '26004684572539' }])
  })
```

- [ ] **Step 3: See them fail**

Run: `cd cli && npx vitest run src/cable/cableFleet.spec.ts -t "macOS USB inventory"`
Expected: `3 failed | 11 passed | 33 skipped (47)`. The three are the cases of Steps 1 and 2, each with the path and
the serial number right and `session` missing (`/dev/tam`, `/dev/cu.usbmodem1101`, `/dev/cu.usbmodem21101`).

- [ ] **Step 4: Commit the red tests**

```bash
git add cli/src/cable/cableFleet.spec.ts
git commit -m "Cable: tests for a dial's sessionID listed before its ids, on a real dump and with two dials behind a hub"
```

- [ ] **Step 5: `parseDarwinDialPorts` keeps the current node's `sessionID`**

A `session` variable beside `serialNumber`, handled the same way: cleared at each `+-o` line, set by the node's
`"sessionID"` line, and copied into `armedSession` when the node arms (where `armedSerial = serialNumber` is). A
`"sessionID"` line that comes after the arm, at the armed depth, still sets `armedSession`, as today. One below the
armed depth sets only the lower node's own `session`, which nothing reads. The comment on the `"sessionID"` line
becomes:

```ts
    // The USB device node's own sessionID (the interfaces below it carry ones of their own). Kept as it is read,
    // like the serial number, because the node may list it before its ids: the real dump of 2026-11-14 does, and
    // a parser that waited for the match never set `session` on macOS.
```

- [ ] **Step 6: Run the checks**

```bash
cd cli
npx vitest run src/cable/cableFleet.spec.ts                                       # 47 passed
npx vitest run src/cable/serial.spec.ts src/lib/periodicCpu.integration.spec.ts   # 26 passed | 1 skipped
npm run typecheck                                                                 # no error, about a minute
```

- [ ] **Step 7: Commit**

```bash
git add cli/src/cable/serial.ts
git commit -m "Cable: a dial's session is read on macOS whatever the order of its USB properties"
```

---

## Verification

On the final head, after the review. Everything is local to the reporting Mac (macOS, arm64) and read-only: `ioreg`,
a listing of `/dev/cu.*`, and Vitest's own throwaway folders (`cli/vitest.setup.ts`). No backend, no account, no
sign-in, no production; nothing of the developer's daemon (port 18473), `~/.harness`, `~/.claude` or `~/.codex`. No
port is opened, so the shared dial stays with whoever holds it. `dist/cable/serial.js` imports Node's own modules
and `portStream.js` only: it reads no config and no state folder. None of these checks needs Diego himself.

1. **The specs and the typecheck.**

   ```bash
   cd cli
   npx vitest run src/cable/serial.spec.ts src/cable/cableFleet.spec.ts src/lib/periodicCpu.integration.spec.ts
   npm run typecheck
   ```

   To see: `Test Files 3 passed (3)`, `Tests 73 passed | 1 skipped (74)` (the base: `71 passed | 1 skipped (72)`);
   the typecheck prints no error.

2. **Both queries, three runs each: the numbers before and after.** In bash. About 24 s of one core, for the old
   query.

   ```bash
   for q in "IOUSBHostDevice" "IOSerialBSDClient -t"; do for i in 1 2 3; do
     ( /usr/bin/time -p ioreg -r -c $q -w0 -l | wc -c ) 2>&1 | tr '\n' ' '; echo "<- $q"
   done; done; uptime
   ```

   To see, as recorded here on 2026-11-14 at load 16: the old query `real 7.86 user 0.16 sys 7.65`, 4578942 bytes;
   the new one `real 0.08 user 0.01 sys 0.06`, 336460 bytes. The pass is every run of the new query under 1 s real,
   against a timeout of 5 s. The old query's numbers depend on what is plugged in: record them as they come. The
   six lines and the load go in the pull request body.

3. **The built CLI's `findDialPorts()` returns the dial with its session.** Needs a dial plugged into this Mac; it
   is not opened.

   ```bash
   cd cli && npm run build && ls /dev/cu.usbmodem*
   /usr/bin/time -p node --input-type=module -e '
   // Read-only: lists /dev/cu.*, runs ioreg, opens no port. The serial number is masked: it is not for a pull request.
   const { findDialPorts } = await import("./dist/cable/serial.js")
   const started = performance.now()
   try {
     const ports = await findDialPorts()
     console.log(JSON.stringify(ports.map(port => ({ ...port, ...(port.serialNumber ? { serialNumber: "<set>" } : {}) }))))
   } catch (error) { console.log(String(error)) }
   console.log(`${Math.round(performance.now() - started)} ms`)
   '
   ioreg -r -c IOSerialBSDClient -t -w0 -l | awk '/\+-o/ { dial = /USB JTAG\/serial debug unit@.*IOUSBHostDevice/ } dial && /"sessionID"/'
   ```

   One shell call, in bash. `cli/dist` is ignored build output: remove it afterwards if this check made it.

   To see: one port,
   `[{"path":"/dev/cu.usbmodem<digits>","vendorId":12346,"productId":4097,"serialNumber":"<set>","session":"<digits>"}]`,
   its path the one `ls` printed, in under 1000 ms, with `sys` under 0.5 s; the last command prints one `sessionID`
   line with the same digits as `session`. The same command at the base (`447b4a07e3`, 2026-11-14) printed
   `SerialToolTimeoutError: ioreg did not answer in 5 s`, `5011 ms`, `real 7.47 user 0.16 sys 7.26`. With no dial
   plugged in it prints `[]`: report the dial half as unverified, never as passed; the timing still counts.

Not checked here, and said so in the pull request: a live attach (the daemon greeting the dial) needs the shared dial
and the running daemon's port, and the spec leaves it to the next device run; an Intel Mac and other macOS versions
are an unverified row, with no such machine at hand.

On GitHub nothing is started by hand. PR CI runs by itself what a `cli/` change selects: `cli-typecheck`,
`cli-tests` (Linux: Task 3's cases run, the wiring case is skipped), `companions`, `pty-checks`, and `os-checks`,
which reads `serial.ts` for the two dial ids.

**Temporary workflow:** none. No check here is long, and what they read is this Mac's IORegistry with a dial plugged
in, which no runner has.

**Checks PR CI does not run:** `cli-serial` (`npx vitest run src/cable/serial.real.spec.ts --maxWorkers=1`, macOS;
real PTYs, no USB device), which `scripts/local-checks.py` requires for a change to `cli/src/cable/serial*.ts`. Run
`python3 scripts/local-checks.py --run` from a clean tree at the final commit and paste its fence into the pull
request body. `npm run test:core` and `test:harnessd` do not apply: nothing under `cli/src/core/`,
`cli/src/services/` or `cli/src/harnessd/` changes.
