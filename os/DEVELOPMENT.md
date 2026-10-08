# Developing and testing Harness

Use a persistent machine for daily work and a disposable VM for installation and
boot changes. Reflashing is a release/install test, not the intended way to try
every interface fix. Keep the development tools on the build/test host; the
installed OS keeps the same minimal interface.

The USB image and the small installed-system update bundle ship separately.
Each candidate must pass native installation and upgrade checks before publication.
Preview 12 adds one-action updates, including mouse activation, while preserving
running agents and terminals. Remote-launcher argument tests passed but remote
display/SSH interaction is still unverified.

## Test artifact retention

After a test passes and its VMs stop, discard its writable disk copies. Retain
logs and receipts; do not archive `guest.raw`, `target.raw`, `encrypted.raw` or
maintenance disks in task worktrees. The Asahi acceptance drivers enforce this
after writing a passing receipt. Failed disks are temporary diagnosis artifacts:
remove them when the diagnosis/task ends. Remove downloaded fixture images when
the task ends too; Actions retains the reproducible producer artifacts. Never
remove an active VM disk or an original input during a test.

## Next release priorities

### NVIDIA readiness

The installed PC session starts a one-shot user check 15 seconds after the
workspace starts. It is inert on the installer and on computers without NVIDIA
GPUs. A per-user lock and boot/kernel/driver/device/probe fingerprint prevent
screen restarts from repeating it. Each new boot or relevant change rechecks;
`harness hardware --check-gpu` explicitly repeats it. Reports and the last fully
working result are atomic local JSON in `~/.local/state/harness-os/gpu/`.
They are user diagnostics, never privileged authorization or proof for a release.

Each owned card is addressed by PCI bus ID. The CUDA Driver API checks device
visibility, a 4 KiB memory upload/readback, and 1,024 integer results from a tiny
PTX kernel. A separate EGL device context renders and reads three colors using
the NVIDIA renderer. No CUDA toolkit, compiler, model or inference runtime enters
the image. Normal user permissions apply. Reserved devices are skipped, and
headless graphics failures remain explicitly unverified rather than labelling
working compute broken. Offscreen EGL does not establish compositor, browser,
physical display or suspend behavior; the memory sample is not a stress test.

Each subprocess has a 20-second deadline within a 120-second total budget; hangs,
crashes, incomplete responses and wrong readbacks are failures with the last
operation recorded. All contexts are private and released. The check never
resets a GPU, unloads modules, changes packages, restarts an agent or reboots.
Only actionable failure gets a short existing Harness status message. Package
replacement/restart-pending state defers verification until reboot. Existing full
snapshot updates keep the kernel and driver together and preserve the original
root/boot checkpoint; failures retain that recovery path, without an automatic
rollback that might interrupt work. Local-model provisioning remains the TUI's
responsibility.

The API sources are NVIDIA's [Driver API](https://docs.nvidia.com/cuda/cuda-programming-guide/03-advanced/driver-api.html),
[stable context ABI](https://docs.nvidia.com/cuda/archive/12.9.1/cuda-driver-api/group__CUDA__CTX.html),
and Khronos [EGL device displays](https://registry.khronos.org/EGL/extensions/EXT/EGL_EXT_platform_device.txt),
[render-node mapping](https://registry.khronos.org/EGL/extensions/EXT/EGL_EXT_device_drm_render_node.txt),
and [CUDA device mapping](https://registry.khronos.org/EGL/extensions/NV/EGL_NV_device_cuda.txt).
Portable tests include a compiled C ABI fixture with corrupt-memory, wrong-answer,
async-error and wrong-device cases. Such fixtures establish error handling, not
physical NVIDIA acceptance. Real cards must still pass these checks and actual
display, browser, update/recovery and sleep/wake testing before a family is called
supported.

The next preview improves the complete experience before expanding the interface.
Keep the existing terminal, agents and optional browser. Hardware integration must
not introduce a desktop, control panel or extra launcher. Update checks use a
short-lived user timer; there is no resident update process.

1. Refine direct USB installation, first-boot Wi-Fi setup, first conversation
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

The **Harness OS laptop input** workflow exercises both compositor configurations
on an exact image: USB installation, then an encrypted installed session. A
test-only uinput keyboard sends real display/keyboard brightness events. The
packaged brightnessctl writes a synthetic panel fixture and a real kernel
`uleds` keyboard light. The latter retains normal device permissions, so the test
also checks access from the active graphical session. It checks a nonzero display
floor, small-range panels, independent keyboard illumination, absent displays,
unrelated LEDs and ordinary typing afterward. No test devices or tools enter the
image. This establishes input routing and driver-interface behavior, not physical
panel brightness or Apple firmware support.

Display controls explicitly select the backlight class and keep a minimum value
of one; keyboard controls select only `*::kbd_backlight` LEDs. These use the
existing [brightnessctl options](https://github.com/Hummer12007/brightnessctl).
No extra daemon, package, widget or screen is required.

The same workflow's `probe=apple-boot` check installs a checksum-verified image
to an encrypted 1 GiB VM. It uses private mount-namespace DMI fixtures and the
actual `mkinitcpio -P` presets to inspect both pre-T2 SPI controller families.
The baseline includes `applespi` but omits its host controllers; the candidate
must include the controllers, their dependency closure and early module loading,
while retaining existing explicit modules. Negative model fixtures check that
USB-only Macs, T2, Apple Silicon and other PCs are unaffected. Finally it removes
the fixtures, regenerates the generic initramfs and verifies graphical disk
unlock and typing in hn after reboot. Logs, module lists and image hashes are
retained; this is preparation for physical Mac tests, not proof of Apple input.

The small `20-harness-apple-keyboard.conf` mkinitcpio drop-in uses the model and
controller mapping documented by [Linux KEYBOARD_APPLESPI](https://github.com/torvalds/linux/blob/master/drivers/input/keyboard/Kconfig).
It adds the existing in-tree drivers during installation and subsequent initramfs
rebuilds. Do not replace them with the obsolete macbook12 SPI DKMS driver.

`checks=browser` with an `image_run_id` exercises the installed terminal/browser
session in BIOS/plain and UEFI/encrypted VMs. It records and applies only the
candidate `hn-browser` script and labwc configuration over the checksum-verified
image. The observer checks actual Wayland window states, local-page rendering,
keyboard input destinations, repeated Super+b switching, an explicit URL request,
and browser close/reopen while the same terminal process remains alive. The host's
`wlrctl` binary is copied to the disposable guest's `/tmp`; it is not added to the
image. Every candidate and observer hash is retained with screenshots and input
logs. These focused checks do not replace a changed image's release acceptance.

Boot readiness is recorded before first-use Wi-Fi and model conversations. Keep
password wait, diagnostic login, onboarding, and active model latency separate
when reporting startup. Native VM timings do not establish laptop power-on times.

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

The **Harness OS installed footprint assessment** workflow reuses a checksum-verified
published image in fresh encrypted 1 GiB and 4 GiB Nehalem VMs. It samples the
default OpenCode workspace, stops the disposable agent to measure the terminal,
then renders a local Chromium page. Each state settles for 20 seconds before ten
samples at two-second intervals. Receipts retain MemAvailable-based system usage,
swap, interval CPU, process PSS/RSS, package metadata and screenshots. Actual
graphical keyboard checks run after agent shutdown and return from the browser.
The background update timer is stopped during sampling and restarted afterward.

Dispatch `os-footprint.yml` with `image_run_id`, or use a native x86 KVM host:

```sh
python3 os/tests/footprint_vm.py --iso os/dist/IMAGE.iso --memory-mib 1024
python3 os/tests/footprint_vm.py --iso os/dist/IMAGE.iso --memory-mib 4096
```

[Preview 10 results](https://github.com/autonomous-ai/openharness/actions/runs/37212080839)
are summarized in the [footprint table](README.md#measured-preview-footprint).
The two runs passed; test source was `f00ab7429584c982ed7a1b5a23ad82f3d4de579f`.
Terminal-only median CPU was about 0.75%; the observer and diagnostic login remain
included. This is one ordered sequence per VM with a software-rendered display,
not a randomized comparison, physical hardware benchmark or model throughput test.

The inventory records 405 packages. Its largest logical sizes belong to Chromium
(422 MiB), OpenCode (195 MiB), LLVM (165 MiB), the LTS kernel (156 MiB), and device
firmware. The installed USB boot/recovery tools examined total about 10.84 MiB
logical size; that is not a demonstrated saving. Package sizes are uncompressed,
and missing metadata remains unknown. Retain hardware support and recovery tools
until a candidate removal has dependency, actual disk-saving and recovery evidence.

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

The **Harness OS compression assessment** workflow compares Zstandard levels 6,
15, and 19 on the same checksum-verified ISO filesystem. It rebuilds level 6 with
the same runner tools as the alternatives, then measures three extractions per
level using the installer's 64 MiB SquashFS cache. Receipts include compression
time and peak process memory, payload bytes, extraction timings, tool versions,
and a filesystem manifest. Every extraction must preserve file hashes, ownership,
permissions, timestamps, symlink targets, hardlink groups, device numbers and
extended attributes, including capabilities. A small native roundtrip checks the
verifier before the full image download.

Ubuntu's 4.6.1 extractor uses explicit 32 MiB data and fragment queues; these
match the queue allocation of `-mem 64M` in newer SquashFS tools. The installed
OS keeps its existing extractor and command.

The default assessment uses an unconstrained Linux host with a warm/uncontrolled
page cache. It does not measure a complete installation or low-memory boot.
Enable `native_comparison` to repack the same source ISO at levels 6 and 19,
preserving its boot layout and regenerating its payload checksum. It runs three
alternating BIOS/plain installations per level and one UEFI/encrypted installation
per level. Every trial uses a fresh 1 GiB KVM guest, Nehalem CPU profile, private
disk and USB overlay, and disconnected network. It verifies the actual media
checksum, saves a trial project, installs offline, reboots, checks that project
and sends real keyboard input through the graphical terminal. Guest caches are
dropped after the integrity read and before installation. Guest memory/swap is
sampled every 250 ms; install, live boot and installed boot measurements remain
separate. Retain every trial, including failures.

The native comparison still uses an unthrottled virtual USB and uncontrolled host
cache; it cannot establish physical USB throughput or laptop boot time. It calls
no models and does not replace the full release journey. Run either assessment
through Actions with the existing image's `image_run_id` and independently trusted
`iso_sha256`. It retains receipts/screenshots, discards candidate images and changes
no release defaults. Adopting a candidate requires a production image build and
the normal plain/encrypted installation, agent trial and recovery checks.

The [October 4 preview 7 comparison](https://github.com/autonomous-ai/openharness/actions/runs/37177303376)
verified 87,985 paths and 1,035 hardlink groups through all nine extractions. All
eight native installations passed. Level 19 saved 80.14 MiB (5.30%) versus the
same-tool level-6 payload. Full BIOS install medians were 31.937/32.684 seconds;
the encrypted pair was 56.353/57.787 seconds, including final sync and unmount.
Preview 8 adopts level 19 for the USB only; installed Btrfs compression is unchanged.

Both encrypted trials fell below 128 MiB available RAM (69.20/94.07 MiB minimum),
with 105.34/91.69 MiB peak swap. That baseline pressure is not a regression caused
by the new compression in these samples, nor proof of a memory improvement.
Per-command timing was not captured in that assessment. A later full preview 8
journey ([37181312268](https://github.com/autonomous-ai/openharness/actions/runs/37181312268))
identified the failure directly: during encryption after an agent trial, the
kernel killed `cryptsetup luksFormat` at 485,232 KiB anonymous RSS. The 1 GiB guest's
RAM-backed swap was almost full. The plain and separate hardware installations passed.

The installer now limits PBKDF memory to half of available RAM, leaves at least
128 MiB for the live session, and retains cryptsetup's 1 GiB ceiling. It refuses
to erase the disk if the resulting budget is below 64 MiB. Cipher, key size,
Argon2id and the normal time/iteration benchmark remain intact; lower-memory
machines can get a lower memory cost. Existing encrypted disks are never changed.
This follows cryptsetup's supported [memory budgeting](https://gitlab.com/cryptsetup/cryptsetup/-/blob/main/man/common_options.adoc)
and accounts for its [swap-dependent free-memory check](https://gitlab.com/cryptsetup/cryptsetup/-/blob/main/lib/utils_pbkdf.c).
The native journey records actual keyslot costs and checks unlock/recovery.
Shared-host VMs do not establish physical 1 GiB hardware reliability.

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
  exercises a constrained machine; `memory_mib=6144` and `live_transport=usb`
  require automatic copy-to-RAM. The USB test verifies its actual payload mount
  and refuses the boot USB as an installation target in both modes. The 4 GiB
  check permits either mode: Archiso copies only when available memory exceeds
  the compressed payload plus 2 GiB. `workloads=true` or `dsh=true` runs the relevant
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
Signed out, OS windows use hn's local session storage (`HARNESS_TUI_DESK=off`),
so their layout and pane references survive reconnects without a cloud account.
Signed in (`HARNESS_TUI_DESK_SIGNED_IN=sync`), this computer's windows join the
account's shared tabs, as the desktop app's do at sign-in, under the names the
app shows. On sign-out the harnesses running on this computer stay in their
windows; another machine's go with the account. An older hn reads `off` alone. These settings are confined to
the OS launcher; ordinary hn installs are unchanged.

The installed system keeps hn's standard status bar. Super+u records an update
request and selects the Updates terminal; the request starts checking/applying
without another key. `harness updates` opens the same screen for inspection,
with a clickable **Update** button. An hn-only change reconnects the screen;
a CLI change also restarts its supervised service. Failure restores the previous
selection. `harness updates rollback` restores the previous runtime and holds
rejected versions until a newer release arrives. Ordinary macOS/Linux hn is unchanged.

The system channel is checked daily. The same action applies an available OS
package first, using `sudo -n harness upgrade`. A narrowly scoped sudoers rule
permits only that exact command and `harness rollback`, with no extra arguments.
Root independently fetches official metadata, verifies a private download,
creates a checkpoint, updates any required Arch base and rebuilds initramfs.
A local bundle, custom feed or arbitrary administrator command still requires
normal authentication. No blanket passwordless sudo is installed.

A system update leaves the current processes alone. **Done** is selected by
default; **Restart** is a separate deliberate action. The user's update request
is retained with the new base identity and original boot ID. After a real reboot,
the timer prepares compatible hn/CLI releases against that base and completes
that one requested update. Failures require attention, not repeated activation.
Ordinary later checks download without activating. Publishing an ISO remains
independent from frequent TUI releases.

`development_update=true` builds private, unpublished `999.0.1` hn/CLI releases.
The native fixture exercises timer staging, Super+u alone, a real mouse click on
Update, failed activation/rollback, live terminal and OpenCode PIDs, keyboard input
and boot identity. The same installed VM tests the OS channel, cleared sudo
credentials, a corrupt asset and the encrypted reboot. Fixture binaries and
loopback feeds never enter a published package.

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
make -C os compositor
python3 os/tools/build-package.py --runtime os/work/runtime --compositor os/work/compositor --output os/work/my-update --development
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

### Public update acceptance

Run the OS workflow with `checks=public-update` and the candidate's successful
`image_run_id`. The producer must retain both `programmer-os-x86_64` and
`harness-os-candidate-inputs`. This check compares every update-package file,
permission, owner and link with the actual ISO before installing the original
preview 14 image to a disposable encrypted disk.

The stock updater receives the candidate through its ordinary HTTPS URLs. A
temporary server and certificate authority exist only in the disposable test
machine; host trust, public feeds, updater code and sudo policy stay unchanged.
The test first proves that the guest rejects the untrusted certificate. Its
private metadata holds the separate hn/CLI channels at the image's baselines.

One real Super+u with cleared sudo credentials must apply the package, preserve
agent/daemon/terminal processes and keyboard input, retain a verified recovery
checkpoint, and cold boot into the candidate with project files unchanged. The
receipt records the image producer and observer separately. This establishes
the installed public update path with private transport, not CDN publication,
kernel migration or physical hardware support. The job never publishes.

## Installation and first-use onboarding

The USB starts `harness-install.service`: foot runs the offline installer directly.
The agent daemon, hn screen, idle lock and update timer do not start on live media.
The compositor has a small installation-only key configuration. A failed graphical
startup opens the same installer on the console. Cancelling resets the form;
success keeps Shut down visible. A failed shutdown never restarts installation.
There is no trial choice, network prerequisite, dock or agent session on the USB.

The installed system starts the usual hn screen. On first use, `hn-os welcome`
opens the existing full-page Wi-Fi form when disconnected. Working Ethernet or a
saved connection skips that form; connection success advances automatically to
OpenCode on the left and two terminal panes on the right. Later launches restore
work. The standard hn footer and shared Ctrl+b shortcuts remain intact.
First use and Super+w share the same Wi-Fi page, without a separate welcome
tagline or skip button. Super+t opens a terminal during setup; it does not mark
network setup complete or require starting a cloud agent while disconnected.

OpenCode reads the packaged guide through its global
`~/.config/opencode/AGENTS.md`, linked to `/usr/share/harness-os/guide.md`.
The account skeleton supplies this link; Start OpenCode also adds it on older
installations when no personal instructions file exists. Existing instructions
are never replaced. OpenCode 2 accepts the legacy JSON `instructions` field but
does not load it; see its [instructions reference](https://opencode.ai/v2/docs/instructions/).
The guide
points to the exact shipped `tui/README.md`, with a source revision, and tells the
agent to inspect current bindings before answering. Model/provider selection is
left to upstream. The package-owned OpenCode executable is updated by full system
updates; new accounts disable its self-updater through the global config.
Existing user preferences are preserved. No download blocks the first conversation.
Independent background agent updates remain future work and must preserve the
packaged fallback, validate provenance, avoid downgrades, and activate on a later
launch rather than replacing an active executable.

The previous trial-file transfer helper remains compatible with explicit installer
commands from older sessions. It does not create a trial path in the new USB UX.

Validation covers boot directly into the installer with networking disabled,
masked keyboard entry, cancellation and errors, graphical fallback, plain and
encrypted installation, installed Wi-Fi and Ethernet skip, the three-pane layout,
real default-agent conversation, browser use, updates and recovery. Image manifests
identify this journey with `install-first`; historical trial images retain their
own acceptance checks. Native screenshots are required before publication.

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

## Native ARM runtime development

`os/tools/build-runtime.sh` builds the same CLI and static hn on native x86-64 or
aarch64 Linux. Rust's matching `*-unknown-linux-musl` target and native Node are
required. The output records the clean source commit, release ancestry, CPU/ELF
architecture, versions and file hashes. Use a fresh `HARNESS_OS_RUNTIME_DIR` to
retain another build; the default is `os/work/runtime`.

The **Harness OS native runtimes** workflow builds both architectures on separate
native Linux runners. It runs the existing complete native terminal fixture set,
then starts the exact bundled daemon with an isolated home and no account. Its
real hn panes accept PTY input, run upstream-default OpenCode to create a Python
project, and preserve the shell process/project through daemon restart and screen
reattachment. Independent checks execute the generated code. Agent packages and
test dependencies stay on disposable runners; their exact lockfile accompanies
the receipt.

This establishes a userspace test path, not an ARM operating-system release.
The PC package builder, installer and public updater still reject ARM payloads.
Raspberry Pi board boot and Apple Silicon's Asahi kernel, firmware, partitioning,
graphics and audio integration remain required. An ARM Ubuntu runner does not
establish compatibility with either device, or with a different distribution's
packages. Retain that boundary when reporting the workflow's results.
The reference tmux uses the OS's checksum-pinned 3.7c source on both runners.
The receipt records the actual kernel page size and hn's ELF load alignment.
An aligned ARM executable still needs execution on a 16 KiB-page kernel before
claiming Apple Silicon userspace compatibility; see
[Asahi's page-size requirements](https://asahilinux.org/docs/sw/broken-software/).

The **Harness OS ARM kernel acceptance** workflow boots that runtime under a
16 KiB-page Asahi kernel in a disposable QEMU VM. `tests/arm-boot.lock.json`
pins the Ubuntu ARM64 userspace image, kernel RPMs and signing key by digest.
The runner verifies RPM signatures before extracting the raw boot image; no
kernel packages are installed on the runner. The guest records its actual kernel
and page size, then runs the real daemon/pane/agent acceptance above, including
independent execution of generated code and preservation of work through restart.
Serial output, guest receipts, userspace package versions and agent lockfiles are
retained even when acceptance fails. The private disk and container are removed.

Run on a disposable native ARM Linux host with Docker, QEMU, RPM verification,
libarchive, zstd and ext4 tools; use the workflow for complete tool setup:

```sh
python3 os/tests/arm_boot.py --runtime os/work/runtime \
  --agent /path/to/npm-opencode-prefix --output os/test-results/arm-boot
```

This isolates the page-size/kernel change while retaining the native runner's
Ubuntu userspace. It is not a product image, distribution choice, graphical boot
test or hardware installation. It does not test Apple firmware, storage, GPU,
audio, Wi-Fi or Raspberry Pi boot. Keep ARM payloads out of the PC installer and
update feed until each platform has its own packaging and installation path.

### Reproducible ARM graphical session

The **Harness OS ARM graphical session** workflow assembles a fresh Fedora Minimal
userspace and boots the shared labwc/foot/Harness session under the signed 16 KiB
Asahi kernel. This extends the console-only kernel check above; it is a private
VM prototype, not an Apple Silicon installer or a supported hardware image.

`tests/arm-session.lock.json` pins the Fedora container and extra graphical kernel
modules. The builder verifies kernel package signatures and hashes, checks the
exact clean ARM runtime, installs signed Fedora packages without weak dependencies,
and records their versions and the pinned OpenCode artifact identity. Fedora
repositories remain mutable; this is not a claim of an immutable package snapshot.

The tracked fixture accounts for Fedora's browser executable and labwc action
name. It selects shared session files explicitly and excludes the PC installer,
pacman configuration and x86 driver hooks. Its empty-password account
and root console exist only on the private regular-file disk and local QEMU socket;
no host block device, SSH service or public listener is exposed. These test settings
must never enter a hardware image.

The acceptance path starts offline, opens a terminal with actual Super+t input,
then connects and waits for the default agent and two terminal panes. It asks
OpenCode to create a Python program and HTML counter, independently executes the
program, clicks the counter in sandboxed native Chromium, and returns to the same
agent with Super+b. A second cold boot must accept keyboard input and preserve
the project's exact bytes. Receipts, framebuffer captures and logs survive failures;
the writable private disk/container are removed. A passing run establishes this VM sequence
only, not hardware installation, GPU acceleration, suspend or Fedora recovery.

```sh
python3 os/tests/arm_session.py --package os/work/fedora-package \
  --output os/test-results/arm-session
```

Use a native ARM Linux runner with the tools listed in `os-arm-session.yml`.
The two recorded hosted ARM runs lacked KVM; the second TCG run reached Wi-Fi and
accepted real keyboard input, but failed with a blank OpenCode pane. That failure
is retained and is not graphical acceptance.

Fresh fixtures install the native `harness-os-session` RPM instead of copying an
unowned overlay. The RPM is a component of the future Fedora/Asahi Harness image:
it owns the shared session, verified ARM runtime, OpenCode, Fedora guidance and per-user
update units. It contains no installer, base-system updater, kernel, firmware,
boot files, `/etc` configuration, account provisioning or service scriptlets.
Package installation does not start or restart a session. Chromium is optional.
OpenCode's ARM executable and upstream MIT license are pinned by URL, size and
SHA-256 in `packaging/fedora/opencode.lock.json`. The preparer checks upstream
package metadata, ELF architecture and 16 KiB page alignment before staging only
those files. No npm installation scripts run, and no agent download is needed at
first boot. The package keeps upstream model defaults and user credentials.
Update the lock deliberately and repeat the actual 16 KiB first-use/agent test
before using a newer binary; do not resolve a mutable latest version during builds.

Build in the pinned Fedora aarch64 container from `arm-session.lock.json`, with
`python3`, `git`, `rpm-build`, `tar` and `gzip` installed from signed Fedora repositories:

```sh
python3 os/tools/opencode_payload.py --archives /path/to/agent-archives \
  --output /path/to/agent-payload
python3 os/tools/build-fedora-package.py --runtime /path/to/runtime \
  --runtime-source FULL_RUNTIME_PRODUCER_SHA --agent /path/to/agent-payload \
  --output /path/to/fresh-package
python3 os/tests/arm_session.py --package /path/to/fresh-package \
  --output os/test-results/arm-session --prepare-only
```

The package source and explicitly selected runtime producer remain separate in
the manifest. Both must be clean, with native ARM ELF and runtime hashes checked.
An older immutable runtime can therefore validate packaging without rebuilding
unrelated TUI/CLI sources. Payload timestamps, RPM build time and buildhost are
fixed; compare actual RPM bytes with the same recorded Fedora RPM toolchain.
These private artifacts are unsigned and unpublished; their manifest checksums
are checked before fixture installation. This is not a product update channel.

The **Harness OS private Fedora package** workflow takes a successful private
runtime run and its full producer SHA. It builds release 1 twice and release 2
once, compares repeated RPM bytes, and installs, upgrades and removes the package
in a fresh native Fedora container. First it provisions the RPM's declared signed
Fedora dependencies with their normal presets, retaining package inventories and
the full `/etc` configuration delta. It then creates an existing account, project,
personal configuration and explicit user-unit mask before the Harness transactions.
Those transactions check the original runtime artifact, exact installed versions,
owned files and strict account/project/configuration preservation. This proves
preservation on an existing Fedora base; installing missing platform dependencies
can change Fedora defaults. Only the private local Harness RPMs bypass signature
checks; repository dependencies still require Fedora signatures.
The optional `prepare_fixture=true` input builds a fresh graphical disk from
the same RPM and frozen runtime after the lifecycle checks. Its separate artifact
is marked prepared, not accepted; run it with HVF/KVM as described below. This
allows OS packaging changes to be checked without rebuilding hn or the CLI.

Use its `first/` and `upgrade/` artifacts with the immutable graphical fixture
to check the packaged session across an actual VM reboot and user runtime update:

```sh
python3 os/tests/fedora_package_vm.py \
  --fixture /path/to/harness-arm-session-fixture \
  --fixture-source FULL_IMAGE_PRODUCER_SHA \
  --packages /path/to/harness-fedora-package \
  --package-source FULL_PACKAGE_PRODUCER_SHA \
  --updates /path/to/fast-update-fixture \
  --updates-source FULL_RUNTIME_PRODUCER_SHA \
  --output os/test-results/fedora-package-vm
```

Package and update artifacts must declare the same original runtime identity.
This check preserves a running agent and daemon through both RPM transactions,
then tests the packaged session's keyboard, platform commands and per-user update
activation/rollback after reboot. The private user's update timer is masked across
the reboot and starts only after the verified local feed is ready; no public update is consumed.
The RPM itself contains the normal timer. Neither this check nor the container
lifecycle test establishes Apple hardware installation or Fedora base recovery.

The Fedora profile reports runtime provenance through `hn-os status`. The
`harness install/upgrade/rollback` and `hn-os install/checkpoint/update/recover`
commands reject this profile before invoking PC helpers. `harness updates` and
Super+u retain verified per-user updates, while the system channel is explicitly
unavailable. Fedora/Asahi retains base-system and platform update/recovery
responsibility. The test-only login, networking policy, empty-password account,
root console and autologin remain in `arm_session_root.sh`, outside the RPM.

The workflow defaults to `prepare_only=true`, which uploads an unbooted, compressed
private test disk and kernel with their hashes and exact source identity. Its
receipt says **prepared**, never **passed**. Download `harness-arm-session-fixture`
from that run, check out its exact source commit, and run the unchanged acceptance
on a native ARM Linux machine with KVM or an Apple Silicon Mac with HVF:

```sh
python3 os/tests/arm_session.py --fixture /path/to/harness-arm-session-fixture \
  --output os/test-results/arm-session-local
```

This needs QEMU, zstd, Tesseract and Python with Pillow. The runner verifies both
compressed and decompressed disk hashes, then boots a disposable writable copy.
It records the accelerator, real agent/browser interaction and the second boot.
The prepared fixture has an empty test password and must never be installed on
hardware or published as an OS release. Preparation and acceptance have separate
receipts. Set `prepare_only=false` to exercise the full sequence on the CI runner.
When correcting test assertions, an existing immutable fixture can be selected
explicitly with `--fixture-source FULL_PRODUCER_SHA`. Its hashes are still checked;
the acceptance receipt records the image source and test source separately. This
tests that older image, not product changes in the newer test checkout.

Apple firmware provisioning, physical drivers, platform installation and Fedora
update/recovery integration remain separate work before releasing this port.

### Explicit Fedora login setup

The private session RPM includes `harness-session-setup`, implemented separately
in `fedora_session.py`. Installing the RPM remains passive. On an existing Fedora
Asahi Minimal system, an administrator may install Fedora's `greetd` package and
explicitly select an existing account with `enable --user USER --autologin`.
The account must already have a usable recovery password and sudo permission to
disable setup. The helper never creates accounts or edits their homes/profiles.

Fedora's greetd package supplies PAM session setup, logind integration and its
conditional SELinux policy. Its standard display-manager alias and graphical
target handle tty1 ordering/conflicts. Harness adds one configuration, one service
drop-in and one selected-user sudoers rule for the two exact Wi-Fi form commands.
`visudo` validates that rule before activation. A durable receipt precedes changes;
failure rolls them back, `disable` restores the exact previous target, and edited
managed files are preserved for explicit conflict resolution. Enable and disable
never start, stop or restart the current session; they affect the next boot.
Other ttys and vendor login configuration remain intact.

The Fedora 44 aarch64 `greetd-0.10.3-6.fc44` RPM has 1,355,071 bytes of regular-file
payload (443,637 bytes downloaded); its matching SELinux package adds 10,359 bytes
of payload (20,682 bytes downloaded). This is a PAM login daemon and text greeter,
without another desktop environment. These measurements exclude already-shared
Fedora dependencies and filesystem allocation; record the actual dependency
transaction in native validation. The upstream source RPM and artifact hashes
belong in the ignored validation receipt. Fedora's normal policy supplies the
session's authenticated fallback and runtime directory instead of copying the
VM fixture's empty-password/profile autostart into an existing installation.

Run the focused portable contracts with:

```sh
python3 -m unittest discover -s os/tests -p 'test_fedora_session.py'
python3 -m unittest discover -s os/tests -p 'test_fedora_package.py'
```

These exercise temporary-root transactions, account prerequisites, conflicting
and edited configuration, interruption recovery and the passive RPM payload.
They do not establish actual PAM authentication, SELinux enforcement or graphical
boot. Those require the separate native Fedora VM sequence and ultimately real
Apple hardware. With an exact-source immutable fixture, the private login driver
normalizes only its disposable clone, installs signed Fedora login/SELinux
packages, and requires enforcing policy after a cold boot:

```sh
python3 os/tests/fedora_session_vm.py \
  --fixture /path/to/harness-arm-session-fixture \
  --fixture-source FULL_IMAGE_PRODUCER_SHA \
  --output os/test-results/fedora-session-login
```

It records the setup source separately from the image/runtime, tests QMP virtual
keyboard password login and sudo, next-boot autologin, the two exact Wi-Fi forms,
authenticated recovery and disable back to the prior console. It does not relax
SELinux enforcement to pass. The candidate helper is overlaid onto the existing
RPM fixture; the portable payload check separately covers its package exposure.

The setup does not touch Apple partitioning, ESP/m1n1/U-Boot/GRUB,
firmware, kernels or Asahi's speaker-safety configuration. Fedora/Asahi remains
responsible for base-system updates and recovery; Super+u remains the verified
per-user runtime update path described above.

### Native runtime updates in the ARM fixture

The **Harness OS private runtime update fixtures** workflow builds native x86 and
ARM baseline runtimes plus unpublished `999.0.1` updates. It runs portable OS checks
on both architectures, preserves the original runtime, and uploads exact-source
artifacts. These manifests never enter a product update channel.

Use the ARM artifact with an existing verified graphical fixture:

```sh
python3 os/tests/arm_update_vm.py \
  --fixture /path/to/harness-arm-session-fixture \
  --fixture-source FULL_IMAGE_PRODUCER_SHA \
  --updates /path/to/fast-update-fixture \
  --updates-source FULL_UPDATE_PRODUCER_SHA \
  --output os/test-results/arm-updates
```

The driver verifies both immutable inputs, then adds only the candidate user
updater and its shortcut/timer to a private writable copy. It exercises staged
downloads, a failed screen restart, mouse activation, Super+u, and rollback with
actual native binaries. The same agent and terminal processes, heartbeat, boot ID,
and keyboard input must survive. Its ancestor-release check requires that the
fixture's recorded public CLI baseline is already included in the boot image.

Receipts distinguish the boot image, update producer, and test/updater source.
This tests per-user runtime changes, not Fedora package updates, boot recovery,
physical Apple hardware, or an ARM product installation. The passwordless test
account and writable test disk must never be published.

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
installed system. When the USB cache matches the selected image, the installer
omits its archives from extraction and selected radios use a read-only bind mount.
The image's manifest and module are retained for comparison; full archive hashes
and package signatures are checked before use. An explicit image override with
different or unavailable live files retains its own cache during installation.
The standard package hooks then rebuild wl on kernel updates.
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

The initial Intel scope excludes 32-bit-only CPUs/EFI. Bundled OpenCode
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
on this CPU before being recommended as its first-agent path.

The agent launcher detects the OpenCode limitation and explains it instead of
launching a binary that immediately fails with an illegal instruction. This does
not make Core 2 a supported bundled-agent target.
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
