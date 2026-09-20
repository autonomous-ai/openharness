import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { validateGeoJSON, filterFeatures, distanceKm } from '../template/geo.mjs';
const feature=(type,coordinates,properties={name:'A'})=>({type:'Feature',properties,geometry:{type,coordinates}});
const collection=features=>({type:'FeatureCollection',features});
test('all supported geometries validate, while malformed coordinates, open rings and excessive datasets fail',()=>{
  const ring=[[0,0],[1,0],[1,1],[0,0]];
  const good=collection([feature('Point',[0,0]),feature('MultiPoint',[[1,2],[2,3]]),feature('LineString',[[0,0],[1,1]]),feature('MultiLineString',[[[0,0],[1,1]]]),feature('Polygon',[ring]),feature('MultiPolygon',[[ring]])]);
  assert.equal(validateGeoJSON(good),good);
  for(const bad of [null,{},collection([feature('Point',[190,0])]),collection([feature('Point',[1,NaN])]),collection([feature('Point',[])]),collection([feature('Polygon',[[[0,0],[1,0],[1,1],[0,1]]])]),collection([feature('GeometryCollection',[])]),collection(Array(2001).fill(good.features[0]))])assert.throws(()=>validateGeoJSON(bad));
});
test('filtering keeps original identities and exports genuine source features',()=>{
  const data=collection([feature('Point',[1,2],{name:'Hanoi'}),feature('LineString',[[1,2],[2,3]],{name:'Hanoi route'})]);
  assert.equal(filterFeatures(data.features,' HANOI ').length,2);
  const rows=filterFeatures(data.features,'Hanoi','LineString');assert.equal(rows.length,1);assert.equal(rows[0].index,1);assert.equal(rows[0].feature,data.features[1]);
  assert.equal(filterFeatures(data.features,'missing').length,0);
});
test('great-circle distances handle identical points, antipodes and the date line',()=>{
  assert.equal(distanceKm([10,20],[10,20]),0);
  assert.ok(Math.abs(distanceKm([0,0],[1,0])-111.195)<.001);
  assert.ok(Math.abs(distanceKm([179,0],[-179,0])-222.39)<.001);
  assert.ok(Math.abs(distanceKm([0,0],[180,0])-20015.114)<.001);
});
test('both the starter data and vendored world boundaries are valid, real GeoJSON',async()=>{
  for(const name of ['cities','countries']){const geo=JSON.parse(await readFile(new URL('../template/'+name+'.geojson',import.meta.url)));assert.ok(validateGeoJSON(geo).features.length>0);}
});
