import Clipper from './vendor/clipper.cjs';

// Small-site coordinates: WGS 84 ECEF projected into the origin's east/north plane.
// Clipping uses integer millimeters. No map or location is sent to a remote service.
const A = 6378137, F = 1 / 298.257223563, E2 = F * (2 - F), B = A * (1 - F);
const rad = n => n * Math.PI / 180, deg = n => n * 180 / Math.PI;
const SCALE = 1000, EPS = 1e-8;
export const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
export const length = points => points.slice(1).reduce((n, p, i) => n + distance(points[i], p), 0);
export const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
export const signedArea = ring => ring.reduce((n, p, i) => n + cross(p, ring[(i + 1) % ring.length]), 0) / 2;
export const regionArea = rings => Math.abs(rings.reduce((n, ring) => n + signedArea(ring), 0));
const toPath = ring => ring.map(([x, y]) => ({ X: Math.round(x * SCALE), Y: Math.round(y * SCALE) }));
const fromPath = path => path.map(p => [p.X / SCALE, p.Y / SCALE]);
export function orient(ring, positive = true) {
  const result = ring.map(p => [...p]);
  if ((signedArea(result) > 0) !== positive) result.reverse();
  return result;
}
export function lonLat(value) {
  if (!Array.isArray(value) || value.length < 2 || !Number.isFinite(value[0]) || Math.abs(value[0]) > 180 || !Number.isFinite(value[1]) || Math.abs(value[1]) > 85) throw new Error('Use WGS 84 longitude, latitude coordinates between 85° south and north.');
  return value.slice(0, 2);
}
function ecef(value) {
  const [longitude, latitude] = lonLat(value).map(rad), n = A / Math.sqrt(1 - E2 * Math.sin(latitude) ** 2);
  return [n * Math.cos(latitude) * Math.cos(longitude), n * Math.cos(latitude) * Math.sin(longitude), n * (1 - E2) * Math.sin(latitude)];
}
export function toLocal(origin, coordinate) {
  const [longitude, latitude] = lonLat(origin).map(rad), center = ecef(origin), delta = ecef(coordinate).map((n, i) => n - center[i]);
  if (Math.hypot(...delta) > 5000) throw new Error('Keep each site within 5 km of its map origin. Split a larger job into sites.');
  return [-Math.sin(longitude) * delta[0] + Math.cos(longitude) * delta[1], -Math.sin(latitude) * Math.cos(longitude) * delta[0] - Math.sin(latitude) * Math.sin(longitude) * delta[1] + Math.cos(latitude) * delta[2]];
}
export function toLonLat(origin, point) {
  const [longitude, latitude] = lonLat(origin).map(rad), [e, n] = point, center = ecef(origin);
  if (!point.every(Number.isFinite) || Math.hypot(e, n) > 5000) throw new Error('A site coordinate is outside the supported local map.');
  const x = center[0] - Math.sin(longitude) * e - Math.sin(latitude) * Math.cos(longitude) * n;
  const y = center[1] + Math.cos(longitude) * e - Math.sin(latitude) * Math.sin(longitude) * n;
  const z = center[2] + Math.cos(latitude) * n, p = Math.hypot(x, y), theta = Math.atan2(z * A, p * B);
  const lon=deg(Math.atan2(y,x)),lat=deg(Math.atan2(z + E2 / (1 - E2) * B * Math.sin(theta) ** 3, p - E2 * A * Math.cos(theta) ** 3));
  return lonLat([lon===180?-180:lon,lat]);
}
export function bounds(rings) {
  const points = rings.flat();
  if (!points.length) return { min: [0, 0], max: [1, 1], size: [1, 1] };
  const min = [0, 1].map(i => Math.min(...points.map(p => p[i]))), max = [0, 1].map(i => Math.max(...points.map(p => p[i])));
  return { min, max, size: max.map((n, i) => n - min[i]) };
}
function cutParameters(a, b, c, d) {
  const u = b.map((n, i) => n - a[i]), v = d.map((n, i) => n - c[i]), q = c.map((n, i) => n - a[i]), den = cross(u, v);
  if (Math.abs(den) < EPS) {
    if (Math.abs(cross(q, u)) > EPS) return [];
    const axis = Math.abs(u[0]) > Math.abs(u[1]) ? 0 : 1;
    if (Math.abs(u[axis]) < EPS) return [];
    return [c, d].map(p => (p[axis] - a[axis]) / u[axis]).filter(t => t >= -EPS && t <= 1 + EPS);
  }
  const t = cross(q, v) / den, s = cross(q, u) / den;
  return t >= -EPS && t <= 1 + EPS && s >= -EPS && s <= 1 + EPS ? [Math.max(0, Math.min(1, t))] : [];
}
export function validateRing(input, label = 'Boundary') {
  if (!Array.isArray(input)) throw new Error(label + ' needs polygon vertices.');
  const ring = input.map(p => {
    if (!Array.isArray(p) || p.length !== 2 || !p.every(Number.isFinite) || Math.hypot(...p) > 5000) throw new Error(label + ' has an invalid local coordinate.');
    return [...p];
  });
  if (ring.length > 3 && distance(ring[0], ring.at(-1)) < .001) ring.pop();
  if (ring.length < 3 || ring.length > 128 || Math.abs(signedArea(ring)) < 1) throw new Error(label + ' needs 3–128 vertices and at least one square meter.');
  for (let i = 0; i < ring.length; i++) {
    if (distance(ring[i], ring[(i + 1) % ring.length]) < .01) throw new Error(label + ' has duplicate or nearly identical vertices.');
    for (let j = i + 1; j < ring.length; j++) {
      if (j === i + 1 || (i === 0 && j === ring.length - 1)) continue;
      if (cutParameters(ring[i], ring[(i + 1) % ring.length], ring[j], ring[(j + 1) % ring.length]).length) throw new Error(label + ' crosses itself. Move the crossing vertices.');
    }
  }
  return orient(ring);
}
function boolean(subject, clip, type) {
  if (!subject.length) return [];
  const operation = new Clipper.Clipper(); operation.StrictlySimple = true;
  operation.AddPaths(subject.map(toPath), Clipper.PolyType.ptSubject, true);
  if (clip.length) operation.AddPaths(clip.map(toPath), Clipper.PolyType.ptClip, true);
  const out = new Clipper.Paths();
  operation.Execute(type, out, Clipper.PolyFillType.pftNonZero, Clipper.PolyFillType.pftNonZero);
  return out.map(fromPath).filter(p => p.length >= 3 && Math.abs(signedArea(p)) > .000001);
}
export const union = rings => boolean(rings, [], Clipper.ClipType.ctUnion);
export const difference = (a, b) => boolean(a, b, Clipper.ClipType.ctDifference);
export const intersection = (a, b) => b.length ? boolean(a, b, Clipper.ClipType.ctIntersection) : [];
export function offset(rings, meters) {
  if (Math.abs(meters) < .0001) return rings.map(r => r.map(p => [...p]));
  const operation = new Clipper.ClipperOffset(2, .02 * SCALE), out = new Clipper.Paths();
  operation.AddPaths(rings.map(toPath), Clipper.JoinType.jtMiter, Clipper.EndType.etClosedPolygon);
  operation.Execute(out, meters * SCALE); return out.map(fromPath);
}
export function flightRegion(boundaries, exclusions, margin) {
  return difference(offset(union(boundaries), -margin), offset(union(exclusions), margin));
}
export function pointIn(rings, point) {
  const probe = { X: Math.round(point[0] * SCALE), Y: Math.round(point[1] * SCALE) }; let inside = false;
  for (const ring of rings) { const result = Clipper.Clipper.PointInPolygon(probe, toPath(ring)); if (result === -1) return true; if (result === 1) inside = !inside; }
  return inside;
}
export function segmentWithin(rings, a, b) {
  if (!pointIn(rings, a) || !pointIn(rings, b)) return false;
  const cuts = [0, 1];
  for (const ring of rings) for (let i = 0; i < ring.length; i++) cuts.push(...cutParameters(a, b, ring[i], ring[(i + 1) % ring.length]));
  cuts.sort((a, b) => a - b);
  for (let i = 1; i < cuts.length; i++) { const t = (cuts[i - 1] + cuts[i]) / 2; if (!pointIn(rings, a.map((n, j) => n + (b[j] - n) * t))) return false; }
  return true;
}
export function transects(rings, spacing, angleDegrees) {
  if (!rings.length) return [];
  if (!Number.isFinite(spacing) || spacing < .5) throw new Error('Flight lines must be at least 0.5 m apart.');
  const angle = rad(angleDegrees), along = [Math.cos(angle), Math.sin(angle)], across = [-along[1], along[0]], dot = (a, b) => a[0] * b[0] + a[1] * b[1];
  const points = rings.flat(), lo = Math.min(...points.map(p => dot(p, across))), hi = Math.max(...points.map(p => dot(p, across))), u0 = Math.min(...points.map(p => dot(p, along))) - 1, u1 = Math.max(...points.map(p => dot(p, along))) + 1;
  const count = Math.max(1, Math.ceil((hi - lo) / spacing)); if (count > 1000) throw new Error('This requires more than 1,000 flight lines. Split the site or revise capture requirements.');
  const rows = [];
  for (let i = 0; i < count; i++) {
    const v = lo + (i + .5) * (hi - lo) / count, end = u => along.map((n, j) => n * u + across[j] * v), operation = new Clipper.Clipper(), tree = new Clipper.PolyTree();
    operation.AddPath(toPath([end(u0), end(u1)]), Clipper.PolyType.ptSubject, false); operation.AddPaths(rings.map(toPath), Clipper.PolyType.ptClip, true);
    operation.Execute(Clipper.ClipType.ctIntersection, tree, Clipper.PolyFillType.pftNonZero, Clipper.PolyFillType.pftNonZero);
    const spans = Clipper.Clipper.OpenPathsFromPolyTree(tree).map(fromPath).map(path => path.sort((a, b) => dot(a, along) - dot(b, along))).filter(path => length(path) > .1).sort((a, b) => dot(a[0], along) - dot(b[0], along));
    if (i % 2) { spans.reverse(); spans.forEach(path => path.reverse()); }
    for (const path of spans) rows.push({ row: i, a: path[0], b: path.at(-1), length: distance(path[0], path.at(-1)) });
  }
  return rows;
}
export function navigatorFor(rings) {
  const seen = new Set(), vertices = rings.flat().filter(p => { const key = p.join(','); if (seen.has(key)) return false; seen.add(key); return true; });
  if (vertices.length > 350) throw new Error('Simplify the boundary/exclusions to fewer than 350 offset corners before routing.');
  const adjacency = vertices.map(() => []);
  for (let i = 0; i < vertices.length; i++) for (let j = i + 1; j < vertices.length; j++) if (segmentWithin(rings, vertices[i], vertices[j])) { const cost = distance(vertices[i], vertices[j]); adjacency[i].push([j, cost]); adjacency[j].push([i, cost]); }
  return (start, end) => {
    if (segmentWithin(rings, start, end)) return [start, end];
    if (!pointIn(rings, start) || !pointIn(rings, end)) return null;
    const n = vertices.length, points = [...vertices, start, end], edges = adjacency.map(row => [...row]); edges.push([], []);
    for (let j = n; j < n + 2; j++) for (let i = 0; i < n; i++) if (segmentWithin(rings, points[i], points[j])) { const cost = distance(points[i], points[j]); edges[i].push([j, cost]); edges[j].push([i, cost]); }
    const costs = new Float64Array(n + 2).fill(Infinity), previous = new Int32Array(n + 2).fill(-1), visited = new Uint8Array(n + 2); costs[n] = 0;
    for (let k = 0; k < n + 2; k++) {
      let at = -1; for (let i = 0; i < n + 2; i++) if (!visited[i] && (at === -1 || costs[i] < costs[at])) at = i;
      if (at === -1 || !Number.isFinite(costs[at])) return null;
      if (at === n + 1) { const path = []; for (let i = at; i !== -1; i = previous[i]) path.push(points[i]); return path.reverse(); }
      visited[at] = 1; for (const [next, cost] of edges[at]) if (costs[at] + cost < costs[next]) { costs[next] = costs[at] + cost; previous[next] = at; }
    }
    return null;
  };
}
export function parseGeoJSON(value, origin) {
  if (value?.crs) throw new Error('Export the boundary as standard WGS 84 GeoJSON without a custom CRS.');
  const polygons = [], points = [];
  function read(geometry, name = 'Imported area', depth = 0, kind = null) {
    if (!geometry || depth > 8) throw new Error('Invalid GeoJSON geometry.');
    if (geometry.crs) throw new Error('Use standard WGS 84 GeoJSON without a custom CRS.');
    if (geometry.type === 'FeatureCollection') { if (!Array.isArray(geometry.features) || geometry.features.length > 32) throw new Error('Import at most 32 site features.'); for (const f of geometry.features) read(f, name, depth + 1); }
    else if (geometry.type === 'Feature') read(geometry.geometry, String(geometry.properties?.name || name).slice(0, 100), depth + 1, ['boundary','exclusion'].includes(geometry.properties?.kind) ? geometry.properties.kind : kind);
    else if (geometry.type === 'Polygon') polygons.push({ name, kind, coordinates: geometry.coordinates });
    else if (geometry.type === 'MultiPolygon') { if (!Array.isArray(geometry.coordinates) || geometry.coordinates.length > 32) throw new Error('Import at most 32 polygons.'); for (const coordinates of geometry.coordinates) polygons.push({ name, kind, coordinates }); }
    else if (geometry.type === 'Point') points.push({ name, coordinate: lonLat(geometry.coordinates) });
    else throw new Error('Import polygon boundaries and optional point markers. Lines and geometry collections need conversion first.');
  }
  read(value); if (!polygons.length && !points.length) throw new Error('No site geometry was found.');
  if (polygons.length + points.length > 32) throw new Error('Import at most 32 polygons and markers.');
  const center = lonLat(origin || polygons[0]?.coordinates?.[0]?.[0] || points[0].coordinate);
  const areas = polygons.map(({ name, kind, coordinates }) => {
    if (!Array.isArray(coordinates) || !coordinates.length || coordinates.length > 21) throw new Error('Invalid polygon rings.');
    const rings = coordinates.map((ring, i) => {
      if (!Array.isArray(ring) || ring.length < 4 || distance(lonLat(ring[0]), lonLat(ring.at(-1))) > EPS) throw new Error('GeoJSON polygon rings must be closed.');
      return validateRing(ring.map(p => toLocal(center, lonLat(p))), name + (i ? ' hole' : ''));
    });
    const holes = rings.slice(1);
    for (let i = 0; i < holes.length; i++) {
      if (regionArea(difference([holes[i]], [rings[0]])) > .01) throw new Error(name + ' has a hole outside its boundary.');
      if (holes.slice(0, i).some(other => regionArea(intersection([other], [holes[i]])) > .01)) throw new Error(name + ' has overlapping holes.');
    }
    return { name, kind, boundary: rings[0], holes };
  });
  return { origin: center, areas, points: points.map(p => ({ name: p.name, point: toLocal(center, p.coordinate) })) };
}
