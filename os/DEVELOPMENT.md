# Developing and testing Harness

Use a persistent machine for daily work and a disposable VM for installation and
boot changes. Reflashing is a release/install test, not the intended way to try
every interface fix. Keep the development tools on the build/test host; the
installed OS keeps the same minimal interface.

This plan was recorded on October 3, 2026. Preview 6 and its small bootstrap bundle
and update channel are published. Native upgrades from previews 4 and 5 passed; remote-launcher
argument tests passed but remote display/SSH interaction is still unverified.

## Next release priorities

The next preview improves the complete experience before expanding the interface.
Keep the existing terminal, agents and optional browser. Hardware integration must
not introduce a desktop, control panel or extra launcher. Update checks use a
short-lived user timer; there is no resident update process.

1. Refine USB welcome, offline installation, Wi-Fi setup, trial, first conversation
   and disk unlock. Review actual screens, keyboard navigation, narrow displays,
   cancellation and recoverable errors. Keep the Naming System and text artwork
   consistent across these steps.
2. Verify the essentials of daily use: networking, brightness, audio, locking,
   sleep/wake, browser switching, updates and recovery. Preserve running work
   through display restarts and session transitions. Agents can use the ordinary
   system tools; the user should not need to configure basic hardware to start.
3. Expand hardware coverage by family: older Intel Macs without T2 first, NVIDIA
   desktops next. Prepare separate boot/platform paths for T2, Apple Silicon and
   Raspberry Pi. Detect devices rather than hard-coding one person's computer.
4. Exercise real development work and retain installation, boot, idle-resource and
   recovery evidence for the actual candidate image. Publish measured results and
   an honest compatibility table; upstream driver availability is not a physical
   Harness test.

`checks=session` with an `image_run_id` in the Harness OS workflow exercises
the published image's live session, then its installed session with the candidate
`os/root/usr/lib/harness-os/session` launcher. The receipt records both the base
image and that file's hash; a reboot activates the candidate before lock,
wrong-password input isolation and actual virtual ACPI suspend/resume checks.
The same terminal process, heartbeat and project must survive. This is a quick
integration check, followed by a fresh final image test. It does not establish
physical laptop suspend, radio, audio or battery behavior.

The focused sleep test uses QEMU standard VGA (`bochs-drm`), whose pinned LTS
driver implements display suspend/resume. The normal install tests retain
`virtio-vga`. Preview 4's Virtio display resumed with a working guest and terminal
process but no visible output after S3; the pinned Virtio GPU driver has no
freeze/restore callbacks. Keep that VM limitation separate from physical laptop
acceptance. `--video virtio-vga` reproduces that configuration; do not count an
unavailable display as successful sleep/wake.

`checks=essentials` reuses the chosen image to test NetworkManager and PipeWire.
The fixture adds a simulated WPA2 access point in an isolated guest network
namespace and a virtual HDA codec, operates the actual hn network form and media
keys, and checks DHCP, DNS, HTTP, reconnection and non-silent audio output. Access
point tools are installed only inside the disposable guest, never in the ISO.
Physical radio, backlight, speaker and microphone tests remain separate.

The **Harness OS optional local AI assessment** workflow reuses an exact image
artifact and installs it to an encrypted disposable disk. Its two independent
checks add packages only inside their guests:

- `local-ai` installs the snapshot's CPU Ollama package and downloads a small
  Qwen model. A project-local OpenCode configuration selects that local endpoint.
  After one connected setup pass, networking is disabled; a direct API request
  and an OpenCode command typed through hn must return the independently checked
  arithmetic answer. The receipt records the model digest, actual CPU use and
  loopback-only listener. This is a transport/compatibility check, not a coding
  quality benchmark or a recommendation to use a tiny model for daily work.
- `nvidia` installs matching `nvidia-open-lts` and `nvidia-utils` packages without
  changing base packages. It checks all four module versions against the running
  kernel, the driver's shipped support table, initramfs generation, encrypted
  reboot, hn keyboard input and Chromium on the virtual display. No GPU is passed
  through: binding, accelerated rendering, CUDA, physical suspend and inference
  on a real card remain unverified. A failing `nvidia-smi` on this fixture is
  recorded as unavailable hardware, never GPU success.

Model weights, inference servers and NVIDIA packages do not enter the default
image. Use an agent to set up the runtime and model that the actual machine and
project need. [OpenCode's local-provider guide](https://opencode.ai/docs/providers/#ollama)
and [Ollama's integration guide](https://docs.ollama.com/integrations/opencode)
cover configuration; full agent workloads need substantially more context and
memory than this small conversation test.

Run the assessment with `image_run_id` and `probe` in that workflow, or on a native
x86 KVM host with its image and matching `manifest.json`:

```sh
python3 os/tests/local_ai_vm.py --iso os/dist/IMAGE.iso --probe local-ai
python3 os/tests/local_ai_vm.py --iso os/dist/IMAGE.iso --probe nvidia
```

The **Harness OS runtime memory assessment** workflow compares Node flags in one
installed 1 GiB VM. It alternates two default and two candidate rounds, samples
RSS/PSS and local status latency with four persistent terminal streams, records
CPU time, then restores the packaged command and checks graphical keyboard input.
This measures daemon behavior, not model performance or full agent throughput.

In [the October 3 comparison](https://github.com/autonomous-ai/openharness/actions/runs/37154644789),
the installed Node was 22.23.3. Median process RSS was 117.4/129.2 MiB in the two
default rounds and 126.1/145.2 MiB with `--optimize-for-size
--max-semi-space-size=1`. Each round made 200 status requests; p95 response times
were 1.19–1.25 ms. Memory drifted across this short interleaved run, so it does not
establish a precise causal difference. It provides no evidence for a saving from
these flags; the shipped defaults remain unchanged. Retain raw per-round data
and use representative long-running agent work before adopting a memory limit.

## The feedback loop

| Work being tested | Best environment | What it proves |
| --- | --- | --- |
| Agent chooser, panes, shortcuts, terminal rendering | Native Harness on the developer's Mac plus Linux integration tests | Shared interface behavior; not the OS boot/install path |
| OS session, first use, installer, encryption, update/recovery | Native x86 Linux VM with KVM, controlled from the Mac | Repeatable PC-image behavior with actual Linux userspace |
| Wi-Fi, brightness, keyboard layout, battery, suspend, physical boot | Dedicated ThinkPad, then each supported Mac model | The real daily-use experience and hardware behavior |
| Future arm64 userspace and package compatibility | Accelerated ARM Linux VM on Apple Silicon | ARM application/session behavior; not Apple boot or drivers |
| Apple boot, internal storage, GPU, input and power management | Physical Mac with the matching hardware stack | Mac OS support for that exact model |

For the current user setup, keep the ThinkPad installation and update it in place
for normal programming. Run installer experiments on the server VM. Record an issue
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
- `workload_seed_run_id` preserves generated projects and reruns their acceptance
  checks without another model turn. Enable `workloads=true` as well only when
  asking the agent to repair the existing game's layout. The host reads control
  labels from captured pixels, so a canvas legend does not need HTML duplicates.
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

### Fast hn updates

The installed OS checks the existing public hn and CLI release channels every
15 minutes, with a small randomized delay. Complete, checksum-verified runtimes
are prepared under the user's state directory. The OS-owned copy remains an
offline fallback. Neither downloading nor checking restarts working processes.
OS windows use hn's local session storage (`HARNESS_TUI_DESK=off`), so their
layout and pane references survive reconnects without signing into the cloud.
This setting is confined to the OS launcher; ordinary hn installs are unchanged.

`Update ready · Super+U` appears in the bottom bar. Super+U opens the keyboard
update action (Ctrl+B, Shift+U remains an alias). Enter applies the prepared
runtime through a transient user service. An hn-only change reconnects just the
screen; a CLI change also restarts its supervised service. Failure restores the
previous selection. Restore previous version holds the rejected versions until
a newer release arrives. Ordinary macOS/Linux hn shortcuts are unchanged.

This fast track is independent of OS releases. The system channel is checked
once daily; S in Updates installs the published OS package with an administrator
password. Root independently fetches the official release metadata, verifies a
private download, makes a checkpoint, updates any required Arch base first, and
rebuilds the encrypted boot image. System packages never apply or reboot on a
timer. After an OS package changes, fast updates wait for a reboot. Publishing an
ISO is not a requirement for a TUI update. The public preview
4 ISO predates this feature and needs the small integration bundle from the
validated preview 5 release; it does not need to be flashed again.

`development_update=true` builds a private, deliberately unpublished `999.0.1`
hn/CLI fixture. The installed VM's actual timer stages it, then real Super+U and
Enter keys apply hn and CLI independently. Acceptance checks the same terminal
process, a live OpenCode process, keyboard input, rollback and an unchanged boot
ID. Those fixture binaries are never included in the package or public channel.
The same installed VM restores the public package and upgrades through a private
loopback OS channel, rejects a corrupt asset, keeps its running agent alive, and
reboots the rebuilt encrypted image. This does not depend on a public test release.

The OS feed is `os-preview-updates/metadata.json` in the repository's release
assets. It names the exact package and manifest, their byte sizes and SHA-256
hashes. HTTPS authenticates the channel; these are not custom package signatures.
Cross-version packages list the exact validated `upgrades_from` bases. Direct
local bundles cannot skip a required full Arch upgrade. A lower or equal package
version is never offered by the public channel. The publisher must retain exact
source and native acceptance evidence before advancing that feed.

After the matching ISO preview is published, prepare its update assets with
`tools/publish-update.py --bundle BUNDLE --receipt receipt.json --run RUN --output OUTPUT`.
Review the resulting metadata and bundle, then use `--publish` with a fresh
output directory. The publisher requires the exact passing native source and
package, uploads immutable versioned assets, verifies their public bytes, and
only then advances the preview channel. Its first channel is uploaded and
download-verified as a draft before publication. Retain `publication.json` as
the publication receipt; this does not replace recording the total request time.

### Local OS integration bundles

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

The first [verified development bundle](https://github.com/autonomous-ai/openharness/releases/download/os-v0.1.0-preview.4/harness-update-preview.4-42c22cece-x86_64.zip)
is 7.4 MB and targets installed preview 4. Its terminal and CLI binaries match the
ISO byte for byte; it establishes the update path for future interface fixes.
Copy the complete extracted bundle to a dedicated installed test machine. The
bootstrap command is:

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
All 65 portable checks and workflow lint passed. [Native acceptance on source
42c22cece](https://github.com/autonomous-ai/openharness/actions/runs/37124241039)
passed every case above. In that 2 GiB encrypted VM, apply took 3.089 seconds and
rollback took 1.083 seconds. Actual post-update keyboard and masked-unlock captures
were reviewed. Public package/guide/evidence downloads were fully SHA-256 and size
verified. Physical ThinkPad update behavior and timings remain unverified.

Shared hn changes in preview 4 were merged to main in PR #669. Ordinary Mac/Linux hn
keeps its usual home and detach/quit behavior; live USB and installed OS welcome
actions require explicit OS mode. Opening Terminal directly is a shared chooser
change, explicitly approved for all platforms. Publishing the ISO did not release
these through the general TUI channel. The small updater adds no changes to `tui/`
or `cli/`.

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
it does **not** update the pinned Harness runtime. Preview 4's ISO does not contain
the small updater; install its separately validated development bundle to add it.

## Mac support targets

Intel Macs and Apple Silicon are both intended OS targets. They share the Harness
interface and behavior, but need separate platform work. None is claimed as a
validated Harness OS hardware target by preview 6.

Preview 6 prepares selected older Broadcom radios by PCI ID, not Mac model.
BCM4331 (`14e4:4331`) and BCM4360 (`14e4:43a0`) may load the optional wl driver;
an already working native interface is preserved. BCM43602 and other native
brcmfmac/brcmsmac devices are outside that selection. The vendor package's broad
blacklist is overridden so it cannot disable those other drivers.

The live driver is about 2 MB. A separate signed package cache is kept on the
USB for offline installation; its compiler, DKMS and matching LTS headers are
installed only when the radio needs them. The cache is removed from every
installed system. The standard package hooks then rebuild wl on kernel updates.
The driver bundle is built in a disposable root using the same complete Arch
snapshot as the image; none of its build packages enter the normal image base.
This selection happens during a fresh installation. Updating an older installed
preview adds the device policy and report, but does not silently download driver
packages. On a connected older installation that needs wl, an agent can first
complete `sudo hn-os update`, then install `broadcom-wl-dkms linux-lts-headers`
with pacman from that same snapshot and reboot. A working native interface needs
neither package.

[Native preparation run 37145711377](https://github.com/autonomous-ai/openharness/actions/runs/37145711377)
used the exact preview 5 kernel, `6.18.54-1-lts`. Its signed extra closure was
128.76 MiB. Online package installation/build took 32.831 seconds, then removing
exactly those packages and reinstalling with networking off took 13.440 seconds.
The prebuilt module loaded on a fresh 1 GiB USB VM without GCC or DKMS, and hn
accepted keyboard input. This proves module compatibility and offline package
availability, not association with a physical access point. The integrated
candidate image and device-selection policy have their own validation records.
The Arch wl package is an unmaintained out-of-tree driver; retain its original
license and prefer a working native driver where available.

`harness hardware` produces a small local JSON report for agents and hardware
testing. It includes device IDs and current bindings, not serial numbers, SSIDs
or network addresses. No additional daemon or settings application is needed.

| Target | Approach | Current Harness OS status |
| --- | --- | --- |
| Older Intel Mac, 64-bit CPU and EFI, without T2 | Reuse x86-64 userspace, select drivers by detected hardware, and validate representative Air/Pro families | First Mac target family; no tested model yet |
| Intel Mac with T2 | Add the T2 kernel/driver and firmware integration; validate built-in input at encrypted unlock | Separate hardware profile, not covered by generic x86 VM success |
| Apple Silicon | Build arm64 userspace and integrate the Asahi boot/kernel/graphics/firmware stack | Port required; current x86-64 ISO cannot install natively |
| Raspberry Pi | Evaluate a maintained ARM64 board kernel, firmware and boot image with the same Harness session | Separate board image required; not covered by the PC ISO or an ARM VM |
| Native Harness app/TUI on macOS | Existing arm64 and x64 app/runtime releases | Separate from installing the Linux OS |

The initial Intel scope excludes 32-bit-only CPUs/EFI. The bundled OpenCode trial
also requires SSE4.2. October 3 CPU checks used the unchanged preview 4 ISO under
QEMU TCG with `-cpu core2duo`: a Core 2 Duo T7700 instruction set with SSSE3,
without SSE4.1, SSE4.2 or AVX. The later check used 4 GiB of guest RAM and installed
the listed agent versions on demand in the disposable USB session.

| Component | Result under Core 2 instruction execution |
| --- | --- |
| hn and Node 22.23.3 | USB welcome and terminal worked; Node started |
| Chromium 153.0.8010.52 | Rendered a local page, ran JavaScript, accepted QMP keyboard input and returned to hn; no `--no-sandbox` flag |
| Codex 0.160.0 | Installation, `--version` and `--help` succeeded |
| pi 1.0.1 (`@earendil-works/pi-coding-agent`) | Installation with `--ignore-scripts`, `--version` and `--help` succeeded |
| Claude Code 2.1.288 | Installation succeeded; `--version` and `--help` exited with SIGILL (132) |
| OpenCode 2.0.21 | The earlier preview 4 probe exited with SIGILL (132) |

These checks establish specific CPU startup limits, not physical Mac support,
authenticated agent turns or full browser/media/GPU compatibility. They do not
replace preview 6 installation testing or show that every future vendor binary
will retain the same baseline. Codex and pi still need real model-turn validation
on this CPU before being recommended as its trial path.

The OS Try action detects the OpenCode limitation before Wi-Fi setup and explains
it, instead of launching a binary that immediately fails with an illegal instruction.
[Bun's executable targets](https://bun.com/docs/bundler/executables) document the
SSE4.2 baseline used by its compiled runtime.

T2 machines need specific
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
