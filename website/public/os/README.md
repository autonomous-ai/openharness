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

## Content and assets

- The central narrative is **“Agents are the new apps.”** Conversation directs the
  work; terminal output, diffs, tests, and an optional browser make it inspectable.
  Follow the [Naming System](../../../docs/naming-system.md): Harness is the product,
  programmers are the first audience, and owning Autonomous hardware is optional.
- The page walks through installation, encrypted boot, and working with agents.
  Keep shipped behavior and future hardware support distinct. Ordinary Harness
  on macOS or another Linux distribution does not show the OS installation UI.
- Download links target `os-v0.1.0-preview.5`. Update the
  version, measurements, evidence links, and screenshots together for a release.
- `assets/hn.png` is the actual installed hn home (`04-installed-hn.png`) from
  the encrypted UEFI journey in final image validation run
  [37142219550](https://github.com/autonomous-ai/openharness/actions/runs/37142219550),
  source `6171b0ab5e60129c66cf301b33047e672d4e4d1a`.
- `assets/install.png` and `assets/unlock.png` are unmodified screenshots from the
  encrypted UEFI journey in that run: `install-01-form.png` and
  `disk-unlock-2-masked.png`. Passwords are masked. Images link to their full size.
- `assets/signal-run.png` is actual project output from the successful workload run
  [37120135497](https://github.com/autonomous-ai/openharness/actions/runs/37120135497).
  It covers preview 4 and loads lazily inside a native HTML disclosure.
- Footprint, installation and boot measurements cover the exact preview 5 ISO
  (`5937e83d97a25271edd994e967e407fbabfcf7eeb90c8f856bfe2738135d6218`)
  in 2-vCPU, 1-GiB VMs booted from virtual USB. BIOS/plain installation took
  31.555 seconds; UEFI/encrypted took 107.161 seconds. The displayed range rounds
  those up. Six settled samples with agents/browser closed measured
  375.64–394.59 MiB, using total memory minus available memory. BIOS readiness
  was 15.862 seconds including test login. The UEFI password prompt appeared at
  5.243 seconds; readiness followed the correct password submission by 7.719
  seconds. The deliberate 100-second wait and wrong-password retry are excluded
  from that post-password interval. These are CI VM observations.
- The generated project evidence remains explicitly tied to preview 4.
  Its unit tests and independent acceptance checks passed on that image;
  three project sources were retained from earlier work and the game agent ran again.
  [Three fresh DSH exercises](https://github.com/autonomous-ai/openharness/actions/runs/37120138348)
  cover this image and its shared viewers too.
- The preview 4 ThinkPad install/boot/use success is a user report from October 3,
  2026, not a measured hardware benchmark. Wi-Fi, suspend, Mac, and NVIDIA claims
  require their own hardware evidence.
- Preview 5 adds separate hn/CLI and system update channels. The 7.1 MB preview 4
  bootstrap bundle and its exact source passed native package, runtime and
  system-channel acceptance in
  [37142216520](https://github.com/autonomous-ai/openharness/actions/runs/37142216520),
  including process/tab survival, failed-start recovery and encrypted reboot.
  The bundle is for installed systems, not USB flashing. Publish the ISO and the
  verified update assets before deploying links to them.
- Intel Mac support is a roadmap. An actual Core 2 TCG instruction-emulation probe
  boots hn but OpenCode exits with SIGILL; bundled OpenCode requires SSE4.2.
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
