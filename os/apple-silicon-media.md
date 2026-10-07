# Private Apple Silicon installer media

This is development media, not a public download or a claim of physical Mac
support. It boots directly into **Install Harness** and carries the previously
verified Harness disk image for offline installation. It builds no shared client
and changes no release or update feed.

The native ARM builder uses the pinned Fedora Asahi repository description and
signed platform packages. KIWI provides its standard UEFI live ISO and read-only
SquashFS root with a temporary overlay. There is no persistent live session,
account wizard, desktop or trial workspace on this media. The installed payload
retains the tested Harness runtime, OpenCode and optional browser.

## Apple boot requirements

Apple Silicon requires the Asahi installer to establish its machine-specific
boot policy and a minimal UEFI environment, leaving free space for Harness. The
USB contains the ARM UEFI fallback loader; it does not carry or maintain
`m1n1/boot.bin`. Firmware identifies the owning internal EFI partition. Harness
uses only the prepared gap after it and never resizes or rearranges APFS.

See the upstream [distribution guidelines](https://asahilinux.org/docs/alt/policy/)
and [boot process](https://asahilinux.org/docs/alt/boot-process-guide/). This private
work is not endorsed by Asahi. Apple's boot-policy handoff, the installed boot
chain, physical keyboard/display behavior, and device-family acceptance still
need validation before publishing Mac installation instructions.

## Construction and verification

The **Harness OS private Apple Silicon installer media** workflow accepts an
existing successful `os-asahi-image.yml` run and its full source commit. It checks
that producer, downloads its retained disk and inspection evidence, verifies the
compressed file, then verifies the raw image against the inspection's SHA-256.

`os/tools/asahi_media.py` creates the live recipe and records the payload identity
and installer source hashes. The image remains compressed within SquashFS;
startup maps it read-only with 4096-byte sectors. The installer hashes and checks
the source before making any destination changes. A locked root account, masked
login/SSH and installed-system setup services, and enforcing SELinux keep this
media focused on installation.

`os/tests/asahi_media_check.py` mounts the actual produced ISO, its GPT EFI system
partition, and its compressed root read-only. The EFI partition is the firmware
boot surface; the ISO9660 file mirror is only diagnostic evidence. The check
requires ARM64 EFI executables and their boot configuration, then verifies payload bytes, installer files,
platform kernel, automatic installer service, pristine account state and absence
of machine secrets. Only an inspected ISO is retained as the private artifact.
Construction alone does not prove that it boots or installs successfully.

## Native media acceptance

On the Apple Silicon development host:

```sh
python3 os/tests/asahi_live_vm.py \
  --iso /path/to/Harness-Asahi-Installer.aarch64-0.0.0.iso \
  --media-receipt /path/to/media-evidence/inspection/receipt.json \
  --image /path/to/verified/harness-asahi-private.raw \
  --fixture /path/to/verified-arm-fixture \
  --fixture-source FULL_FIXTURE_COMMIT \
  --output os/test-results/asahi-media
```

The observer prepares a fresh regular disk with protected partition sentinels,
then boots the actual read-only ISO through UEFI with no network device. QEMU
provides the firmware EFI identity in its device tree; the installer runs
unchanged. Graphical keyboard input completes the form and invokes **Shut down**.
The observer inspects the resulting installation and protected bytes before
adding only QEMU console/input configuration to that disposable installed disk.
It then verifies wrong-password rejection, encrypted unlock, the frozen Harness
workspace, accounts, SELinux, runtime files and clean shutdown.

Receipts record the exact media, payload, fixture and observer inputs. Real
framebuffer screenshots are retained, including failures. The
test uses a known fixture password: neither its maintenance disk nor installed
target may be published. QEMU acceptance does not establish Apple firmware or
physical hardware support.
