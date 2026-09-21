import { toLonLat } from '../template/studio/geo.mjs';
export function orchard() {
  return { schema: 'vector/2', id: 'alder-orchard', title: 'Alder Orchard', brief: 'Example geometry, not a surveyed or authorized site. Document the orchard blocks, avoid the irrigation pond and keep a return allowance in each sortie. Replace the boundary and camera with measured values before doing your own planning.', origin: [-122.802, 38.466], home: [20,20], areas: [
    { id: 'orchard', name: 'Orchard blocks', kind: 'boundary', locked: false, ring: [[0,0],[420,0],[420,260],[280,300],[0,300]] },
    { id: 'pond', name: 'Irrigation pond', kind: 'exclusion', locked: true, ring: [[200,100],[265,95],[285,150],[240,175],[200,150]] }
  ], camera: { name: 'Example camera — enter your measured specs', sensorWidth: 13.2, sensorHeight: 8.8, focalLength: 8.8, imageWidth: 5472, imageHeight: 3648, minInterval: 1 }, settings: { height: 55, speed: 6, angle: 0, frontOverlap: .75, sideOverlap: .7, margin: 6, usableMinutes: 14, reservePercent: 20, climbSpeed: 3, descentSpeed: 2, turnSeconds: 3 } };
}
export function yard() {
  const p = orchard(); Object.assign(p, { id: 'works-yard', title: 'Works Yard', brief: 'Synthetic construction-site planning brief. Resolve the L-shaped work area and two equipment exclusions at a finer ground sampling distance. Capture requirements and camera geometry are editable examples.', origin: [151.09,-33.9], home: [12,12] });
  p.areas = [ { id: 'site', name: 'L-shaped works', kind: 'boundary', locked: false, ring: [[0,0],[260,0],[260,90],[145,90],[145,215],[0,215]] }, { id: 'stores', name: 'Storage compound', kind: 'exclusion', locked: true, ring: [[38,40],[82,40],[82,77],[38,77]] }, { id: 'plant', name: 'Equipment area', kind: 'exclusion', locked: false, ring: [[90,125],[120,125],[120,167],[90,167]] } ];
  Object.assign(p.settings, { height: 30, speed: 3, angle: 90, margin: 4, usableMinutes: 9 }); return p;
}
export function estuary() {
  const p = orchard(); Object.assign(p, { id: 'estuary-plots', title: 'Estuary Plots', brief: 'Synthetic restoration-site brief. Compare two connected plots, a diagonal survey direction and a large central exclusion. This is level-ground planning geometry; no terrain, water level or permissions have been supplied.', origin: [-9.18,38.69], home: [20,30] });
  p.areas = [ { id: 'west', name: 'West restoration plot', kind: 'boundary', locked: true, ring: [[0,0],[160,0],[220,70],[195,180],[90,235],[0,180]] }, { id: 'east', name: 'East restoration plot', kind: 'boundary', locked: false, ring: [[175,70],[350,35],[415,95],[390,245],[250,255],[180,180]] }, { id: 'reed', name: 'Reed bed', kind: 'exclusion', locked: true, ring: [[95,90],[125,55],[170,85],[155,130],[110,140]] } ];
  Object.assign(p.settings, { height: 45, speed: 4.5, angle: 32, margin: 5, usableMinutes: 10 }); return p;
}
export function siteGeoJSON(p) {
  return { type: 'FeatureCollection', features: p.areas.map(area => ({ type: 'Feature', properties: { name: area.name, kind: area.kind }, geometry: { type: 'Polygon', coordinates: [[...area.ring,area.ring[0]].map(point => toLonLat(p.origin,point))] } })) };
}
export function recordedCSV(plan) {
  // Deliberately synthetic evidence fixture, including a gap and missing camera data.
  const shots = plan.sorties[0].photos.filter((_,i) => i % 3 === 0).slice(0,32);
  return 'time_s,latitude,longitude,height_ft,heading_deg,battery_pct,capture\n' + shots.map((shot,i) => {
    const [lon,lat] = toLonLat(plan.project.origin,shot.point); return [i * 4 + (i > 10 ? 25 : 0), lat.toFixed(9), lon.toFixed(9), (plan.project.settings.height / .3048).toFixed(5), i === 3 ? '' : (90 - shot.heading + 360) % 360, (98 - i * .8).toFixed(1), i === 7 ? '' : i % 4 ? '1' : '0'].join(',');
  }).join('\n');
}
export const logMapping = { time:'time_s',timeUnit:'seconds',latitude:'latitude',longitude:'longitude',altitude:'height_ft',altitudeUnit:'feet',altitudeReference:'takeoff',homeElevation:0,heading:'heading_deg',battery:'battery_pct',capture:'capture' };
