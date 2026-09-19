---
name: quantum
description: Build, explain and verify small quantum circuits in Quantum Studio's editable statevector simulator.
---

# Quantum Studio

The saved source is `circuit.json`:

```json
{"name":"Bell state","qubits":["q0","q1"],"gates":[{"gate":"H","target":0},{"gate":"CX","control":0,"target":1}],"shots":1024}
```

Limits: 1–8 uniquely named qubits, 256 gates, 1–100,000 shots. Gates apply in array order.
Targets and controls are zero-based. The basis is `|q(n−1)…q1q0⟩`: qubit 0 is the rightmost bit.

Supported gates: H, X, Y, Z, S, T, SDG, TDG, RX, RY, RZ, CX (alias CNOT), CZ, SWAP.
Rotations use `theta` in radians in JSON; the UI slider displays degrees. Two-qubit gates require
distinct `control` and `target`. Arbitrary matrices and mid-circuit measurements are not supported.
Terminal `measure` markers may be present, but the displayed state is premeasurement. The shot
sampler draws computational-basis outcomes from the joint Born probabilities, without collapse,
noise, hardware jobs or persistent quantum state.

Bloch vectors are reduced single-qubit expectations. A Bell pair has individually maximally mixed
qubits (purity 0.5), not unit vectors. Preserve their lengths; do not normalize them for display.

## Build and prove

```sh
sh "$QUANTUM_SKILLS/quantum/scripts/build-quantum.sh"
node "$QUANTUM_SKILLS/quantum/scripts/proof.mjs" circuit.json
node "$QUANTUM_SKILLS/quantum/scripts/screenshot.mjs" "$HARNESS_WORKSPACE/index.html"
node "$QUANTUM_SKILLS/quantum/scripts/perf.mjs" "$HARNESS_WORKSPACE/index.html"
```

Build validates the schema and finite normalized state, safely embeds JSON, and updates the verdict.
Failures clear readiness even if an older HTML export remains. Add assertions for the expected state,
not just its norm. `engine.mjs` exports `simulate`, `probabilities`, `bloch` and `sampleShots` for tests.

The browser proof also needs Playwright + Chromium (shared viewer installation or `PLAYWRIGHT_MODULE`)
and a current `proof.json` interaction recipe. It checks actual results, records errors/hashes and
captures `.harness/last.png`. Inspect the image, stepping, edits, undo/redo and narrow layout.

The user can edit gates, scrub the timeline, change rotation phase and sample shots directly.
Those edits stay in browser memory. Download the circuit and save it to the workspace to preserve it;
never imply the viewer wrote back to disk.
