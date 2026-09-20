import test from 'node:test';
import assert from 'node:assert/strict';
import {toLocal,toLonLat,validateRing,regionArea,flightRegion,pointIn,segmentWithin,navigatorFor,transects,length,parseGeoJSON,union} from '../template/studio/geo.mjs';
const box=(x,y,w,h)=>[[x,y],[x+w,y],[x+w,y+h],[x,y+h]];
test('WGS 84 coordinates retain meter scale and round-trip near the equator, high latitudes and dateline',()=>{
  assert.ok(Math.abs(toLocal([0,0],[.001,0])[0]-111.31949079)<.0001);
  assert.ok(Math.abs(toLocal([0,0],[0,.001])[1]-110.57427582)<.0001);
  for(const origin of [[0,0],[-122.4,37.8],[179.999,51],[20,-70]])for(const point of [[0,0],[200,300],[-1200,600]]){
    const back=toLocal(origin,toLonLat(origin,point));assert.ok(Math.hypot(...back.map((n,i)=>n-point[i]))<.0001);
  }
  assert.throws(()=>toLocal([0,0],[180,0]),/5 km/);
});
test('insetting the boundary and expanding exclusions computes the actual remaining flight area',()=>{
  const region=flightRegion([box(0,0,100,100)],[box(40,40,20,20)],5);
  assert.equal(regionArea(region),7200);assert.equal(pointIn(region,[10,10]),true);assert.equal(pointIn(region,[2,2]),false);assert.equal(pointIn(region,[37,50]),false);
  assert.equal(segmentWithin(region,[10,50],[90,50]),false);assert.equal(segmentWithin(region,[10,10],[90,10]),true);
  assert.equal(regionArea(union([box(0,0,100,100),box(50,0,100,100)])),15000);
});
test('transits go around exclusions and never jump between disconnected flight areas',()=>{
  const region=flightRegion([box(0,0,100,100)],[box(40,40,20,20)],5),route=navigatorFor(region)([10,50],[90,50]);
  assert.ok(route.length>2);assert.ok(length(route)>80);for(let i=1;i<route.length;i++)assert.ok(segmentWithin(region,route[i-1],route[i]));
  const disconnected=flightRegion([box(0,0,20,20),box(40,0,20,20)],[],1);assert.equal(navigatorFor(disconnected)([10,10],[50,10]),null);
});
test('survey lines handle rotation and split correctly around a concave boundary and a hole',()=>{
  const boundary=validateRing([[0,0],[160,0],[160,100],[100,100],[100,60],[60,60],[60,100],[0,100]]),region=flightRegion([boundary],[box(15,15,20,20)],2);
  for(const angle of [0,37,90,171]){const rows=transects(region,12,angle);assert.ok(rows.length>5);for(const row of rows)assert.ok(segmentWithin(region,row.a,row.b),JSON.stringify(row));}
  assert.throws(()=>validateRing([[0,0],[100,100],[100,0],[0,100]]),/vertices|crosses/);
  assert.throws(()=>transects(region,.01,0),/0.5 m/);
});
test('GeoJSON import preserves user geometry and holes in the local meter frame',()=>{
  const origin=[106.6,10.8],outer=box(0,0,200,160),hole=box(50,50,30,20),coordinateRing=r=>[...r,r[0]].map(p=>toLonLat(origin,p));
  const source={type:'Feature',properties:{name:'Supplied site'},geometry:{type:'Polygon',coordinates:[coordinateRing(outer),coordinateRing(hole)]}},result=parseGeoJSON(source,origin);
  assert.equal(result.areas[0].name,'Supplied site');assert.equal(result.areas[0].holes.length,1);assert.ok(Math.abs(regionArea([result.areas[0].boundary])-32000)<.01);
  assert.throws(()=>parseGeoJSON({...source,crs:{name:'EPSG:3857'}}),/custom CRS/);
  assert.throws(()=>parseGeoJSON({type:'LineString',coordinates:[[0,0],[1,1]]}),/polygon/);
});
