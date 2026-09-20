# Quantum Studio

Read the `quantum` skill. `circuit.json` is the saved circuit; rebuilding generates `index.html` for
the shared viewer. One canonical engine powers both the build proof and browser, so don't reimplement
the math in a second place.

Keep the model honest: q0 is the rightmost basis bit. Entangled qubits can have zero-length local
Bloch vectors without the joint state being empty. Sampling is not hardware execution or a
mid-circuit collapse simulator. State these distinctions when they matter to the user's question.

Use the interactive timeline, gate editor, phase slider, presets, probabilities and shot sampler.
Browser edits have undo/redo but are temporary until downloaded and saved as `circuit.json`.
Rebuild after source edits, assert expected amplitudes for known circuits, then run the browser
proof and inspect the result. Normalization alone does not establish that an algorithm is correct.
