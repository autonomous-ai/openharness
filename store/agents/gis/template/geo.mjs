const supported = new Set(['Point','MultiPoint','LineString','MultiLineString','Polygon','MultiPolygon']);

export function validateGeoJSON(value) {
  if (!value || value.type !== 'FeatureCollection' || !Array.isArray(value.features)) throw new Error('Open a GeoJSON FeatureCollection.');
  if (value.features.length > 2000) throw new Error('This local explorer supports up to 2,000 features. Simplify or split this dataset.');
  let vertices = 0;
  const coordinate = point => {
    if (!Array.isArray(point) || point.length < 2 || point.length > 3 || !point.every(Number.isFinite) || Math.abs(point[0]) > 180 || Math.abs(point[1]) > 90) throw new Error('Coordinates must be WGS 84 [longitude, latitude] in degrees.');
    if (++vertices > 100000) throw new Error('Simplify to at most 100,000 vertices for interactive exploration.');
  };
  const array = (points, min, visit) => {
    if (!Array.isArray(points) || points.length < min) throw new Error('A geometry has too few coordinates.');
    points.forEach(visit);
  };
  const line = points => array(points, 2, coordinate);
  const ring = points => {
    array(points, 4, coordinate);
    if (points[0][0] !== points.at(-1)[0] || points[0][1] !== points.at(-1)[1]) throw new Error('Polygon rings must close on their starting coordinate.');
  };
  for (const [index, feature] of value.features.entries()) {
    if (!feature || feature.type !== 'Feature' || !supported.has(feature.geometry?.type)) throw new Error('Feature ' + (index+1) + ': use Point, LineString, Polygon or their Multi variants.');
    if (feature.properties !== null && (typeof feature.properties !== 'object' || Array.isArray(feature.properties))) throw new Error('Feature properties must be an object or null.');
    const { type, coordinates } = feature.geometry;
    if (type === 'Point') coordinate(coordinates);
    if (type === 'MultiPoint') array(coordinates, 1, coordinate);
    if (type === 'LineString') line(coordinates);
    if (type === 'MultiLineString') array(coordinates, 1, line);
    if (type === 'Polygon') array(coordinates, 1, ring);
    if (type === 'MultiPolygon') array(coordinates, 1, polygon => array(polygon, 1, ring));
  }
  return value;
}

export function featureName(feature, index) {
  return String(feature.properties?.name ?? feature.properties?.title ?? feature.id ?? 'Feature ' + (index+1));
}

// Great-circle distance on a mean-radius sphere, not a road or survey distance.
export function distanceKm(a, b) {
  const rad = Math.PI / 180, dlat = (b[1]-a[1])*rad, dlon = (b[0]-a[0])*rad;
  const h = Math.sin(dlat/2)**2 + Math.cos(a[1]*rad)*Math.cos(b[1]*rad)*Math.sin(dlon/2)**2;
  return 6371.0088 * 2 * Math.asin(Math.sqrt(Math.max(0,Math.min(1,h))));
}

export function filterFeatures(features, query='', type='all') {
  const term = query.trim().toLocaleLowerCase();
  return features.map((feature,index)=>({ feature,index,name:featureName(feature,index) }))
    .filter(row => (type==='all'||row.feature.geometry.type===type) && row.name.toLocaleLowerCase().includes(term));
}
