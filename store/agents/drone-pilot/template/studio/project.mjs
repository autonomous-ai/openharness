import { validateRing, lonLat, toLonLat, flightRegion, difference, union, regionArea, pointIn, transects, navigatorFor, distance, length, intersection, orient } from './geo.mjs';

export const ASSUMPTIONS = 'Level ground at takeoff elevation; a nadir camera aligned with each survey run. Geometry and nominal time only: terrain, obstacles, airspace, wind, positioning error and aircraft dynamics are not verified.';
export const clone = value => JSON.parse(JSON.stringify(value));
const text = (value, label, max = 120) => { if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(label + ' must be a nonempty text of at most ' + max + ' characters.'); return value; };
const number = (value, label, min, max) => { if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${label} must be between ${min} and ${max}.`); return value; };
function coordinate(point, label) { if (!Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite) || Math.hypot(...point) > 5000) throw new Error(label + ' needs an east/north coordinate within 5 km.'); return [...point]; }
export function validateProject(input) {
  if (!input || new TextEncoder().encode(JSON.stringify(input)).length > 8000000 || input.schema !== 'vector/2') throw new Error('Open a Vector 2 project smaller than 8 MB.');
  const p = clone(input); text(p.id, 'Project ID'); text(p.title, 'Title'); text(p.brief, 'Brief', 4000); p.origin = lonLat(p.origin); p.home = coordinate(p.home, 'Takeoff');
  if (!Array.isArray(p.areas) || !p.areas.length || p.areas.length > 32) throw new Error('Use 1–32 named boundaries and exclusions.');
  const ids = new Set(); let corners = 0;
  for (const area of p.areas) {
    text(area.id, 'Area ID'); if (ids.has(area.id)) throw new Error('Area IDs must be unique.'); ids.add(area.id); text(area.name, 'Area name');
    if (!['boundary', 'exclusion'].includes(area.kind) || typeof area.locked !== 'boolean') throw new Error('Each area needs a boundary/exclusion kind and a lock state.');
    area.ring = validateRing(area.ring, area.name); corners += area.ring.length;
  }
  if (corners > 200 || !p.areas.some(a => a.kind === 'boundary')) throw new Error('Use at least one boundary and at most 200 total vertices.');
  const longitudes=[p.home,...p.areas.flatMap(a=>a.ring)].map(point=>toLonLat(p.origin,point)[0]);
  if(Math.max(...longitudes)-Math.min(...longitudes)>180)throw new Error('Split a site crossing the 180° meridian before planning; this exporter does not cut antimeridian polygons.');
  const c = p.camera, s = p.settings;
  if (!c || !s) throw new Error('Camera and planning settings are required.'); text(c.name, 'Camera name');
  for (const field of ['sensorWidth', 'sensorHeight', 'focalLength']) number(c[field], 'Camera ' + field + ' (mm)', 1, 100);
  for (const field of ['imageWidth', 'imageHeight']) if (!Number.isInteger(number(c[field], field + ' (pixels)', 100, 30000))) throw new Error('Image dimensions must be whole pixels.');
  number(c.minInterval, 'Minimum capture interval (s)', .05, 60);
  for (const [field, min, max] of [['height', 5, 500], ['speed', .2, 30], ['angle', 0, 179.9], ['frontOverlap', 0, .95], ['sideOverlap', 0, .95], ['margin', 0, 100], ['usableMinutes', 1, 120], ['reservePercent', 0, 80], ['climbSpeed', .2, 10], ['descentSpeed', .2, 10], ['turnSeconds', 0, 60]]) number(s[field], field, min, max);
  if (p.log != null) {
    text(p.log.name, 'Flight file name', 240); text(p.log.sha256, 'Flight source hash', 64);
    if (!/^[a-f0-9]{64}$/.test(p.log.sha256) || !p.log.mapping || !Array.isArray(p.log.records) || p.log.records.length < 2 || p.log.records.length > 12000) throw new Error('Flight records or provenance are invalid.');
    if (typeof p.log.raw !== 'string' || new TextEncoder().encode(p.log.raw).length > 3000000) throw new Error('Keep the original UTF-8 CSV, up to 3 MB, with its recorded flight.');
    if (p.log.maxGap != null) number(p.log.maxGap, 'Track continuity limit (seconds)', .1, 120);
    if (p.log.comparisonSortie != null && (!Number.isInteger(p.log.comparisonSortie) || p.log.comparisonSortie < 1 || p.log.comparisonSortie > 80)) throw new Error('Choose a valid comparison sortie.');
    let previous = -1;
    for (const row of p.log.records) {
      number(row.time, 'Flight elapsed seconds', 0, 172800); if (row.time <= previous) throw new Error('Flight timestamps must be strictly increasing.'); previous = row.time;
      row.point = coordinate(row.point, 'Flight record');
      if (row.altitude !== null) number(row.altitude, 'Flight altitude (m)', -1000, 10000);
      if (row.battery !== null) number(row.battery, 'Recorded battery (%)', 0, 100);
      if (row.heading !== null) number(row.heading, 'Recorded heading (degrees)', 0, 360);
      if (![null, true, false].includes(row.capture)) throw new Error('Capture events must be true, false or unknown.');
      if (typeof row.breakBefore !== 'boolean' || !Number.isInteger(row.sourceRow) || row.sourceRow < 2) throw new Error('Keep flight row provenance and track breaks.');
    }
    if (p.log.records.filter(r => r.capture).length > 3000) throw new Error('Use at most 3,000 recorded capture events.');
  }
  return p;
}
export function footprint(point, heading, width, height) {
  const a = heading * Math.PI / 180, u = [Math.cos(a), Math.sin(a)], v = [-u[1], u[0]];
  return orient([[-1,-1],[1,-1],[1,1],[-1,1]].map(([x,y]) => point.map((n,i) => n + u[i] * x * height / 2 + v[i] * y * width / 2)));
}
export function cameraGeometry(p, height = p.settings.height) {
  const c = p.camera, width = height * c.sensorWidth / c.focalLength, along = height * c.sensorHeight / c.focalLength;
  return { width, along, gsdX: width / c.imageWidth * 100, gsdY: along / c.imageHeight * 100, lineSpacing: width * (1 - p.settings.sideOverlap), photoSpacing: along * (1 - p.settings.frontOverlap) };
}
export function planProject(input, { coverage = true } = {}) {
  const p = validateProject(input), s = p.settings, camera = cameraGeometry(p);
  const boundaries = p.areas.filter(a => a.kind === 'boundary').map(a => a.ring), exclusions = p.areas.filter(a => a.kind === 'exclusion').map(a => a.ring);
  const target = difference(union(boundaries), union(exclusions)), region = flightRegion(boundaries, exclusions, s.margin), area = regionArea(target);
  if (area < 1 || !region.length) throw new Error('The boundary and margin leave no survey area.');
  if (!pointIn(region, p.home)) throw new Error('Move takeoff inside the inset boundary and outside expanded exclusions.');
  const navigate = navigatorFor(region), spans = transects(region, camera.lineSpacing, s.angle), runs = [], photos = [];
  if (!spans.length) throw new Error('No survey runs fit inside the flight area.');
  for (const span of spans) {
    const count = Math.max(1, Math.ceil(span.length / camera.photoSpacing)), spacing = span.length / count;
    if (photos.length + count > 3000) throw new Error('This plan exceeds 3,000 photos. Split the site or revise capture requirements.');
    if (count > 1 && spacing / s.speed + 1e-8 < p.camera.minInterval) throw new Error(`The camera cannot capture this fast. Reduce speed to at most ${(spacing / p.camera.minInterval).toFixed(2)} m/s, raise height, or change capture requirements.`);
    const heading = Math.atan2(span.b[1] - span.a[1], span.b[0] - span.a[0]) * 180 / Math.PI;
    const shots = Array.from({ length: count }, (_, i) => ({ id: photos.length + i + 1, point: span.a.map((n,j) => n + (span.b[j] - n) * (i + .5) / count), heading, run: runs.length + 1 }));
    photos.push(...shots); runs.push({ id: runs.length + 1, row: span.row, photos: shots, spacing, heading });
  }
  const budget = s.usableMinutes * 60 * (1 - s.reservePercent / 100), overhead = s.height / s.climbSpeed + s.height / s.descentSpeed;
  if (overhead >= budget) throw new Error('Climb and descent consume the whole time budget. Revise the plan.');
  const sorties = []; let sortie = null;
  const homeRoutes = new Map();
  function homeRoute(shot) { if (!homeRoutes.has(shot.id)) { const route = navigate(shot.point, p.home); if (!route) throw new Error(`Photo ${shot.id} is in an area disconnected from takeoff. Split the site or move takeoff.`); homeRoutes.set(shot.id, route); } return homeRoutes.get(shot.id); }
  function open() { sortie = { id: sorties.length + 1, path: [[...p.home]], legs: [], photos: [], seconds: s.height / s.climbSpeed, distance: 0, lastCapture: -Infinity }; }
  function addLeg(path, kind, seconds = length(path) / s.speed) {
    sortie.legs.push({ kind, points: path.map(p => [...p]), start: sortie.seconds, seconds }); sortie.path.push(...path.slice(1)); sortie.distance += length(path); sortie.seconds += seconds;
  }
  function finish() {
    if (!sortie?.photos.length) return;
    addLeg(homeRoute(sortie.photos.at(-1)), 'return'); sortie.seconds += s.height / s.descentSpeed;
    sortie.remainingSeconds = budget - sortie.seconds; delete sortie.lastCapture; sorties.push(sortie); sortie = null;
    if (sorties.length > 80) throw new Error('This plan needs more than 80 sorties. Split the job or revise the time budget.');
  }
  open();
  for (const run of runs) {
    let at = 0;
    while (at < run.photos.length) {
      const first = run.photos[at], from = sortie.path.at(-1), transit = navigate(from, first.point);
      if (!transit) throw new Error(`Survey run ${run.id} is disconnected from takeoff. Split the site.`);
      const arrive = sortie.seconds + length(transit) / s.speed;
      const settle = Math.max(s.turnSeconds, p.camera.minInterval - (arrive - sortie.lastCapture), 0);
      let end = at - 1;
      for (let i = at; i < run.photos.length; i++) {
        const shot = run.photos[i], duration = arrive + settle + distance(first.point, shot.point) / s.speed + length(homeRoute(shot)) / s.speed + s.height / s.descentSpeed;
        if (duration <= budget + 1e-7) end = i; else break;
      }
      if (end < at) {
        if (!sortie.photos.length) throw new Error(`Photo ${first.id} cannot fit a return trip within the time budget. Move takeoff, increase usable time, or split the site.`);
        finish(); open(); continue;
      }
      addLeg(transit, 'transit'); addLeg([first.point], 'settle', settle);
      const selected = run.photos.slice(at, end + 1), started = sortie.seconds;
      for (const photo of selected) { photo.sortie = sortie.id; photo.time = started + distance(first.point, photo.point) / s.speed; sortie.photos.push(photo); }
      addLeg(selected.map(photo => photo.point), 'survey'); sortie.lastCapture = sortie.photos.at(-1).time;
      at = end + 1; if (at < run.photos.length) { finish(); open(); }
    }
  }
  finish();
  const footprints = coverage ? union(photos.map(photo => footprint(photo.point, photo.heading, camera.width, camera.along))) : [];
  const covered = coverage ? intersection(target, footprints) : [], gaps = coverage ? difference(target, footprints) : [];
  return { project: p, assumptions: ASSUMPTIONS, target, region, area, camera, runs, photos, sorties, covered, gaps, coverage: coverage ? Math.min(1, regionArea(covered) / area) : null, totalDistance: sorties.reduce((n,s) => n + s.distance,0), totalSeconds: sorties.reduce((n,s) => n + s.seconds,0), budgetSeconds: budget };
}
export function history(initial) {
  let states = [clone(initial)], at = 0;
  return { get value() { return clone(states[at]); }, get canUndo() { return at > 0; }, get canRedo() { return at < states.length - 1; },
    push(next) { const checked = validateProject(next); states = [...states.slice(0, at + 1), checked].slice(-40); at = states.length - 1; return this.value; },
    undo() { if (at > 0) at--; return this.value; }, redo() { if (at < states.length - 1) at++; return this.value; } };
}
