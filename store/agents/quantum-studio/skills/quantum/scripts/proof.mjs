#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { validateCircuit, simulate, probabilities, basisLabel } from './engine.mjs';
try {
  if (!process.argv[2]) throw new Error('usage: proof.mjs circuit.json');
  const circuit = validateCircuit(JSON.parse(readFileSync(process.argv[2], 'utf8')));
  const state = simulate(circuit), probs = probabilities(state);
  console.log('SIM OK qubits=' + circuit.qubits.length + ' gates=' + circuit.gates.length + ' norm=' + probs.reduce((a,b)=>a+b,0).toFixed(8));
  for (const [i, p] of probs.entries()) if (p > 1e-12) console.log('|' + basisLabel(i, circuit.qubits.length) + '⟩ ' + (p * 100).toFixed(6) + '%');
} catch (error) { console.error('proof: ' + error.message); process.exitCode = 1; }
