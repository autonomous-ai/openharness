# Quantum Studio

A local quantum workbench for seeing what gates actually do. Step through a circuit, edit its gates,
drag the Bloch views, explore phase interference, compare joint probabilities and sample outcomes.
Bell, GHZ and interference presets give you useful experiments immediately. Undo, redo, JSON import
and download make the circuit editable, not just a picture.

Try: “Show me why a Bell pair has random individual qubits but correlated measurements.”

Choose **Quantum Studio** in the Harness Store. It needs Node 20+ and the shared Web Viewer, not a
cloud account or a quantum SDK. The same tested statevector engine runs in the build and browser.

Supported: 1–8 qubits, standard single-qubit/rotation gates, CX, CZ and SWAP, and up to 256 gates.
No noise model, hardware execution or mid-circuit measurement. Bloch views show reduced states
without hiding mixedness. Shot results are sampled, so small runs vary.

`circuit.json` is the saved source. Browser edits are temporary until downloaded; rebuilding
regenerates the preview. Optional Playwright helpers verify real browser interactions and performance.

```sh
harness dsh install "$PWD/store/agents/quantum-studio" --link
harness dsh doctor autonomous/quantum-studio
```

## Credit and stewardship

The original wrapper and starter are MIT-licensed OpenHarness work. See
[PROVENANCE.md](PROVENANCE.md) for upstream tools, datasets and their separate
licenses. No upstream ownership or endorsement is implied. Wrapper issues belong
in OpenHarness; upstream maintainers are welcome to take stewardship of a package.
