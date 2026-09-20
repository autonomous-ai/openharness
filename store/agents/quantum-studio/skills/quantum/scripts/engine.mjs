// One engine for Node proof and the browser. q0 is the least significant bit;
// basis labels read |q(n-1) ... q1 q0>, matching Qiskit's displayed bitstrings.
export const GATE_NAMES = ['H', 'X', 'Y', 'Z', 'S', 'T', 'SDG', 'TDG', 'RX', 'RY', 'RZ', 'CX', 'CZ', 'SWAP'];
const SQ = Math.SQRT1_2;
const MATRICES = {
  H:[SQ,0,SQ,0,SQ,0,-SQ,0], X:[0,0,1,0,1,0,0,0], Y:[0,0,0,-1,0,1,0,0],
  Z:[1,0,0,0,0,0,-1,0], S:[1,0,0,0,0,0,0,1], T:[1,0,0,0,0,0,SQ,SQ],
  SDG:[1,0,0,0,0,0,0,-1], TDG:[1,0,0,0,0,0,SQ,-SQ]
};
export function validateCircuit(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('A circuit must be a JSON object.');
  const { qubits, gates } = value;
  if (!Array.isArray(qubits) || qubits.length < 1 || qubits.length > 8) throw new Error('Use between 1 and 8 qubits.');
  if (qubits.some(q => typeof q !== 'string' || !q.trim() || q.length > 32) || new Set(qubits).size !== qubits.length) throw new Error('Qubit labels must be unique, nonempty strings (32 characters maximum).');
  if (!Array.isArray(gates) || gates.length > 256) throw new Error('Use an array of at most 256 gates.');
  if (value.name !== undefined && (typeof value.name !== 'string' || value.name.length > 200)) throw new Error('Circuit name must be a string of at most 200 characters.');
  if (value.shots !== undefined && (!Number.isInteger(value.shots) || value.shots < 1 || value.shots > 100000)) throw new Error('Shots must be an integer from 1 to 100000.');
  let readout = false;
  const measured = new Set();
  const index = (q, label) => { if (!Number.isInteger(q) || q < 0 || q >= qubits.length) throw new Error(label + ' must name a qubit index from 0 to ' + (qubits.length-1) + '.'); };
  const clean = gates.map((op, i) => {
    if (!op || typeof op !== 'object') throw new Error('Gate ' + (i+1) + ' must be an object.');
    const gate = op.gate === 'CNOT' ? 'CX' : op.gate;
    if (!GATE_NAMES.includes(gate) && gate !== 'measure') throw new Error('Unsupported gate: ' + String(gate));
    index(op.target, 'Gate '+(i+1)+' target');
    if (gate === 'measure') {
      if (measured.has(op.target)) throw new Error('Duplicate terminal measurement.');
      measured.add(op.target); readout = true;
      return { gate, target: op.target };
    }
    if (readout) throw new Error('Only terminal measurements are supported. Move readout after the unitary gates.');
    const result = { gate, target: op.target };
    if (['CX','CZ','SWAP'].includes(gate)) {
      index(op.control, 'Gate '+(i+1)+' control');
      if (op.control === op.target) throw new Error('A two-qubit gate needs two different qubits.');
      result.control = op.control;
    }
    if (['RX','RY','RZ'].includes(gate)) {
      if (!Number.isFinite(op.theta)) throw new Error(gate + ' needs a finite theta in radians.');
      result.theta = op.theta;
    }
    return result;
  });
  return { name: value.name || 'Untitled circuit', qubits: [...qubits], gates: clean, shots: value.shots ?? 1024 };
}

function matrix(op) {
  if (MATRICES[op.gate]) return MATRICES[op.gate];
  const c = Math.cos(op.theta/2), s = Math.sin(op.theta/2);
  if (op.gate === 'RX') return [c,0,0,-s,0,-s,c,0];
  if (op.gate === 'RY') return [c,0,-s,0,s,0,c,0];
  if (op.gate === 'RZ') return [c,-s,0,0,0,0,c,s];
  throw new Error('No matrix for ' + op.gate);
}

export function simulate(value, steps = value.gates?.length) {
  const circuit = validateCircuit(value);
  if (!Number.isInteger(steps) || steps < 0 || steps > circuit.gates.length) throw new Error('Step is outside the circuit.');
  const state = new Float64Array(2 * (1 << circuit.qubits.length)); state[0] = 1;
  for (const op of circuit.gates.slice(0, steps)) {
    // A terminal measure marks readout. This returns the premeasurement state;
    // sampleShots performs Born-rule sampling without pretending to collapse it.
    if (op.gate === 'measure') continue;
    const target = 1 << op.target, control = 1 << op.control;
    if (op.gate === 'SWAP') {
      for (let i=0;i<state.length/2;i++) if (!(i&target) && (i&control)) {
        const j = i ^ target ^ control;
        [state[2*i],state[2*j]]=[state[2*j],state[2*i]];
        [state[2*i+1],state[2*j+1]]=[state[2*j+1],state[2*i+1]];
      }
      continue;
    }
    const controlled = op.gate === 'CX' || op.gate === 'CZ';
    const m = controlled ? MATRICES[op.gate === 'CX' ? 'X' : 'Z'] : matrix(op);
    for (let i=0;i<state.length/2;i++) {
      if (i&target || (controlled && !(i&control))) continue;
      const j=i|target, ar=state[2*i], ai=state[2*i+1], br=state[2*j], bi=state[2*j+1];
      state[2*i]   = m[0]*ar-m[1]*ai + m[2]*br-m[3]*bi;
      state[2*i+1] = m[0]*ai+m[1]*ar + m[2]*bi+m[3]*br;
      state[2*j]   = m[4]*ar-m[5]*ai + m[6]*br-m[7]*bi;
      state[2*j+1] = m[4]*ai+m[5]*ar + m[6]*bi+m[7]*br;
    }
  }
  const norm = probabilities(state).reduce((sum,p) => sum+p,0);
  if (!Number.isFinite(norm) || Math.abs(norm-1)>1e-9) throw new Error('The statevector is not finite and normalized.');
  return state;
}

export function probabilities(state) {
  return Array.from({length:state.length/2}, (_,i) => state[2*i]**2+state[2*i+1]**2);
}

export function bloch(state, qubit) {
  const n = Math.log2(state.length/2);
  if (!Number.isInteger(n) || !Number.isInteger(qubit) || qubit<0 || qubit>=n) throw new Error('Invalid Bloch-vector input.');
  const mask=1<<qubit;
  let x=0,y=0,z=0;
  for(let i=0;i<state.length/2;i++) if(!(i&mask)) {
    const j=i|mask, ar=state[2*i], ai=state[2*i+1], br=state[2*j], bi=state[2*j+1];
    x += 2*(ar*br+ai*bi);
    y += 2*(ar*bi-ai*br);
    z += ar*ar+ai*ai-br*br-bi*bi;
  }
  // A reduced state can lie inside the sphere. Never normalize its vector.
  const length=Math.hypot(x,y,z);
  return {x,y,z,length,purity:(1+length*length)/2,p0:(1+z)/2,p1:(1-z)/2};
}

export function sampleShots(state, shots, random = Math.random) {
  if (!Number.isInteger(shots) || shots<1 || shots>100000) throw new Error('Shots must be an integer from 1 to 100000.');
  const probs=probabilities(state), counts=new Array(probs.length).fill(0);
  const norm=probs.reduce((sum,p)=>sum+p,0);
  if (!Number.isFinite(norm) || Math.abs(norm-1)>1e-9) throw new Error('Cannot sample an unnormalized state.');
  for(let shot=0;shot<shots;shot++) {
    const r=random();
    if(!Number.isFinite(r) || r<0 || r>=1) throw new Error('Random samples must be in [0, 1).');
    let cumulative=0;
    for(let i=0;i<probs.length;i++) {
      cumulative+=probs[i];
      if(r<cumulative || i===probs.length-1){counts[i]++;break;}
    }
  }
  return counts;
}

export function basisLabel(index,n) { return index.toString(2).padStart(n,'0'); }
