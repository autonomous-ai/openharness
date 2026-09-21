# Group A release evidence — 2026-09-20

These are observed results, not certificates of arbitrary future projects.
Native tools were run in isolated temporary workspaces on an Intel Mac; no
printer, microcontroller or Home Assistant installation was contacted.

## Automated checks

- 93 package tests passed, including parsers, mathematical reference cases,
  validation, fresh-output requirements and failed-build regressions. Transport
  fixtures do not stand in for the native runs below.
- 24 isolated-viewer tests passed: sandbox/CORS boundaries, path handling, file
  limits, watchers, process lifecycle and managed Node invocation.
- 21 real browser checks passed, covering desktop/narrow layouts, downloads, state changes,
  invalid imports and HTML-like input. Optional native tests require real built
  workspaces; absent variables result in explicit skips.
- All 12 package manifests conform to the Harness contract. All 12 skills pass
  the skill validator. Runtime copies match the canonical helper.
- Five interaction/performance probes (Web, Data, Quantum, GIS, Godot) measured
  56–60 fps, p95 16.7–16.8 ms and zero long tasks on this machine. Renderer and loaded
  resource hashes are recorded by the probe. Software WebGL can be much slower;
  these are not portable hardware-performance guarantees. A separate default
  headless Chromium run passed functional checks but missed Web Studio's frame
  budget at 50.7 fps on SwiftShader; the release benchmark uses installed Chrome
  with the AMD Metal renderer, not software rendering.

## Actual native outputs

| Harness | Runtime and observed result |
| --- | --- |
| OpenSCAD | 2021.01: Ripple STL, 14,756 triangles, closed edge topology, approximately 87.2 × 87.2 × 76 mm; real CAD view, zoom/orbit/reset inspected. |
| FreeCAD | 1.1.3: Pocket STEP re-imported as two valid closed solids, approximately 48,839 mm³ combined volume; actual enclosure/lid preview and zoom/reset inspected. |
| Orca Slicer | 2.4.2: flattened named demo profiles, fresh G-code, 240 extrusion heights; slicer estimates 30.76 g and 3h23m4s. Layer, stack, projection, download and narrow layout tested. Not printed. |
| Firmware | PlatformIO Core 6.1.18, espressif32 6.10.0: real ESP32 build; static RAM 21,464 / 327,680 bytes; flash 269,197 / 1,310,720 bytes. Dashboard tabs, log filter and firmware download tested. Not flashed. |
| Godot | 4.4.1 with matching export templates: nine native gameplay/rendering assertions and a real browser playthrough collecting all six seeds, win, restart, pause and mobile input. Single-threaded Web export. Caching procedural artwork fixed an observed 9 fps regression: the final Chrome/AMD Metal probe measured 60 fps, p95 16.7 ms, no slow frames or long tasks over 25 pause/restart interaction rounds. |
| Score | LilyPond 2.26.0: warning-free PDF/SVG, one visually reviewed page, 142 MIDI notes, about 35.56 seconds. Playback, seek, speed, pause, downloads and narrow layout tested. Synthesized sketch, not a piano recording. |
| Sheet & Docs | LibreOfficeDev 26.8.0.0.alpha0: real DOCX-to-PDF and XLSX re-save. Full report and native workbook PDF visually inspected. Independent spreadsheet import/recalculation verified 45,500 → 49,200, +3,700, 8.131868%; changing an input recalculates, restoring it restores totals. |
| Home Assistant | yaml 2.8.1 parses the real starter; local state/time/threshold scenarios tested. Unsupported semantics return unknown. No claim of Home Assistant runtime validation. |

Web, Data, Quantum and GIS execute entirely in their actual browser starters.
Quantum's single canonical statevector engine is checked against basis, phase,
inverse, entangled-state and reduced-state reference cases. GIS ships pinned
Leaflet and Natural Earth data for an offline first view.

## Publication assets and boundaries

The 12 store JPEGs are direct 1600×1000 captures of these outputs, under 350 KB
each. No invented UI, simulated build logs or AI-generated product screenshots.
Browser controls that do not persist say so; exports provide a save path.

The new isolated-web-viewer is a separate dependency. Existing trusted
web-viewer consumers retain their original behavior and are not migrated.
Native engines remain separate prerequisites; package docs name tested versions
and binary overrides. Success is not manufacturing, electrical, accounting,
musical or production-home certification.
