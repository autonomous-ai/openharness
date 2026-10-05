# Harness OS landing page

A single-screen hero: Harness, the headline, Install, Open Source, and one
animated OS illustration, followed by two short sections about the agent interface
and measured performance. Plain HTML/CSS and a small vanilla JavaScript timeline;
no framework, analytics, remote fonts, backend, or build step. An actual OS
screenshot remains the fallback when JavaScript is unavailable.

Production deployment was explicitly authorized after local review. Use the
website-only release path to retain the currently deployed app bundle.

From the repository root:

```sh
python3 -m http.server 18092 --bind 127.0.0.1 --directory website/public
```

Open `http://127.0.0.1:18092/os/`. The existing website host serves the same static
page at `/os`; `os/site` is a compatibility symlink. The `<base href="/os/">`
keeps assets correct with either entry URL. Hosting and cache-header verification
belong to the [website release process](../../README.md#releasing).

## Content

Use the user-approved headline: **The operating system built by agents, for agents**.
The title, metadata and demonstration describe the operating system, not the terminal
application. Follow the [Naming System](../../../docs/naming-system.md).

Install opens `https://harness.autonomous.ai/os/latest`, a small redirect in the
existing website host. It reads public GitHub releases, filters complete OS
releases, and compares version numbers. Stable is preferred once available;
until then it selects the highest numbered preview. Drafts and desktop/CLI
releases are excluded. The lookup is cached server-side for five minutes; the
browser redirect is never cached. Future OS publications need no page deploy
and this website deployment publishes no OS or runtime.

Open Source opens `openharness/tree/main/os`. Neither action implies native
Apple Silicon or T2 support.

The design uses the local Geist Mono font with one font size and line height per
breakpoint. Spacing uses character widths and text rows. The OS screen fits the
remaining viewport without cropping; the column narrows on shorter screens so
its left and right edges stay aligned with the content. There are two text rows
between the brand and headline, one before the actions, and two before the image.
The additional sections retain the same typography and column edges. The stylesheet URL carries its content
hash so a refresh cannot reuse styling from the previous long page.
Tiny viewports at extreme text zoom may scroll so content is never inaccessible.

The performance section contains only four labeled numbers: installation time,
boot time, idle RAM, and footprint. No footnote, update instructions, or expanded disclosure.
The accessible group label identifies the VM measurement and terminal-only idle
state; full methodology stays here.

[Run 37258641766](https://github.com/autonomous-ai/openharness/actions/runs/37258641766)
measured preview 14 in an encrypted UEFI, 1 GiB Nehalem VM: 57.133 seconds for the
installation command, 17.683 seconds from boot to Harness readiness including
automated unlock/login, and 402.30 MiB median terminal-only idle RAM with OpenCode
and the browser closed (26.53 MiB swap). Installed root usage including home and
snapshots is 2,203,791,360 bytes. The page rounds these to 57 s, 18 s, 402 MiB, and
2.05 GiB. Installation timing excludes entering the form. Ten idle samples follow
a settling period; the diagnostic login and observer are included. These are VM
measurements, not physical hardware timings or active-agent memory consumption.
Image SHA-256:
`fa4f282644ac81e9e3b7de55276edd7dc08405e50875da544dc7f9fd6d50ba12`.
Refresh all figures and their evidence links together when the measured image changes.

## Animation

`demo.js` runs a scripted illustration: startup, three agents working, Super+b to
a local project preview, then back to Harness. It does not run agents, launch a
browser, execute code or make network requests. The example output is illustrative,
not recorded test evidence or a boot-speed measurement. The illustrated agents
do not imply that every engine is bundled with the image.

The control in the screen corner pauses or plays the sequence. Reduced-motion
preferences start with a static completed workspace; hidden tabs stop the timer.
The HTML remains usable if the script does not load. Both CSS and JavaScript URLs
carry content hashes; update them when those files change.

## Screenshot provenance

`assets/workspace.png` is an unmodified 1280 × 800 QEMU capture from the actual
installed OS: `01d-bundled-opencode.png` in the encrypted UEFI final-image evidence
under `os/work/install-cleanup/first-use/install-first/nvidia-install/final-image/`.
It shows the agent and two terminals. It is not an illustration or a hardware
compatibility claim. The source receipt is retained beside the original capture.

The bundled font's SIL Open Font License remains in `assets/OFL.txt`. The older
screenshots remain available for historical references but are not loaded by
this page.

## Validation

Check desktop, laptop and mobile viewports, the complete OS screen, keyboard
focus, the pause control, reduced motion, local assets, and destination URLs. There should be no
horizontal overflow at normal browser zoom; the hero fits one fold and the two
sections below it scroll normally. Record local results in
the ignored `.harness/validation/os-one-screen/` folder. Before an authorized
production rollout, use `website/scripts/check-os-site.mjs` against the actual
website host to verify routes, bytes and cache headers; the simple Python preview
does not emulate production headers.
