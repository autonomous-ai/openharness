# Developing and testing Harness

Use a persistent machine for daily work and a disposable VM for installation and
boot changes. Reflashing is a release/install test, not the intended way to try
every interface fix. Keep the development tools on the build/test host; the
installed OS keeps the same minimal interface.

This plan was recorded on October 3, 2026. Preview 4 is published. The update and
remote-interaction work marked below is still to be implemented and verified.

## The feedback loop

| Work being tested | Best environment | What it proves |
| --- | --- | --- |
| Agent chooser, panes, shortcuts, terminal rendering | Native Harness on the developer's Mac plus Linux integration tests | Shared interface behavior; not the OS boot/install path |
| OS session, first use, installer, encryption, update/recovery | Native x86 Linux VM with KVM, controlled from the Mac | Repeatable PC-image behavior with actual Linux userspace |
| Wi-Fi, brightness, keyboard layout, battery, suspend, physical boot | Dedicated ThinkPad, then each supported Mac model | The real daily-use experience and hardware behavior |
| Future arm64 userspace and package compatibility | Accelerated ARM Linux VM on Apple Silicon | ARM application/session behavior; not Apple boot or drivers |
| Apple boot, internal storage, GPU, input and power management | Physical Mac with the matching hardware stack | Mac OS support for that exact model |

For the current user setup, install preview 4 on the ThinkPad once and use it for
normal programming. Run installer experiments on the server VM. Record an issue
with the exact keys/action, expected result, actual result and a screenshot or
error text. Keep the image version and hardware model with the report.

The target iteration is: reproduce in the VM, fix and run affected checks, deploy
a versioned development update to the dedicated test installation, then have the
user repeat the action. Restart only the changed component where its lifecycle
allows it. Kernel, initramfs and boot changes require a reboot. Periodically test
a clean USB install to verify that upgrades have not hidden an installation bug.

## What is working now

- The `Harness OS` workflow builds the x86-64 ISO and runs actual BIOS/plain and
  UEFI/encrypted install, boot, wrong-password retry, update and recovery checks.
  It retains screenshots, boot-stage timestamps, logs and source/image identity.
- `image_run_id` tests an existing image without rebuilding it. `memory_mib=1024`
  exercises a constrained machine; `memory_mib=4096` and `live_transport=usb`
  exercise automatic copy-to-RAM. `workloads=true` or `dsh=true` runs the relevant
  real-agent exercises. See the [measured evidence](README.md#real-programmer-exercises).
- `python3 os/tools/run-vm.py --iso PATH` creates a persistent virtual disk and
  opens the installer. `--installed` subsequently boots that disk without the ISO.
  `--directory PATH` keeps independent test machines separate.
- OpenSSH is installed. An SSH service and keys must be deliberately configured
  for a dedicated test machine before remote deployment; this plan does not
  enable a remote service or publish credentials.

The current launcher selects KVM on an x86 Linux host with accessible `/dev/kvm`,
HVF on an Intel Mac, and TCG emulation otherwise. This M2 Max Mac therefore
emulates the present x86 image. Earlier emulation checks rendered a browser
project but later reboot checks failed with soft-lockups. Use the native x86 CI
results for current performance measurements.
[QEMU documents these acceleration options](https://www.qemu.org/docs/master/system/introduction.html).

## Next tooling work

1. Add an explicit remote test-VM mode to `run-vm.py`: a display reachable through
   an SSH tunnel, optional localhost guest-SSH forwarding, and a clear connection
   command. Its current `--headless` mode exposes only local QMP/serial sockets;
   an interactive remote viewer has not been built into this helper yet.
2. Add a development deployment command for the Harness runtime and OS integration.
   It must identify the target as a disposable/dedicated test installation, verify
   architecture and artifact hashes, preserve the prior version and user data,
   record the source revision, and provide rollback. Failed transfers must leave
   the previous version usable. UI-only changes should not require downloading
   another 1.5 GiB ISO.
3. Add stopped-VM snapshot/restore to the test workflow so repeated installer and
   recovery experiments start from a known state. Never snapshot a running disk
   by blindly copying its file.

`hn-os update` currently upgrades Arch packages and keeps a recovery checkpoint;
it does **not** update the pinned Harness runtime. No preview-channel app updater
or small development-update command is shipped yet. Until that mechanism passes
its checks, use a matching image for an end-to-end test of new OS interface code.

## Mac support targets

Intel Macs and Apple Silicon are both intended OS targets. They share the Harness
interface and behavior, but need separate platform work. None is claimed as a
validated Harness OS hardware target by preview 4.

| Target | Approach | Current Harness OS status |
| --- | --- | --- |
| Older Intel Mac, 64-bit CPU and EFI, without T2 | Reuse x86-64 userspace and validate firmware, graphics, Wi-Fi, input, sleep and installation per model | First physical Mac target; no tested model yet |
| Intel Mac with T2 | Add the T2 kernel/driver and firmware integration; validate built-in input at encrypted unlock | Separate hardware profile, not covered by generic x86 VM success |
| Apple Silicon | Build arm64 userspace and integrate the Asahi boot/kernel/graphics/firmware stack | Port required; current x86-64 ISO cannot install natively |
| Native Harness app/TUI on macOS | Existing arm64 and x64 app/runtime releases | Separate from installing the Linux OS |

The initial Intel scope excludes 32-bit-only CPUs/EFI. T2 machines need specific
kernel support for built-in input and other hardware; their firmware and install
preparation differs from an ordinary PC. The maintained references are the
[t2linux Arch install guide](https://wiki.t2linux.org/distributions/arch/installation/),
[kernel/input setup](https://wiki.t2linux.org/guides/postinstall/) and
[pre-install guide](https://wiki.t2linux.org/guides/preinstall/).

For Apple Silicon, evaluate Fedora Asahi Remix Minimal as the first hardware
bring-up base: it provides a maintained minimal image and the platform packages.
This is a port candidate, not a shipped change to the Arch PC image. Retain the
same labwc/foot/Harness/browser experience, while treating distribution-specific
packaging, updates and recovery as separate integration work.
[Fedora Asahi Remix](https://asahilinux.org/fedora/) offers Minimal and Server images.

Start with explicitly supported M1/M2 models. The current M2 Max MacBook Pro is a
candidate: Asahi's detailed table lists its display, keyboard, trackpad, Wi-Fi,
GPU and sleep support. That is upstream evidence, not a passed Harness test.
Feature readiness varies by model and generation; recheck the
[M2 table](https://asahilinux.org/docs/platform/feature-support/m2/) and
[other device tables](https://asahilinux.org/docs/platform/feature-support/overview/)
before expanding the target list.

Apple Silicon installation cannot reuse the PC whole-disk USB flow. Asahi starts
installation from internal macOS and needs internal boot provisioning. Preserve
macOS/recovery and use an Apple-aware partition/install path. An ARM VM does not
test that path or the Apple-specific drivers.
[Asahi installation requirements](https://asahilinux.org/docs/project/faq/).

For each hardware target, retain the model, CPU/GPU, firmware and OS versions,
install method, encryption status, Wi-Fi/input/display results, suspend/resume,
and measured boot/idle behavior. Validate a real agent task and browser preview,
then update and recover without losing the project. A target becomes supported
only when that evidence exists.
