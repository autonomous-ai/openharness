# CircuitJS, as a Harness agent

[Harness](https://github.com/autonomous-ai/openharness) agent package for
[CircuitJS1](https://www.falstad.com/circuit/), Paul Falstad's interactive circuit simulator:
describe a circuit in the terminal, watch it run in the pane while the agent writes it — charge
moving along the wires, scope traces drawing, sliders you can turn while it runs. Runs on Codex.

The pane is the real simulator, not a picture of one. Drag a part, change a value, open the
Circuits menu and load one of the 373 examples: it keeps running, and the agent's next save lands in
the app without a reload.

**Scope Lab** turns a circuit you tried into something you can compare and keep. Choose named
nodes or component voltage/current, capture a window, change a value and overlay the new trace.
Place two cursors to measure the difference, zoom between them, and write down what you learned.
Each capture runs in a separate instance of the real CircuitJS solver, using the current in-pane
circuit export. It leaves the visible simulation and the workspace source alone.

![Native traces of the same RC filter at two resistance values](../../../docs/images/scope-lab.png)

[Watch the native walkthrough](../../../docs/images/scope-lab-demo.mp4).

**Keep capture** saves an immutable `.harness/circuit-captures/<id>/` packet: the exact native
export, the capture instance's export, timestamped CSV/JSON measurements, a standalone SVG trace,
your notes, runtime fingerprints, checksums and a ZIP. Reopen it from **Your captures**, including
after a restart or after removing the original circuit. Unsaved takes stay in this tab; keep or
discard them before closing. Arrow keys move the active cursor; Enter switches A/B.
Within this tab, reopening Scope Lab or keeping the current capture preserves its cursors and zoom.
Choosing a different capture starts a fresh measurement view.

The capture is a new simulation of an exported circuit, not a full checkpoint of the running
solver. It uses a fresh time origin and faster display pacing; imported internal state can produce
different initial transients. Comparison matches named nodes, or component type and element index;
preserve those identities when editing. A packet holds one capture, so keep both traces you compare.

Windows range from 1 ms to 5 s with up to eight probes and about 2,000 stored samples. Every value
comes from a native solver callback at its recorded time. Min/max/mean/RMS describe these samples;
mean and RMS use trapezoidal time weighting. Faster signals and narrow spikes can be missed: use
a shorter window and suitable native timestep. These are simulator observations, not measurements
of hardware or a validation of a component model. Captures stop after 30 wall seconds or ten million
solver steps; stopped traces remain explicitly partial. Limits are 1,000 elements, 512 KB per
circuit export, a 4 MB packet, eight open unsaved captures and 100 kept captures per workspace.

- `harness.json` — engine, template, skill, toolchain, and this package's own viewer.
- `viewer.mjs` + `viewer.html` — the pane: CircuitJS1 in a same-origin iframe served off loopback,
  under a bar that says what is going on — **Live**, **Updated** when the agent's save lands,
  **Waiting for circuit.txt**, or how many lines did not load — with the simulation clock,
  Pause/Run, Revert (load the file again) and a **?** legend for the colours, the moving dots, the
  scopes and the mouse. Below it, a **Nodes** row reads every labeled node's voltage live. A save
  becomes a `CircuitJS1.importCircuit()` call through the app's own JavaScript interface — only when
  the circuit's text really changed, so other files never reset the simulation — and the app keeps
  its window and its run state. Lines the app cannot load are listed by line number (the package's
  own checker, `toolchain/verdict.py`, plus the app's own load log) above a circuit that keeps
  running. The app boots with its own URL options `cct=` (an empty circuit, so the first load goes
  the same way as every other) and `mouseWheelEdit=false` (scrolling over a part zooms rather than
  silently changing its value).
- `toolchain/setup.sh` — fetches CircuitJS1 into `upstream/` (gitignored); `verdict.py` parses the
  circuit and writes `.harness/verdict.json`; `doctor.sh` says what is missing.
- `skills/circuitjs/` — the file format, the layout rules and nine of upstream's own circuits.
  `template/` — a 555 astable flashing an LED, with three scopes.

```sh
harness dsh check .                                  # conformance
harness dsh install "$PWD" --link                    # this checkout as the installed agent
harness dsh doctor autonomous/circuitjs              # what the machine is missing
python3 -m unittest toolchain/test_verdict.py        # the judge's own tests
python3 -m unittest toolchain/test_scripts.py        # setup (a local stand-in for the downloads), doctor, init, viewer.sh
node --test test/*.test.mjs                          # server + capture/archive checks; stand-in upstream/war
# Native browser acceptance requires setup.sh's real CircuitJS runtime and Playwright/Chrome:
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs CHROME=/path/to/chrome \
  EVIDENCE=/tmp/scope-lab-evidence node test/scope-lab-browser.mjs
```

## Credit and stewardship

CircuitJS1 is Paul Falstad's and Iain Sharp's — [pfalstad/circuitjs1](https://github.com/pfalstad/circuitjs1),
**GPL-2.0** (`LICENSE-circuitjs1`). Nothing of it is changed and nothing of it is vendored here:
`toolchain/setup.sh` downloads it at install time, pinned in `VERSIONS`, and the pane serves it as
published. `THIRD_PARTY_NOTICES.md` says exactly what is fetched, from where, and the two
serving-time edits the pane makes to `circuitjs.html`. This folder is the Harness wrapper — the
manifest, the pane server, a skill, the verdict — written by Autonomous to bring CircuitJS1 into
Harness, on the project's behalf, to bootstrap the catalogue.

Upstream commits no compiled output and cuts no releases; its own CI publishes the build to
[pfalstad.github.io/circuitjs1](https://pfalstad.github.io/circuitjs1/circuitjs.html), which the
upstream README names as the hosted development version, and that is where `setup.sh` takes the
compiled module from. If that ever changes — a release, a published artefact — `VERSIONS` is the one
place to point somewhere better.

If you maintain CircuitJS1 and want to own its Harness package, it is yours: open an issue on
[OpenHarness](https://github.com/autonomous-ai/openharness/issues) and we move this folder into a
repository of yours and point the registry entry at it. Until then: bugs in CircuitJS1 belong upstream, bugs
in the wrapper belong here, and a newer CircuitJS1 is a bump in `VERSIONS`.
