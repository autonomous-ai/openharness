# Install Harness on a ThinkPad

These instructions are for **0.1.0-preview.6**, using a Mac to prepare the USB.
The USB starts a live session. Installation begins only when you choose **Install**
in the installer; it erases the entire selected disk.

## 1. Prepare

- An x86-64 Intel or AMD ThinkPad with SSE4.2 for bundled OpenCode. Core 2 and
  32-bit-only CPUs are outside the default agent trial's supported baseline.
- A USB stick of at least 4 GB. Flashing replaces its contents.
- An internal disk of at least 12 GiB, with important files backed up elsewhere.
- AC power. Installation works offline; trying a cloud agent needs a connection.

Start with 2 GiB RAM or more. Preview 4 passed installation, reboot, recovery
and a first OpenCode conversation in 1 GiB VMs; each new image repeats the native
installation and boot checks before publication. Allow more memory for browser
tabs, concurrent agents and local models.
Preview 4 was installed, booted and used on a physical ThinkPad by the user. Wi-Fi, suspend and GPU
compute still need testing on the actual hardware.

## 2. Download and verify on the Mac

From the [preview 6 release](https://github.com/autonomous-ai/openharness/releases/tag/os-v0.1.0-preview.6),
download both files into the same folder:

- `harness-0.1.0-preview.6-x86_64.iso`
- `harness-0.1.0-preview.6-x86_64.iso.sha256`

If they are in Downloads, open Terminal and run:

```sh
cd ~/Downloads
shasum -a 256 -c harness-0.1.0-preview.6-x86_64.iso.sha256
```

The result must say `harness-0.1.0-preview.6-x86_64.iso: OK`.
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
5. Choose the default **Harness** boot entry.

The exact menu wording varies by model. See Lenovo's
[boot-menu instructions](https://docs.lenovocdrt.com/ref/bios/startup_menu/).
If the USB is absent, try another USB port and check that USB boot is enabled.

The welcome screen offers **Enter — Install Harness** and **T — Try without
installing**. No account or password is needed to use the live session. Work in
the USB session is temporary and is not copied during installation.

## 5. Install

Press **Enter** on the welcome screen. You do not need to open a terminal or type
a command. The form has four fields:

1. **Disk:** press Enter, choose the internal disk by its model and capacity, and
   press Enter again. The live USB is excluded from the choices.
2. **Encryption:** enabled initially. Use Space to change it if needed.
3. **Password:** enter the password for your new system.
4. **Repeat password:** enter it again.

Use Tab or the arrow keys to move between fields. This preview uses a **US keyboard
layout**, including at disk unlock. Passwords cannot be empty; there is no minimum
length restriction.

Check the selected disk, then choose **Install** and press Enter. **This immediately
erases that disk. There is no second confirmation screen.** Choosing a disk alone
does not start installation. Esc leaves the picker or cancels the main form.

The account and computer name are set to **`me@harness`**. Installation works offline.
When **Harness is installed.** appears, choose **Shut down**. Once the ThinkPad is
off, remove the USB and power it on.

While trying the live system, **Ctrl+B**, then **I** opens the same installer.
The equivalent terminal command is `sudo harness install`.

## 6. First boot

With encryption enabled, the Harness logo appears with **Enter your password**.
Enter the installation password. Harness then opens without another account
setup or login prompt. With encryption disabled, log in as **`me`** using that
password.

The password initially protects both the account and, when enabled, the encrypted
disk. Changing the account password later does not change the disk password.
There is no cloud account that resets the disk password.

On the empty home screen, press **Enter** to start OpenCode. If there is no network
connection, the keyboard network picker opens first. Select your Wi-Fi network
and enter its password there. **Ctrl+B**, then **W** opens network setup from any
pane. Ethernet connects automatically when available.

OpenCode is already installed and uses its upstream defaults. Available models
may change. Other agents install when selected and follow their own account and
model setup. A Linux account does not sign you into an agent provider.

## 7. Use it

**Super** means the Windows-logo key on a typical ThinkPad. For a Ctrl+B shortcut,
press Ctrl+B, release both keys, then press the indicated letter. Capital letters
below mean **Shift + letter**.

| Keys or command | Action |
| --- | --- |
| Ctrl+B, then N | New Harness: choose an agent |
| Ctrl+B, then T | New terminal: open a shell directly |
| Ctrl+B, then W | Connect to Wi-Fi |
| Super+B | Open/focus Chromium, or return to Harness |
| Super+Enter | Focus Harness |
| Super+L | Lock; unlock with the account password |
| Super+U | Updates |
| `hn-browser http://localhost:3000` | Open a local project in the browser |
| `sudo systemctl poweroff` | Shut down |

Claude Code, Codex, OpenCode and pi each run in their own pane. Let the agent
install the tools the project needs. Save work under `~/Projects`.

## 8. Updates

A small **Update ready · Super+U** notice appears when a new hn or CLI release
has downloaded and passed its checks. Press **Super+U**, then Enter to apply it.
The screen reconnects; your running agents and terminal processes remain.
Use **R** in Updates to restore the previous runtime if needed.

System updates use **S** in the same screen and ask for your account password.
They retain a recovery checkpoint and rebuild the boot image. When the screen
offers **Restart now**, save your work and press Enter when ready. Downloads do
not restart the computer, and routine updates do not require another USB flash.

Preview 4 needs the small bootstrap bundle from the new preview release once.
Verify and extract that bundle, open a terminal in its folder, and run:

```sh
sha256sum -c SHA256SUMS
sudo python3 apply-update.py apply "$PWD"
```

Reboot when it finishes; subsequent updates are available through Super+U.
If the bootstrap fails, use `sudo python3 apply-update.py rollback` from that
same folder before trying again.

## 9. First manual test

1. Boot with the USB removed. Confirm disk unlock and the Harness home screen.
2. Connect Wi-Fi, open a terminal, type a command, and exit with Ctrl+D.
3. Start OpenCode and ask it to build a small website in `~/Projects/hello`, run
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

Preview 2 may report `Live system payload is missing` after copying the image into
RAM. If `/run/archiso/copytoram/airootfs.sfs` exists, its workaround is:

```sh
sudo hn-os install --source /run/archiso/copytoram/airootfs.sfs
```

Preview 2 can also list the boot USB as a target in RAM mode; choose the internal
disk carefully. Preview 3 and later detect both payload locations and exclude the
boot USB. A working installed system does not need reinstalling solely for that fix.
