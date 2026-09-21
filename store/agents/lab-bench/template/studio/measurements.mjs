import {assert, clone, validateProject, event, finite, text, digest, canonical} from './project.mjs';
export function parseCSV(input) {
  assert(typeof input === 'string' && input.length <= 1000000, 'Use a UTF-8 CSV below 1 MB.');
  const s = input.replace(/^\uFEFF/, ''), records = []; let cells = [], field = '', quoted = false, closed = false, line = 1, start = 1;
  const endField = () => {cells.push(field); field = ''; closed = false;};
  const endRow = () => {endField(); if (cells.some(x => x !== '')) records.push({row: start, cells}); cells = []; start = line + 1;};
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {if (s[i + 1] === '"') {field += '"'; i++;} else {quoted = false; closed = true;}}
      else {field += c; if (c === '\n' || (c === '\r' && s[i + 1] !== '\n')) line++;}
    } else if (c === '"') {assert(field === '' && !closed, `Unexpected quote at line ${line}.`); quoted = true;}
    else if (c === ',') endField();
    else if (c === '\n' || c === '\r') {if (c === '\r' && s[i + 1] === '\n') i++; endRow(); line++;}
    else {assert(!closed, `Unexpected text after a quoted field at line ${line}.`); field += c;}
  }
  assert(!quoted, 'The CSV ends inside a quoted field.'); if (field || cells.length || closed) endRow();
  assert(records.length >= 1 && records.length <= 1025, 'Include a header and at most 1024 measurement rows.');
  const headers = records.shift().cells.map(x => x.trim());
  assert(headers.length >= 2 && headers.length <= 40 && headers.every(x => text(x, 160)) && new Set(headers).size === headers.length, 'Use 2–40 distinct, nonempty column names.');
  for (const r of records) assert(r.cells.length === headers.length, `Line ${r.row} has ${r.cells.length} cells; the header has ${headers.length}.`);
  return {headers, rows: records.map(r => ({row: r.row, values: Object.fromEntries(headers.map((h, i) => [h, r.cells[i]]))}))};
}
export function numeric(value) {
  const s = String(value).trim(); assert(/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(s) && finite(Number(s)), 'Use a finite decimal measurement, with no unit text or thousands separators.'); return Number(s);
}
export function decode(bytes) {try {return new TextDecoder('utf-8', {fatal: true}).decode(bytes);} catch {throw new Error('The CSV must use UTF-8 text.');}}
export function base64(bytes) {let s = ''; for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192)); return btoa(s);}
export const bytesFromBase64 = s => Uint8Array.from(atob(s), x => x.charCodeAt(0));
export function mappedRows(p, parsed, mapping, unit, {checkExisting = true} = {}) {
  assert(parsed.headers.includes(mapping.runId) && parsed.headers.includes(mapping.response) && mapping.runId !== mapping.response, 'Map two different columns: run id and measured response.');
  assert(unit === p.response.unit, `Confirm measurements are in ${p.response.unit}. No unit conversion is applied.`);
  const runs = new Map(p.runs.map(r => [r.id, r])), seen = new Set(), measured = new Set(p.measurements.map(m => m.runId)); let pending = 0; const records = [];
  for (const row of parsed.rows) {
    const runId = row.values[mapping.runId].trim(), run = runs.get(runId);
    assert(run, `Line ${row.row}: unknown run id “${runId}”. Use the run sheet ids.`); assert(!seen.has(runId), `Line ${row.row}: duplicate run id ${runId}.`); seen.add(runId);
    for (const f of p.factors) if (Object.hasOwn(row.values, f.id)) {
      const value = f.type === 'number' ? numeric(row.values[f.id]) : row.values[f.id];
      assert(value === run.settings[f.id], `Line ${row.row}: ${f.name} does not match the planned run.`);
    }
    if (Object.hasOwn(row.values, 'block')) assert(row.values.block === run.block, `Line ${row.row}: the block does not match the plan.`);
    if (Object.hasOwn(row.values, 'unit')) assert(row.values.unit === unit, `Line ${row.row}: the response unit does not match.`);
    if (row.values[mapping.response].trim() === '') {pending++; continue;}
    assert(!checkExisting || !measured.has(runId), `${runId} is already measured. Use a logged correction to change it.`);
    let value; try {value = numeric(row.values[mapping.response]);} catch (e) {throw new Error(`Line ${row.row}: ${e.message}`);}
    records.push({runId, value, row: row.row, note: row.values.note ?? ''});
  }
  return {records, pending, rows: parsed.rows.length};
}
export async function prepareImport(raw, bytes, {name, mapping, unit}) {
  const p = validateProject(raw); assert(bytes.length > 0 && bytes.length <= 1000000, 'Use a nonempty CSV below 1 MB.');
  const parsed = parseCSV(decode(bytes)), mapped = mappedRows(p, parsed, mapping, unit);
  assert(mapped.records.length, 'This file has no new measured responses. Blank response cells remain pending.');
  const sha256 = await digest(bytes); assert(!p.sources.some(s => s.sha256 === sha256), 'This original file has already been imported.');
  return {source: {id: 'csv' + (p.sources.length + 1) + '_' + sha256.slice(0, 10), name, base64: base64(bytes), sha256, mapping, unit, importedAt: new Date().toISOString()}, ...mapped};
}
export function commitImport(raw, prepared) {
  const p = validateProject(raw);
  // Reparse at commit so stale previews cannot overwrite a measurement entered in the meantime.
  const source = prepared.source, mapped = mappedRows(p, parseCSV(decode(bytesFromBase64(source.base64))), source.mapping, source.unit);
  assert(!p.sources.some(s => s.id === source.id || s.sha256 === source.sha256), 'This source is already part of the experiment.');
  p.sources.push(clone(source));
  for (const r of mapped.records) p.measurements.push({runId: r.runId, value: r.value, origin: {kind: 'csv', source: source.id, row: r.row, value: r.value}, note: r.note, excluded: null});
  event(p, 'import', `Imported ${mapped.records.length} measured responses from ${source.name}; ${mapped.pending} blank responses remain pending.`, {source: source.id, sha256: source.sha256, runs: mapped.records.map(r => r.runId)});
  return validateProject(p);
}
export function recordMeasurement(raw, runId, {value, note = '', excluded = null, reason}) {
  const p = validateProject(raw); assert(p.runs.some(r => r.id === runId), 'Choose a known run.');
  const n = typeof value === 'number' ? value : numeric(value); assert(finite(n), 'Enter a finite measured value.');
  const i = p.measurements.findIndex(m => m.runId === runId), before = i < 0 ? null : clone(p.measurements[i]);
  const after = {runId, value: n, origin: before?.origin ?? {kind: 'manual', value: n}, note, excluded};
  if (i < 0) p.measurements.push(after); else p.measurements[i] = after;
  event(p, 'measurement', reason, {runId, before, after}); return validateProject(p);
}
export async function verifySources(raw) {
  const p = validateProject(raw);
  for (const source of p.sources) {
    const bytes = bytesFromBase64(source.base64); assert(await digest(bytes) === source.sha256, `Original file hash mismatch: ${source.name}.`);
    const {records} = mappedRows(p, parseCSV(decode(bytes)), source.mapping, source.unit, {checkExisting: false});
    for (const record of records) assert(p.measurements.some(m => m.runId === record.runId && m.origin.source === source.id && m.origin.row === record.row), `Keep every imported measurement; use an exclusion reason instead of deleting ${record.runId}.`);
    for (const m of p.measurements.filter(m => m.origin.kind === 'csv' && m.origin.source === source.id)) {
      const original = records.find(r => r.runId === m.runId && r.row === m.origin.row);
      assert(original?.value === m.origin.value, `Original measurement provenance does not match ${source.name}: ${m.runId}.`);
    }
  }
  return p;
}
export const csvCell = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
export const csv = rows => rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
export function collectionCSV(p, {blank = true, phase = null} = {}) {
  const measurements = new Map(p.measurements.map(m => [m.runId, m]));
  return csv([['run_id', 'order', 'phase', 'block', 'kind', ...p.factors.map(f => f.id), 'response', 'unit', 'note'],
    ...p.runs.filter(r => !phase || r.phase === phase).map(r => {const m = measurements.get(r.id); return [r.id, r.order, r.phase, r.block, r.kind, ...p.factors.map(f => r.settings[f.id]), blank ? '' : m?.value, p.response.unit, blank ? '' : m?.note];})]);
}
