# Quantum Studio provenance

The statevector engine, simulator interface, build helpers, fixtures and instructions are original
OpenHarness work, licensed MIT. This package does not bundle OpenQASM, Qiskit, Cirq or a cloud SDK
and is not an implementation of those products' full circuit languages.

The engine implements standard complex unitary gates and Born-rule sampling. Conventions are
documented in the skill and tested against known states: qubit 0 is the rightmost basis bit;
Bloch vectors represent local reduced states rather than normalized projections.
