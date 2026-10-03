# Developing and testing Harness

Use a persistent machine for daily work and a disposable VM for installation and
boot changes. Reflashing is a release/install test, not the intended way to try
every interface fix. Keep the development tools on the build/test host; the
installed OS keeps the same minimal interface.

This plan was recorded on October 3, 2026. Preview 4 is published. The small-package
updater and remote-launcher options are implemented on the OS branch; their native
integration checks are tracked below and in `progress.json` before distribution.

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

## Small development updates

`tools/build-package.py` assembles the same `harness-os` package used by the ISO.
On a clean x86 Linux checkout, build a bundle with:

```sh
make -C os runtime
python3 os/tools/build-package.py --runtime os/work/runtime --output os/work/my-update --development
```

The bundle identifies the source commit, architecture, required base image and
every runtime file. It includes a package, manifest, SHA-256 checksums and a
standalone bootstrap for preview 4. This is an explicit development installation
from a trusted build, not an automatic public update channel. Checksums detect
corruption; they do not authenticate an unknown publisher.

Copy the complete bundle to a dedicated installed test machine. After native
acceptance passes for that bundle, the bootstrap command is:

```sh
cd /path/to/bundle
sha256sum -c SHA256SUMS
sudo python3 apply-update.py apply "$PWD"
```

Subsequent bundles can use `sudo harness upgrade /path/to/bundle`. Roll back with
`sudo harness rollback`, or with `sudo python3 apply-update.py rollback` from the
retained bootstrap if the installed launcher is unavailable. Use the same
bootstrap's `status` command to inspect source and transaction identity.

The updater verifies a private copy before changing the installation, makes a
Btrfs root/boot checkpoint, and retains a package of the previous owned files.
Pacman performs the actual upgrade and rollback, preserving package ownership
and dependency checks. Home directories and projects are outside the package.
An interrupted update retains its receipt and recovery point and requires rollback
before another runtime update. If the installed system cannot run, use the live
USB's existing checkpoint recovery. There is no background updater, service
restart, network requirement or automatic reboot. Reboot when ready to use the
new session; boot/kernel changes still need image-specific validation.

The workflow input `development_update=true` with `image_run_id=37119543543`
builds the candidate and tests it against the published preview 4 image. Required
acceptance covers truncated downloads, a real failed pacman transaction, apply,
rollback, package identity, project preservation, the same terminal process
through daemon/screen restarts, and an encrypted reboot with keyboard input.
Portable guards pass locally; native acceptance is pending for the initial build.

Shared hn changes in preview 4 are still on the OS branch. Ordinary Mac/Linux hn
keeps its usual home and detach/quit behavior; live USB and installed OS welcome
actions require explicit OS mode. Opening Terminal directly is a shared chooser
change. It needs normal TUI release review along with the shared agent-discovery
and OpenCode compatibility fixes; publishing the ISO did not release these through
the general TUI channel. The small updater adds no changes to `tui/` or `cli/`.

## Optional remote VM controls

`run-vm.py --vnc-port 5901 --ssh-port 2222 --remote-host me@build-host
--require-acceleration` binds both optional listeners to localhost and prints an
SSH tunnel command. The display port implies headless QEMU; guest SSH still needs
deliberate service/key setup. Without these flags no TCP listener is added. The
acceleration flag refuses software emulation instead of silently using it.
Argument and binding tests pass; real remote display/SSH interaction is not yet
validated. These host tools add no software to the installed OS.

Stopped-VM snapshot/restore remains future work. Never snapshot a running disk
by blindly copying its file.

`hn-os update` currently upgrades Arch packages and keeps a recovery checkpoint;
it does **not** update the pinned Harness runtime. Preview 4 does not yet contain
the small updater. Until the development bundle passes its native checks, use
the published image for an end-to-end test of new OS interface code.

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
