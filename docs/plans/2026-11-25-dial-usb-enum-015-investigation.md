# Round dial stops enumerating over USB after the 0.1.5 OTA: investigation

Date: 2026-11-25. Read-only investigation; nothing was flashed, no serial port opened, no OTA or manifest touched.

## Report (customer, 2026-11-25)

macOS, Acer USB hub, same cable throughout. 0.1.4 stable 19-20/11. 0.1.5 installed 23/11 16:35 (Mountain); then the
port dropped 13 times in 6 minutes (ENXIO), the dial "did not reboot"; since 16:39 macOS lists no dial (no
`/dev/cu.usbmodem*`, ioreg shows the hub and nothing on it) on both Mac USB-C ports and both hub USB-A ports. The
screen shows only the "Harness" wordmark.

## 1. What changed between the published 0.1.4 and 0.1.5

Both published images were downloaded from the public bucket and their app descriptors read:

| | 0.1.4 | 0.1.5 |
|---|---|---|
| sha256 | `218cc310…9f88` | `ebcec35e…9bb9` (matches the manifest) |
| size | 2,705,616 B | 2,705,344 B |
| built | Nov 19 2026 07:23:55 | Nov 23 2026 14:28:13 |
| IDF | v5.5.4 | v5.5.4 |

Source: 0.1.5 = `main` f15107c0b9 (release notes). 0.1.4 was built after b3ae863220 (#4467, the last firmware commit
before its build time). Firmware changes on `main` between them (`git log -- devices/harness-device/`): **one commit,
#4557** ("tapping a finished-turn card keeps its recap"): 29 lines in `main/ui/habitat/ui_habitat.c` removing the
recap-dismiss state, plus a test and two docs. Nothing in USB, the cable link, power, sleep, watchdog, the PMIC or
sdkconfig.

The binaries agree with that:
- Same 6 segments. The IRAM code segment (0x40375554, 50,872 B: ISRs and IRAM drivers) is **byte-identical**; rodata,
  DRAM and IRAM vectors have identical sizes; only the flash text segment shrank, by 276 B.
- The readable strings of both images are the same set (no new or removed log line, driver, or config string).
- Both use USB-Serial-JTAG (`CONFIG_ESP_CONSOLE_USB_SERIAL_JTAG`, `usb_serial_jtag_driver_install`); no TinyUSB, no
  `esp_pm`/light sleep/deep sleep, no USB PHY or pad code, no GPIO19/20 use, no eFuse writes anywhere in `main/`.
- #1422/#1423 (link heartbeat, seq/resync, crash crumbs) are Harness Pro firmware, not the round dial.

**Conclusion: 0.1.5 carries no change that can touch USB.** A firmware cause would have to exist in 0.1.4 too.

### How a running app could leave the dial un-enumerated, and whether this one can

On the ESP32-S3 the USB-Serial-JTAG controller is enumerated by the silicon (fixed PHY, internal D+ pull-up), not by
app code. The CPU can be hung, panicking or in ROM download mode and the host still lists `303a:1001`. An app makes it
vanish only by: switching the PHY to USB-OTG (TinyUSB), driving GPIO19/20 as GPIOs, turning the pad pull-up off via
registers, deep or light sleep with USB power-down, or burning `DIS_USB_SERIAL_JTAG`/`USB_PHY_SEL` eFuses. This
firmware does none of these. A reset loop shows as repeated re-enumerations, not as a device that never appears, and
the "Harness" screen is what the running app draws whenever it is not connected (`ui_habitat.c` `render_brand` when
`!s.connected`), so the app was still running and drawing.

## 2. Can the host drive the dial into that state?

No path found.
- The daemon opens the port with `open(O_RDWR|O_NOCTTY|O_NONBLOCK)` + `stty raw clocal` (`cli/src/cable/serial.ts`);
  it never sets DTR/RTS on the round dial. Open/close raise and drop both lines together, which is neither the
  USB-Serial-JTAG reset (RTS high, DTR low) nor the download sequence.
- The only reset over the cable (`boardReset.ts`) runs for a silent **Harness Pro** (`cableFleet.ts`), not the round
  dial.
- Even a host-caused reset or download-mode entry leaves the dial enumerated (ROM and bootloader use the same
  controller). An ENXIO storm on the host side is the effect of the device leaving the bus, not a cause.
- #4588 only changes when the daemon scans (on the OS's arrival signal); it opens nothing new.

## 3. Most likely cause

The USB data pair is not reaching the Mac, while power is (screen on):
- 13 drops in 6 minutes, then nothing on any port with the same cable, is the shape of an intermittent then open data
  line: the cable's D+/D-, the dial's USB-C receptacle, or the 4-wire link from the port to the main board (the
  housing's USB-C port PCB with `V`, `-D`, `+D`, `G` pads; the main board's `WAFER-MX1.25-4P` U2).
- The timing fits a physical fault surfacing under load: the cable OTA streams 2.7 MB at full speed, then the dial
  reboots (a re-enumeration), and devices often get moved or replugged around an update.
- Our own dial on 0.1.5 shows a few ENXIO on 23/11 only, which is what an OTA reboot (and any rollback check)
  produces.

Not excluded without the customer: a board with the AXP2101 and a battery keeps the SoC running across replugs, so
"tried every port" did not power-cycle it. Step 1 below covers that.

### Conditions that could make one dial lose USB (0.1.5 runs normally on Diego's dial)

| Condition | Can it explain "never listed again"? |
|---|---|
| Half-written or corrupt OTA image | No. `fw_update.c` calls `esp_ota_end` (image check) and re-reads the whole slot against the published sha256 **before** `esp_ota_set_boot_partition`; a bad write never becomes the boot slot. A bad image that did boot is rolled back by the bootloader. And the dial is drawing its "not connected" screen, so a valid app runs. |
| Board A (AXP2101 + battery) vs board B | Same USB path on both; but board A's SoC is never power-cycled by a replug, so whatever state it is in survives every port the customer tried. |
| Host ENXIO chain (open/close storms, #4588 rescans) | No. ENXIO is the result of the device leaving the bus. The daemon never toggles the round dial's DTR/RTS apart from open/close. |
| Acer hub | Not as a software state. As hardware: a hub with poor VBUS or ground (or a hot-plug transient) is a classic way to stress or damage the data path (the USBLC6 ESD array D1, or the S3's USB pins) while power still flows. The 13 drops all happened through the hub. |
| Cable / receptacle / port-PCB wiring | Yes, the best fit: intermittent then open data line, power intact. |

No evidence of a general 0.1.5 fault, so no rollback.

## 4. Recovery steps for the customer

Decisive test first: the ROM's download mode enumerates with no app code at all.

Two boards ship (`board_table.c`): board A has the AXP2101 PMIC, a battery and two keys (PWR on the PMIC, BOOT on
GPIO0); board B has no PMIC and one key (BOOT). On board B unplugging is a power cycle; on board A it is not.

1. Unplug the dial. If it stays lit (board A), hold PWR until the screen goes dark: firmware leaves REG 0x27 at its
   default, so the AXP2101's own long press power-cycles the chip and the dial restarts (`board/power.c`, `ptt.c`);
   if it stays dark, press PWR to start it. Plug it in directly to the Mac with **a
   different cable known to carry data** (one that syncs a phone), and try the USB-C plug **both ways round at the
   dial end**. Check `ls /dev/cu.usbmodem*`.
   - Listed: the dial is fine; the old cable or its orientation was the fault. Nothing to flash.
2. Still not listed: ROM download mode. The chip must start with BOOT (GPIO0) held low; GPIO46 is pulled down on the
   board. Holding BOOT on a running dial only turns the screen off (`ptt.c`, 800 ms), so the chip has to start
   while it is held:
   - board B: unplugged; hold BOOT, plug the cable into the Mac directly (no hub), release after 2 s;
   - board A: hold BOOT and, still holding it, do step 1's long PWR press (and the short one if it stays dark), so
     the restart starts with BOOT low; release BOOT 2 s after PWR.
   The screen stays dark or frozen; that is expected.
   - Run `ls /dev/cu.usbmodem*` and `ioreg -p IOUSB -l | grep -i -A2 "USB JTAG"`. A `303a:1001` "USB JTAG/serial
     debug unit" means the USB path works and the app image is at fault: go to step 3.
   - Nothing even in download mode: the fault is physical (cable, receptacle, port PCB wiring). No software can fix it;
     the unit comes back for repair or replacement.
3. Only if download mode enumerates: `harness flash` (newest published build, sha256-checked against the manifest).
   **Keep holding BOOT for the whole flash** and release it only when it prints `>> flashed.`. Why: flash-circle's
   board probe ends with `--after hard_reset` (`flash-circle.sh` line 317), so the chip leaves download mode and boots
   the app; if the app's USB is the part that is gone, the next esptool step finds no port. With GPIO0 held low,
   every reset lands back in download mode, so all three esptool calls (probe, erase otadata, write app) reach it.
   After `flashed.`, release BOOT and power-cycle (board B: replug; board A: long PWR, then PWR only if it stays
   dark). The script's read-back of the version may warn while BOOT is held; that warning is not fatal. Then check
   the screen and `ls /dev/cu.usbmodem*`.
   - `harness flash` stops Harness first and starts it again after, so the daemon does not grab the port mid-write.
   - `--version 0.1.4` also works (`0.1.4.bin` is public, no published sha256 to check), but the daemon offers 0.1.5
     again within seconds of reconnecting (clean semver below published). Not useful: the two share every USB byte.

What to ask the customer for (fixed-word lines and counts only): from the daemon log around 23/11 16:30-16:40, the
count of `cable: closed (` lines and their reasons, the `on fw` lines with their `board ...` field (says whether the
dial has the `axp2101` PMIC), and any `reset reason:` lines (a crash or brownout would show as `panic`,
`task watchdog` or `brownout`, not `power-on`).

## 5. Proposal

- **Firmware fix: none proposed yet.** No change between 0.1.4 and 0.1.5 can affect USB, and the app cannot
  un-enumerate USB-Serial-JTAG. A fix without a root cause would be a guess. If step 2 shows download mode enumerating
  while the app does not, that is new evidence; then the work reopens with a host test of whatever it points to.
- **OTA manifest rollback to 0.1.4: not recommended** (Diego decides). 0.1.5 runs normally on Diego's dial, 0.1.4 and
  0.1.5 share every USB-relevant byte, and no general fault was found.
- Possible follow-up, only if the customer confirms "download mode enumerates, app does not": a `flash-circle`
  option or rule to probe with `--after no_reset` so a board already in download mode stays there. Today the
  hold-BOOT-throughout step covers it without a code change.
