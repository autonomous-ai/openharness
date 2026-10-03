# Harness landing page

A standalone page: HTML, CSS, local fonts, and two real screenshots. No JavaScript,
framework, package installation, analytics, or build step. This directory is not
part of the OS image.

From the repository root:

```sh
python3 -m http.server 18092 --bind 127.0.0.1 --directory os/site
```

Open `http://127.0.0.1:18092/`. Deploy the contents of this directory unchanged to
any static host. Asset paths are relative so a subdirectory works too.

## Content and assets

- Download links target the verified `os-v0.1.0-preview.3` release. Update the
  version, measurements, evidence links, and screenshots together for a release.
- `assets/hn.png` is the actual hn screen from image validation run
  [37107310576](https://github.com/autonomous-ai/openharness/actions/runs/37107310576).
- `assets/signal-run.png` is actual project output from the successful workload run
  [37086423516](https://github.com/autonomous-ai/openharness/actions/runs/37086423516).
  It covers preview 1 and loads lazily inside a native HTML disclosure.
- Current footprint, installation and boot measurements cover preview 3 USB tests
  at 4 GiB RAM. The separate 2 GiB measurements link to the same image’s optical
  test run through the OS README. The 1 GiB, real-model project and DSH claims are labeled as preview 1 evidence.
- Geist and Geist Mono are the repository's existing fonts, converted to WOFF.
  Their SIL Open Font License is included in `assets/OFL.txt`.
- The prompt mark is a small local SVG. There are no remote asset requests.

## Validation

Check local asset paths, image dimensions, heading/fragment targets, font loading,
and the release's download names. Visually inspect desktop and narrow screens;
use the keyboard to reach every link and toggle both disclosures. Confirm that
no content overflows at 320 px, 390 px, 768 px, and desktop widths.

The current implementation passed static asset, font, markup, and release-link
checks. The user approved visual review, but a saved browser permission still
blocked the local preview. Visual layout and interactive browser checks remain
unverified. This is not a passing browser validation result.
