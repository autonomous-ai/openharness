# Harness landing page

A standalone page: HTML, CSS, local fonts, and four real screenshots. No JavaScript,
framework, package installation, analytics, or build step. This directory is not
part of the OS image.

From the repository root:

```sh
python3 -m http.server 18092 --bind 127.0.0.1 --directory os/site
```

Open `http://127.0.0.1:18092/`. Deploy the contents of this directory unchanged to
any static host. Asset paths are relative so a subdirectory works too.

## Content and assets

- The central narrative is **“Agents are the new apps.”** Conversation directs the
  work; terminal output, diffs, tests, and an optional browser make it inspectable.
  Follow the [Naming System](../../docs/naming-system.md): Harness is the product,
  programmers are the first audience, and owning Autonomous hardware is optional.
- The page walks through installation, encrypted boot, and working with agents.
  Keep shipped behavior and future hardware support distinct. Ordinary Harness
  on macOS or another Linux distribution does not show the OS installation UI.
- Download links target `os-v0.1.0-preview.4`. Update the
  version, measurements, evidence links, and screenshots together for a release.
- `assets/hn.png` is the actual hn screen from image validation run
  [37120135497](https://github.com/autonomous-ai/openharness/actions/runs/37120135497).
- `assets/install.png` and `assets/unlock.png` are unmodified screenshots from the
  encrypted UEFI journey in that run: `01b-direct-install-offline.png` and
  `disk-unlock-2-masked.png`. Passwords are masked. Images link to their full size.
- `assets/signal-run.png` is actual project output from the successful workload run
  [37120135497](https://github.com/autonomous-ai/openharness/actions/runs/37120135497).
  It covers preview 4 and loads lazily inside a native HTML disclosure.
- Footprint, installation and boot measurements cover preview 4 USB tests at
  4 GiB RAM. The separate 1 GiB measurements link to the same image’s test run
  through the OS README. All project acceptance checks reran on this image;
  three completed project sources were retained and the game agent ran again.
  [Three fresh DSH exercises](https://github.com/autonomous-ai/openharness/actions/runs/37120138348)
  cover this image and its shared viewers too.
- The preview 4 ThinkPad install/boot/use success is a user report from October 3,
  2026, not a measured hardware benchmark. Wi-Fi, suspend, Mac, and NVIDIA claims
  require their own hardware evidence.
- The optional 7.4 MB development update links to the same release. It was tested
  separately in [37124241039](https://github.com/autonomous-ai/openharness/actions/runs/37124241039).
  The update bundle is for installed systems, not USB flashing.
- Geist and Geist Mono are the repository's existing fonts, converted to WOFF.
  Their SIL Open Font License is included in `assets/OFL.txt`.
- The prompt mark is a small local SVG. There are no remote asset requests.

## Validation

Check local asset paths, image dimensions, heading/fragment targets, font loading,
and the release's download names. Visually inspect desktop and narrow screens;
use the keyboard to reach every link and toggle the disclosures. Confirm that
no content overflows at 320 px, 390 px, 768 px, and desktop widths.

The updated page passed HTML5/CSS parsing, asset, font, image-dimension, local
anchor, and current release-download-name checks on October 3. The user approved visual review, but
Chrome still rejected the exact local URL on October 3 because of a saved site
permission. Visual layout and interactive browser checks remain unverified until
that review succeeds. Do not replace it with an alternate browser or control path.
