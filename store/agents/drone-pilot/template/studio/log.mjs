import { toLocal, pointIn, segmentWithin, distance, union, intersection, regionArea } from './geo.mjs';
import { cameraGeometry, footprint } from './project.mjs';

export function parseCSV(text) {
  if (typeof text !== 'string' || new TextEncoder().encode(text).length > 3000000) throw new Error('Use a UTF-8 CSV smaller than 3 MB.');
  text = text.replace(/^\uFEFF/, ''); const rows = []; let row = [], field = '', quoted = false, ended = false;
  for (let i = 0; i <= text.length; i++) {
    const c = text[i];
    if (quoted) { if (c === undefined) throw new Error('The CSV has an unclosed quote.'); if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else { quoted = false; ended = true; } } else field += c; }
    else if (c === '"') { if (field.length || ended) throw new Error('A CSV quote is in the wrong position.'); quoted = true; }
    else if (c === ',' || c === '\n' || c === '\r' || c === undefined) {
      row.push(field); field = ''; ended = false;
      if (row.length > 80) throw new Error('Use a CSV with at most 80 columns.');
      if (c !== ',') { if (row.some(v => v.trim())) rows.push(row); row = []; if (c === '\r' && text[i + 1] === '\n') i++; }
    } else { if (ended) throw new Error('Unexpected content after a quoted CSV field.'); field += c; }
    if (rows.length > 12001) throw new Error('Use at most 12,000 recorded samples.');
  }
  const headers = rows.shift()?.map(v => v.trim());
  if (!headers?.length || headers.some(v => !v) || new Set(headers).size !== headers.length) throw new Error('CSV column names must be present and unique.');
  if (rows.length < 2 || rows.some(row => row.length !== headers.length)) throw new Error('Use at least two data rows, with the same columns as the header.');
  return { headers, rows };
}
export async function importFlight(raw, name, mapping, origin) {
  const table = parseCSV(raw), required = ['time', 'latitude', 'longitude'];
  for (const field of required) if (!table.headers.includes(mapping[field])) throw new Error('Choose a ' + field + ' column.');
  for (const field of ['altitude', 'battery', 'heading', 'capture']) if (mapping[field] && !table.headers.includes(mapping[field])) throw new Error('Unknown ' + field + ' column.');
  if (!['seconds', 'milliseconds', 'iso'].includes(mapping.timeUnit)) throw new Error('Choose elapsed seconds, elapsed milliseconds or ISO 8601 with timezone.');
  if (mapping.altitude && (!['meters', 'feet'].includes(mapping.altitudeUnit) || !['takeoff', 'amsl'].includes(mapping.altitudeReference))) throw new Error('Choose altitude units and reference.');
  if (mapping.altitudeReference === 'amsl' && (!Number.isFinite(mapping.homeElevation) || mapping.homeElevation < -500 || mapping.homeElevation > 9000)) throw new Error('Provide takeoff elevation in meters AMSL to convert the log.');
  const at = Object.fromEntries(Object.entries(mapping).map(([key, name]) => [key, table.headers.indexOf(name)]));
  const records = []; let firstTime = null, previous = -Infinity, missingCoordinates = 0, pendingBreak = false;
  const numeric = (value, label, required = false) => { if (!value?.trim()) { if (required) throw new Error(label + ' is missing.'); return null; } const n = Number(value); if (!Number.isFinite(n)) throw new Error(label + ' is not a finite number.'); return n; };
  for (let i = 0; i < table.rows.length; i++) {
    const row = table.rows[i], get = field => at[field] < 0 ? '' : row[at[field]], label = 'CSV row ' + (i + 2); let time;
    if (mapping.timeUnit === 'iso') {
      const value=get('time'),parts=value?.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/);
      if(!parts||!Number.isFinite(Date.parse(value)))throw new Error(label + ': use ISO 8601 timestamps with an explicit timezone.');
      const [year,month,day,hour,minute,second]=parts.slice(1,7).map(Number),leap=year%4===0&&(year%100!==0||year%400===0),days=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31];
      if(month<1||month>12||day<1||day>days[month-1]||hour>23||minute>59||second>59)throw new Error(label+': the timestamp is not a valid calendar date and time.');
      time=Date.parse(value)/1000;
    }
    else time = numeric(get('time'), label + ' time', true) / (mapping.timeUnit === 'milliseconds' ? 1000 : 1);
    if (time <= previous) throw new Error(label + ': timestamps must be strictly increasing. Split repeated flights before importing.');
    previous = time; if (firstTime === null) firstTime = time;
    if (time - firstTime > 172800) throw new Error('A flight log must span no more than 48 hours.');
    const lat = numeric(get('latitude'), label + ' latitude'), lon = numeric(get('longitude'), label + ' longitude');
    if (lat === null || lon === null) { missingCoordinates++; pendingBreak = true; continue; }
    const point = toLocal(origin, [lon, lat]);
    let altitude = numeric(get('altitude'), label + ' altitude'), battery = numeric(get('battery'), label + ' battery'), heading = numeric(get('heading'), label + ' heading'), capture = null;
    if (altitude !== null) { altitude *= mapping.altitudeUnit === 'feet' ? .3048 : 1; if (mapping.altitudeReference === 'amsl') altitude -= mapping.homeElevation; if (altitude < -1000 || altitude > 10000) throw new Error(label + ': altitude is outside the supported range.'); }
    if (battery !== null && (battery < 0 || battery > 100)) throw new Error(label + ': battery must be a percentage from 0 to 100.');
    if (heading !== null && (heading < 0 || heading > 360)) throw new Error(label + ': heading must be degrees clockwise from north, 0–360.');
    if (get('capture')?.trim()) { const value = get('capture').trim().toLowerCase(); if (['1', 'true', 'yes'].includes(value)) capture = true; else if (['0', 'false', 'no'].includes(value)) capture = false; else throw new Error(label + ': capture events must be 1/0, true/false, yes/no, or blank for unknown.'); }
    records.push({ time: time - firstTime, point, altitude, battery, heading, capture, sourceRow: i + 2, breakBefore: pendingBreak }); pendingBreak = false;
  }
  if (records.length < 2) throw new Error('At least two rows need valid coordinates.');
  if (records.filter(r => r.capture).length > 3000) throw new Error('Use at most 3,000 recorded capture events per site.');
  const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw)))].map(n => n.toString(16).padStart(2, '0')).join('');
  return { name, sha256, mapping: { ...mapping }, raw, sourceRows: table.rows.length, missingCoordinates, startTime: mapping.timeUnit === 'iso' ? new Date(firstTime * 1000).toISOString() : null, records };
}
export async function verifyFlightSource(project) {
  if (!project.log) return;
  const log=project.log, rebuilt=await importFlight(log.raw,log.name,log.mapping,project.origin);
  for (const field of ['sha256','sourceRows','missingCoordinates','startTime']) if (JSON.stringify(log[field])!==JSON.stringify(rebuilt[field])) throw new Error('Recorded '+field+' differs from the retained CSV and mapping. Reimport the original flight instead of editing evidence.');
  if(log.records.length!==rebuilt.records.length)throw new Error('Recorded samples differ from the retained CSV.');
  for(let i=0;i<log.records.length;i++){
    const a=log.records[i],b=rebuilt.records[i];
    // Math.sin/cos can differ between browser/Node V8 versions. Ten micrometers is
    // below our 1 mm clipping resolution; original geographic coordinates stay in raw CSV.
    if(distance(a.point,b.point)>1e-5||['time','altitude','battery','heading','capture','sourceRow','breakBefore'].some(key=>a[key]!==b[key]))throw new Error('Recorded samples differ from the retained CSV and mapping. Reimport the original flight instead of editing evidence.');
  }
}
export function analyzeFlight(plan, log = plan.project.log, maxGap = log?.maxGap ?? 10) {
  if (!log) return null;
  if (!Number.isFinite(maxGap) || maxGap < .1 || maxGap > 120) throw new Error('Choose a continuity limit between 0.1 and 120 seconds.');
  const p = plan.project, records = log.records, paths = []; let path = [], measuredDistance = 0, discontinuities = 0, outsideSegments = 0;
  const compared = log.comparisonSortie ? plan.sorties.filter(s => s.id === log.comparisonSortie) : plan.sorties;
  if (!compared.length) throw new Error('The recorded flight refers to a sortie this revision no longer has. Choose the comparison again.');
  const segments = compared.flatMap(s => s.path.slice(1).map((b,i) => [s.path[i],b]));
  function pointToSegment(p,a,b) { const dx=b[0]-a[0],dy=b[1]-a[1],square=dx*dx+dy*dy,t=square ? Math.max(0,Math.min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dy)/square)) : 0; return distance(p,[a[0]+t*dx,a[1]+t*dy]); }
  const deviations = records.map(row => Math.min(...segments.map(([a,b]) => pointToSegment(row.point,a,b)))).sort((a,b) => a-b);
  let outsideSamples = 0, captureEvents = 0, unmodeledCaptures = 0, unknownCaptureSamples = 0; const modeled = [];
  for (let i = 0; i < records.length; i++) {
    const row = records[i], previous = records[i - 1];
    if (!pointIn(plan.region, row.point)) outsideSamples++;
    if (previous && (row.breakBefore || row.time - previous.time > maxGap)) { if (path.length) paths.push(path); path = []; discontinuities++; }
    else if (previous) { measuredDistance += distance(previous.point, row.point); if (!segmentWithin(plan.region, previous.point, row.point)) outsideSegments++; }
    path.push(row.point);
    if (row.capture === null) unknownCaptureSamples++;
    if (row.capture === true) {
      captureEvents++;
      if (!(row.altitude > 0) || row.heading === null) { unmodeledCaptures++; continue; }
      const camera = cameraGeometry(p, row.altitude);
      modeled.push(footprint(row.point, 90 - row.heading, camera.width, camera.along));
    }
  }
  if (path.length) paths.push(path);
  const covered = modeled.length ? intersection(plan.target, union(modeled)) : [];
  const batteries = records.filter(r => r.battery !== null);
  return { paths, measuredDistance, elapsedSeconds: records.at(-1).time - records[0].time, outsideSamples, outsideSegments, discontinuities, missingCoordinates: log.missingCoordinates ?? 0, captureEvents, unmodeledCaptures, unknownCaptureSamples, modeledCaptures: modeled.length, covered, coverage: modeled.length ? Math.min(1, regionArea(covered) / plan.area) : null, startBattery: batteries[0]?.battery ?? null, endBattery: batteries.at(-1)?.battery ?? null, maxGap, comparisonSortie: log.comparisonSortie ?? null, deviationP95: deviations[Math.min(deviations.length-1,Math.floor(deviations.length*.95))], deviationMax: deviations.at(-1),
    interpretation: 'Recorded event footprints are estimates from logged position, altitude and heading plus the current camera and level-ground/nadir assumptions. They do not establish that images exist, are sharp or form a usable map. Track gaps are not connected.' };
}
