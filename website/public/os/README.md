# Harness landing page

A standalone page: HTML, CSS, local fonts, and four real screenshots. No JavaScript,
framework, package installation, analytics, or page build step. It is served at
<https://harness.autonomous.ai/os> by the existing website host, separately from
the OS image. `os/site` is a compatibility symlink to this directory.

From the repository root:

```sh
python3 -m http.server 18092 --bind 127.0.0.1 --directory website/public
```

Open `http://127.0.0.1:18092/os/`. The HTML base is `/os/`, so assets and in-page
links resolve under the same path with or without a trailing slash. The website's
`/os` rewrite serves this file directly without adding JavaScript. Release through
the [website pipeline](../../README.md#releasing).

The HTML responses include `Cache-Control: no-store, no-transform`. The latter
keeps Cloudflare's automatic Web Analytics injection out of this standalone page;
see its [setup documentation](https://developers.cloudflare.com/web-analytics/get-started/).
Verify the public HTML bytes after rollout as well as the origin's local routes.

## Content and assets

- The central narrative is **“Agents are the new apps.”** Conversation directs the
  work; terminal output, diffs, tests, and an optional browser make it inspectable.
  Follow the [Naming System](../../../docs/naming-system.md): Harness is the product,
  programmers are the first audience, and owning Autonomous hardware is optional.
- The page walks through installation, encrypted boot, and working with agents.
  Keep shipped behavior and future hardware support distinct. Ordinary Harness
  on macOS or another Linux distribution does not show the OS installation UI.
- Download links target `os-v0.1.0-preview.6`. Update the
  version, measurements, evidence links, and screenshots together for a release.
- `assets/hn.png` is the actual installed hn home (`04-installed-hn.png`) from
  the encrypted UEFI journey in final image validation run
  [37149350400](https://github.com/autonomous-ai/openharness/actions/runs/37149350400),
  source `3c15fe540de02db8a3b37d565ce8b4001b872779`.
- `assets/install.png` and `assets/unlock.png` are unmodified screenshots from the
  encrypted UEFI journey in that run: `01b-direct-install-offline.png` and
  `disk-unlock-2-masked.png`. Passwords are masked. Images link to their full size.
- `assets/signal-run.png` is actual project output from the preview 6 workload
  [layout repair and acceptance run](https://github.com/autonomous-ai/openharness/actions/runs/37156180888).
  It loads lazily inside the existing native HTML disclosure.
- Footprint, installation and boot measurements cover the exact preview 6 ISO
  (`efa4e740989770ef7fa40e259f4055d670c5531fcecdf4fcf23f1ae31bb8d380`)
  in 2-vCPU, 1-GiB VMs booted from virtual USB. BIOS/plain installation took
  36.290 seconds; UEFI/encrypted took 69.347 seconds. The displayed range rounds
  those up. Six settled samples with agents/browser closed measured
  367.90–395.57 MiB, using total memory minus available memory. BIOS readiness
  was 16.228 seconds including test login. The UEFI password prompt appeared at
  6.046 seconds; readiness followed the correct password submission by 8.436
  seconds. The deliberate 100-second wait and wrong-password retry are excluded
  from that post-password interval. These are CI VM observations.
- Preview 6's four projects came from fresh OpenCode turns in
  [37154010202](https://github.com/autonomous-ai/openharness/actions/runs/37154010202).
  All 33 unit tests passed, but its game checker incorrectly required the controls
  to be HTML text. That failed run is retained. Corrected checks in
  [37155632007](https://github.com/autonomous-ai/openharness/actions/runs/37155632007)
  passed without another model turn. Visual review then caught a clipped help
  sentence; the linked repair run asks the agent to fix it and reruns acceptance.
  Its first BIOS job failed downloading a GitHub artifact before boot; only that
  job was retried. No uninterrupted passing suite is implied.
  [Three fresh harness/viewer exercises](https://github.com/autonomous-ai/openharness/actions/runs/37154011980)
  cover the same image. `harness-examples-preview6.zip` retains project source,
  screenshots and provenance separately from the immutable ISO and its original
  `validation.json`. Check its accompanying SHA-256 before linking a new bundle.
- The preview 4 ThinkPad install/boot/use success is a user report from October 3,
  2026, not a measured hardware benchmark. Wi-Fi, suspend, Mac, and NVIDIA claims
  require their own hardware evidence.
- Preview 5 introduced separate hn/CLI and system update channels. The preview 6
  package passed native upgrade, runtime/channel and encrypted reboot acceptance
  from both [preview 4](https://github.com/autonomous-ai/openharness/actions/runs/37149349981)
  and [preview 5](https://github.com/autonomous-ai/openharness/actions/runs/37149350324).
  The latter supplies the canonical 7.1 MB bootstrap download. The uncompressed
  package archives match exactly; only gzip timestamps differ between runs.
  Publish the ISO and update feed before deploying links to them.
- Selected BCM4331/BCM4360 Wi-Fi preparation passed an actual encrypted offline
  installation, signed package installation, module load, and offline rebuild in
  the final image's hardware job. Only PCI selection was substituted; no physical
  radio association or Mac suspend is inferred. Other machines retain neither
  the optional packages nor the USB cache.
- Older Intel Macs without T2 and with 64-bit EFI remain experimental. Actual
  Core 2 TCG instruction emulation boots hn; OpenCode exits with SIGILL. The
  candidate Try action's CPU explanation, return, and terminal input passed
  with only the OS command overlaid on a checksum-verified preview 4 image.
- [4 GiB USB journeys](https://github.com/autonomous-ai/openharness/actions/runs/37150118908)
  passed automatic RAM copying, protected USB selection, installation, recovery,
  and agent use on this same final ISO.
- Geist and Geist Mono are the repository's existing fonts, converted to WOFF.
  Their SIL Open Font License is included in `assets/OFL.txt`.
- The prompt mark is a small local SVG. There are no remote asset requests.

## Validation

Check local asset paths, image dimensions, heading/fragment targets, font loading,
and the release's download names. Visually inspect desktop and narrow screens;
use the keyboard to reach every link and toggle the disclosures. Confirm that
no content overflows at 320 px, 390 px, 768 px, and desktop widths.

The user reviewed and approved the prior page design on October 3. This revision
updates copy, measurements and unmodified VM screenshots without changing CSS.
The final OS screenshots were visually inspected. Browser Use still rejects the
local page because of the saved permission for `127.0.0.1:18092`; responsive
widths and keyboard interaction remain unverified for this revision. Record
static asset checks and the website CI build/route results in the PR.
