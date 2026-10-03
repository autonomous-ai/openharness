# Install Harness on a ThinkPad

These instructions are for **0.1.0-preview.3**, using a Mac to prepare the USB.
The USB boots a live system first. It changes the ThinkPad's disk only after you
choose **Erase and install** in the installer.

## 1. Prepare

- An x86-64 Intel or AMD ThinkPad. This image does not support a 32-bit-only CPU.
- A USB stick of at least 4 GB. Flashing replaces its contents.
- An internal disk of at least 12 GiB, with anything important backed up elsewhere.
  Installation erases the **entire selected disk**, including another OS.
- AC power. Ethernet is useful for the first test; installation itself works offline.

Start with 2 GiB RAM or more. The earlier preview passed base VM checks at 1 GiB,
but that did not establish comfortable browser or concurrent agent use at 1 GiB.
A user has installed preview 2 on a ThinkPad and booted hn with the USB removed.
Further hardware issues are being investigated; Wi-Fi and suspend remain unverified.

## 2. Download and verify on the Mac

From the [preview 3 release](https://github.com/autonomous-ai/openharness/releases/tag/os-v0.1.0-preview.3),
download both files into the same folder:

- `programmer-os-0.1.0-preview.3-x86_64.iso`
- `programmer-os-0.1.0-preview.3-x86_64.iso.sha256`

If they are in Downloads, open Terminal and run:

```sh
cd ~/Downloads
shasum -a 256 -c programmer-os-0.1.0-preview.3-x86_64.iso.sha256
```

The result must say `programmer-os-0.1.0-preview.3-x86_64.iso: OK`.
If it does not, stop and download again.

## 3. Flash the USB

1. Install and open [balenaEtcher](https://etcher.balena.io/).
2. Choose **Flash from file** and select the ISO.
3. Choose **Select target** and select your USB by its name and capacity.
4. Choose **Flash**. If Etcher requests administrator authentication, enter your
   Mac login password in its macOS dialog. Let validation finish.
5. Eject the USB.

Use the image writer; copying the ISO onto a formatted USB does not make the
bootable installation media. If macOS says the flashed disk is unreadable, choose
**Ignore** or **Eject**, not Initialize. The Linux partitions are expected.

## 4. Boot the ThinkPad from USB

1. Shut down the ThinkPad and insert the USB.
2. Power on and tap **F12** at the Lenovo logo. Depending on the model, use
   **Fn+F12**, or **Enter** first and then **F12**.
3. Select the USB. Prefer its UEFI entry when available; the image also supports
   legacy BIOS boot.
4. If firmware rejects the image, enter setup with **F1** and disable **Secure
   Boot**. This preview is unsigned. Leave TPM enabled.
5. Choose the default Programmer OS boot entry and wait for hn.

The exact menu wording varies by model. See Lenovo's
[boot-menu instructions](https://docs.lenovocdrt.com/ref/bios/startup_menu/).
If the USB is absent from the menu, try another USB port and check that USB boot
is enabled in firmware.

## 5. Install

In hn, press **Ctrl+B**, release both keys, then press **N** and choose **Terminal**.
Run:

```sh
sudo hn-os install
```

**Preview 2 workaround:** if this reports `Live system payload is missing` after
booting the USB, the live image may have been copied into RAM. Run:

```sh
sudo hn-os install --source /run/archiso/copytoram/airootfs.sfs
```

Use this path only when that file exists. In preview 2's RAM mode, the USB can
also appear in the disk list: select the ThinkPad's internal disk by model and
capacity. Preview 3 detects both locations and excludes the boot USB. If preview 2
is already installed and boots normally, this fix does not require reinstalling it.

The live session does not need an account password. In the form:

1. Press **Enter** on Disk, use the arrow keys to choose the ThinkPad's internal
   disk by model and capacity, then press **Enter**. Do not choose another attached
   drive. Preview 3 excludes the live USB from installation targets in both boot modes.
2. Leave **Encrypt disk** checked, or use **Tab** and **Space** to uncheck it.
3. Enter your password twice. Use at least eight characters. This preview uses a
   **US keyboard layout**, including at the boot unlock prompt.
4. Choose **Continue**. Review the disk model, capacity and device identifier.
5. **Back** is selected initially. Press **Tab** to select **Erase and install**,
   then **Enter** when the target is correct.

No disk-path, username or computer-name typing is needed. The account will be
**`me@harness`**. Selecting a disk or choosing Continue does not write to it.
Esc goes back from the picker or confirmation, and cancels from the main form.

Wait for `Installed in ... Shut down, remove the USB, and boot the disk.`
Then run:

```sh
sudo systemctl poweroff
```

Once the ThinkPad is off, remove the USB and power it on.

## 6. First boot

With encryption enabled, type the installation password at the disk-unlock prompt.
The machine then enters hn without another account-creation screen or login prompt.
With encryption disabled, log in as **`me`** using that password.

The password initially protects both your local account and, when enabled, the
encrypted disk. Later account-password changes do not automatically change the
disk password. Keep the disk password: there is no cloud account that resets it.

Connect Ethernet, or open a Terminal pane and connect Wi-Fi:

```sh
nmcli device wifi list
sudo nmcli --ask device wifi connect "YOUR WI-FI NAME"
```

The second command asks for credentials without putting them in shell history.
If no wireless device appears, retain the output of `nmcli device status` for
hardware diagnosis. Installation does not require a connection; downloading agents
and using cloud models do.

## 7. Use it

**Super** means the Windows-logo key on a typical ThinkPad.

| Keys or command | Action |
| --- | --- |
| Ctrl+B, then N | Start an agent or ordinary terminal pane |
| Super+B | Open/focus Chromium, or switch back to hn |
| Super+Enter | Focus hn |
| Super+L | Lock the session; unlock with your account password |
| `hn-browser http://localhost:3000` | View a local project at that address |
| `sudo systemctl poweroff` | Shut down |

Choose Claude Code, Codex, OpenCode or pi from hn. The first use installs the
selected tool and follows its setup. Agent accounts and model access are separate
from your local Linux account. Toolchains are installed when a project needs them.
Save projects under `~/Projects`.

## 8. A useful first manual test

1. Boot from the internal disk with the USB removed. Confirm password unlock and hn.
2. Open a terminal, type normally, connect the network, and switch to Chromium and back.
3. Start an agent and ask it to create a small website in `~/Projects/hello`, run a
   local server, and tell you the address. Open it with `hn-browser ADDRESS`.
4. Ask the agent to create and test a small command-line program, installing its
   compiler or runtime if needed.
5. Reboot. Confirm the files remain and the machine returns to hn.
6. Try brightness keys, locking, lid-close/suspend and resume. These need physical
   hardware testing; report any failures with the ThinkPad model.

For timing, record installation after the erase confirmation separately from USB
flashing and prompts. Record boot to the unlock prompt and unlock to hn separately,
so time spent entering a password is not counted as OS startup.

If something fails, keep the exact error and ThinkPad model. In a working terminal,
`hn-os status` and `hn-os measure` provide system/session information. Do not share
passwords or agent tokens. The [OS README](README.md#updates-and-recovery) documents
updates and recovery using the retained USB.
