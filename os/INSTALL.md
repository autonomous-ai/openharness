# Install Harness on a ThinkPad

These instructions are for **0.1.1**, using a Mac to prepare the USB.
The USB opens the installer directly. Installation begins only when you choose **Install Harness**
in the installer; it erases the entire selected disk.

## 1. Prepare

- An x86-64 Intel or AMD ThinkPad with SSE4.2 for bundled OpenCode. Core 2 and
  32-bit-only CPUs are outside the bundled agent's supported baseline.
- A USB stick of at least 4 GB. Flashing replaces its contents.
- An internal disk of at least 12 GiB, with important files backed up elsewhere.
- AC power. Installation works offline; using a cloud agent after installation needs a connection.

Start with 2 GiB RAM or more. Preview 4 passed installation, reboot, recovery
and a first OpenCode conversation in 1 GiB VMs; each new image repeats the native
installation and boot checks before publication. Allow more memory for browser
tabs, concurrent agents and local models.
Preview 4 was installed, booted and used on a physical ThinkPad by the user. Wi-Fi, suspend and GPU
compute still need testing on the actual hardware.

## 2. Download and verify on the Mac

From the [0.1.1 release](https://github.com/autonomous-ai/openharness/releases/tag/os-v0.1.1),
download both files into the same folder:

- `harness-0.1.1-x86_64.iso`
- `harness-0.1.1-x86_64.iso.sha256`

If they are in Downloads, open Terminal and run:

```sh
cd ~/Downloads
shasum -a 256 -c harness-0.1.1-x86_64.iso.sha256
```

The result must say `harness-0.1.1-x86_64.iso: OK`.
If it does not, download the files again before flashing.

## 3. Flash the USB

1. Open [balenaEtcher](https://etcher.balena.io/).
2. Choose **Flash from file** and select the ISO.
3. Choose **Select target** and select your USB by its name and capacity.
4. Choose **Flash**. If macOS asks for administrator authentication, enter your
   Mac password in its dialog. Let Etcher finish validation.
5. Eject the USB.

Use an image writer; copying the ISO onto a formatted USB does not create bootable
installation media. If macOS calls the flashed disk unreadable, choose **Ignore**
or **Eject**. Do not initialize it.

## 4. Boot the ThinkPad from USB

1. Shut down the ThinkPad and insert the USB.
2. Power on and tap **F12** at the Lenovo logo. Depending on the model, use
   **Fn+F12**, or **Enter** first and then **F12**.
3. Select the USB. Prefer its UEFI entry when available; legacy BIOS also works.
4. If firmware rejects the image, enter setup with **F1** and disable **Secure
   Boot**. This preview is unsigned. Leave TPM enabled.
5. Choose the default **Install Harness** boot entry.

The exact menu wording varies by model. See Lenovo's
[boot-menu instructions](https://docs.lenovocdrt.com/ref/bios/startup_menu/).
If the USB is absent, try another USB port and check that USB boot is enabled.

The USB opens the install form immediately, with the first eligible disk selected
and Password focused. Installation needs no network connection or Harness account.

### Installing on an older Intel Mac

Intel Macs with a 64-bit EFI and no T2 chip are an experimental target. The USB
includes optional support for selected Broadcom radios, but no physical Mac
model has passed our complete hardware checks yet. This image is not the
Apple Silicon or T2 installation path. The installer refuses detected Apple T2 Macs
before collecting passwords or changing the disk; their required driver stack is
not bundled. Core 2 CPUs cannot run bundled OpenCode; this is not a supported bundled-agent target.

Shut down, insert the USB, then hold **Option (⌥)** while turning on the Mac.
Choose the external **EFI Boot** entry. Apple's
[startup-key guide](https://support.apple.com/en-us/102603) describes that menu.
Installation uses the same form below and erases the whole selected disk, including
macOS. Keyboard, Wi-Fi, brightness and sound still need physical validation for
each Mac family; the generic PC image does not establish that compatibility.

For a hardware report, open a terminal and run `harness hardware`. Keep that
report with the Mac's model and the behavior you observed. It contains device
IDs and driver names, without serial numbers or Wi-Fi passwords.

## 5. Install

The USB opens the native form with four fields:

1. **Disk:** the first eligible disk is selected. Check its model and capacity.
   To change it, focus Disk and press Enter. The live USB is excluded.
2. **Encryption:** enabled initially. Use Space to change it if needed.
3. **Password:** focused when the form opens; type your new system password.
4. **Repeat password:** enter it again.

Use Tab or the arrow keys to move between fields. This preview uses a **US keyboard
layout**, including at disk unlock. Passwords cannot be empty; there is no minimum
length restriction.

Check the selected disk, then choose **Install Harness** and press Enter. **This immediately
erases that disk. There is no second confirmation screen.** Choosing a disk alone
does not start installation. Esc leaves the picker or resets the main form without writing to the disk.

The account and computer name are set to **`me@harness`**. Installation works offline.
When **Harness is installed.** appears, choose **Shut down**. Once the ThinkPad is
off, remove the USB and power it on.

## 6. First boot

With encryption enabled, the Harness logo appears with **Enter your password**.
Enter the installation password. Harness then opens without another account
setup or login prompt. With encryption disabled, log in as **`me`** using that
password.

The password initially protects both the account and, when enabled, the encrypted
disk. Changing the account password later does not change the disk password.
There is no cloud account that resets the disk password.

First boot opens OpenCode on the left and two terminal panes on the right.
If disconnected, Wi-Fi opens first. **Super+t** opens a terminal if you need to
work offline or fix networking.
Subsequent launches restore your existing work. **Super+w** opens network setup from any
pane. Ethernet connects automatically when available.

OpenCode is already installed and uses its upstream defaults. Available models
may change. Other agents install when selected and follow their own account and
model setup. A Linux account does not sign you into an agent provider.

## 7. Use it

**Super** means the Windows-logo key on a PC keyboard, or Command on a Mac keyboard
running Harness OS. These shortcuts require no Shift and no Ctrl+b prefix. The
shared TUI's Ctrl+b shortcuts remain available; release the prefix before pressing
the next key. A capital letter in a prefix binding means Shift + letter.

| Keys or command | Action |
| --- | --- |
| Super+n | New Harness: choose an agent |
| Super+t | New terminal: open a shell directly |
| Super+m | Connect a computer |
| Super+w | Connect to Wi-Fi |
| Super+b | Open/focus Chromium, or return to Harness |
| Super+e | Open/focus the file manager, or return to Harness |
| Super+o | Open a folder (in the file manager) or a text file (in its editor) |
| Super+Enter | Focus Harness |
| Super+l | Lock; unlock with the account password |
| Print or Super+p | Screenshot the whole screen |
| Shift+Print or Super+r | Screenshot a region dragged with the pointer (Esc cancels) |
| Super+u | Update Harness |
| `hn-browser http://localhost:3000` | Open a local project in the browser |
| `sudo systemctl poweroff` | Shut down |

Claude Code, Codex, OpenCode and pi each run in their own pane. Let the agent
install the tools the project needs. Save work under `~/projects`.

## 8. Updates

Press **Super+u** to update. The **Update** button in `harness updates` does the
same thing with a mouse. No confirmation or password is needed. New hn/CLI
releases download in the background; applying them reconnects the screen while
running agents and terminals stay alive.

System updates retain a recovery checkpoint. If a restart is needed, keep
working and choose **Restart** when ready. **Done** leaves the computer running.
The approved update finishes any remaining runtime release after reboot.
Routine updates do not need another USB flash.

Preview 5 through 11 still use their old update screen to install this change:
**Super+u**, then **s**, then the account password. After restarting, the simpler
control is available. Projects are preserved.

The USB starts installation directly. Wi-Fi setup runs after the first installed
boot and advances into OpenCode and two terminals. USB installer changes need a
new ISO; existing computers receive installed-system changes through Updates.

Preview 4 needs the 7.2 MB [preview 7 bootstrap bundle](https://github.com/autonomous-ai/openharness/releases/download/os-v0.1.0-preview.7/harness-update-0.1.0-preview.7-47872670a-x86_64.zip)
once. Verify and extract that bundle, open a terminal in its folder, and run:

```sh
sha256sum -c SHA256SUMS
sudo python3 apply-update.py apply "$PWD"
```

Reboot when it finishes; subsequent updates are available through Super+u.
If the bootstrap fails, use `sudo python3 apply-update.py rollback` from that
same folder before trying again.

## 9. First manual test

1. Boot with the USB removed. Confirm disk unlock.
2. Connect Wi-Fi if needed. Confirm OpenCode and two terminals appear.
3. Ask OpenCode to build a small website in `~/projects/hello`, run
   its server, and give you the address. Open it with `hn-browser ADDRESS`.
4. Ask an agent to build and test a command-line program, installing tools as needed.
5. Switch between Harness and the browser. Lock and unlock the computer.
6. Reboot. Confirm that the files remain and Harness opens again.
7. Try brightness keys, lid-close/suspend and resume. Report failures with the
   ThinkPad model; these need physical testing.

Measure installation from pressing Install to the completion screen, separately
from flashing and filling in the form. For encrypted boot, record the time to the
unlock screen and the time from submitting the password to Harness separately.

If something fails, keep the exact error and ThinkPad model. `hn-os status` and
`hn-os measure` provide system information. Keep passwords and agent tokens private.
The [OS README](https://github.com/autonomous-ai/openharness/blob/main/os/README.md#updates-and-recovery) describes updates and recovery.

## Older USB images

Preview 8 can finish writing the system, run `sync`, and successfully unmount
`/mnt/harness-os`, then report `cryptsetup close ... returned non-zero exit status 5`
with `Device ... is still in use`. Check `/var/log/harness-install.log`: if those
are the final steps, shut down normally with `sudo systemctl poweroff`, remove the
USB once off, and try the installed disk. Reinstallation is usually unnecessary.
If an earlier installation step failed, that error still needs diagnosis; reaching
the cleanup command alone does not prove that installation finished.

Preview 2 may report `Live system payload is missing` after copying the image into
RAM. If `/run/archiso/copytoram/airootfs.sfs` exists, its workaround is:

```sh
sudo hn-os install --source /run/archiso/copytoram/airootfs.sfs
```

Preview 2 can also list the boot USB as a target in RAM mode; choose the internal
disk carefully. Preview 3 and later detect both payload locations and exclude the
boot USB. A working installed system does not need reinstalling solely for that fix.
