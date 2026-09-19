import { validateGeoJSON, filterFeatures, featureName, distanceKm } from './geo.mjs';
const $ = id => document.getElementById(id), L = window.L;
const map = L.map('map', { zoomControl:false, minZoom:2, maxZoom:14, zoomAnimation:!matchMedia('(prefers-reduced-motion: reduce)').matches, worldCopyJump:false }).setView([16,106],5);
L.control.zoom({position:'topright'}).addTo(map);
L.control.scale({imperial:false,position:'bottomleft'}).addTo(map);
map.attributionControl.setPrefix('<a href="https://leafletjs.com" target="_blank" rel="noreferrer">Leaflet</a>');
map.attributionControl.addAttribution('Natural Earth · public domain');
let data={type:'FeatureCollection',features:[]}, selected=null, layers=new Map(), rows=[], measuring=false, measurePoints=[];
const featureLayer=L.featureGroup().addTo(map), measureLayer=L.featureGroup().addTo(map);
const status = (message='') => { $('error').textContent=message; $('error').hidden=!message; };
const text = (tag,content,className) => { const el=document.createElement(tag);el.textContent=String(content);if(className)el.className=className;return el; };
const color = index => index===selected?'#da582d':'#427560';
function select(index,fly=false) {
  selected=index;
  for(const [key,layer] of layers)layer.setStyle?.({color:color(key),fillColor:color(key),weight:key===selected?3:2,fillOpacity:key===selected?.9:.72});
  document.querySelectorAll('.feature').forEach(button=>button.setAttribute('aria-pressed',String(Number(button.dataset.index)===index)));
  const feature=data.features[index];if(!feature)return;
  const detail=$('details');detail.replaceChildren(text('h2',featureName(feature,index)));
  const dl=document.createElement('dl');
  for(const [key,value] of Object.entries(feature.properties||{}).slice(0,40)){dl.append(text('dt',key),text('dd',typeof value==='object'?JSON.stringify(value):value));}
  dl.append(text('dt','geometry'),text('dd',feature.geometry.type));
  if(feature.geometry.type==='Point')dl.append(text('dt','lon / lat'),text('dd',feature.geometry.coordinates.slice(0,2).map(n=>n.toFixed(5)).join(' / ')));
  detail.append(dl);
  const layer=layers.get(index);
  if(fly&&layer){const bounds=layer.getBounds?.();if(bounds?.isValid())map.fitBounds(bounds,{padding:[75,110],maxZoom:7,animate:false});else if(layer.getLatLng)map.panTo(layer.getLatLng(),{animate:false});}
}
function fit(){if(featureLayer.getLayers().length)map.fitBounds(featureLayer.getBounds(),{padding:[85,135],maxZoom:7,animate:false});}
function render(){
  featureLayer.clearLayers();layers.clear();
  rows=filterFeatures(data.features,$('search').value,$('type').value);
  $('count').textContent=rows.length.toLocaleString();$('geometry-count').textContent=new Set(rows.map(row=>row.feature.geometry.type)).size;
  $('empty').hidden=rows.length>0;$('export').disabled=!rows.length;$('fit').disabled=!rows.length;
  if(!rows.some(row=>row.index===selected)){selected=null;$('details').replaceChildren(text('h2','Select a feature'),text('p','Choose a name or a shape on the map to inspect its properties.'));}
  const list=$('features');list.replaceChildren();
  rows.forEach(({feature,index,name})=>{
    const layer=L.geoJSON(feature,{
      style:()=>({color:color(index),fillColor:color(index),weight:2,fillOpacity:.35}),
      pointToLayer:(_f,latlng)=>L.circleMarker(latlng,{radius:feature.properties?.type==='hub'?8:6,color:color(index),fillColor:color(index),weight:2,fillOpacity:.8}),
      onEachFeature:(_f,shape)=>{
        shape.bindTooltip(text('span',name),{permanent:feature.geometry.type==='Point'&&rows.length<=25,direction:'right',offset:[12,0],className:feature.geometry.type==='Point'&&rows.length<=25?'city-label':''});
        shape.on('click',event=>{if(event.originalEvent)L.DomEvent.stopPropagation(event.originalEvent);if(measuring)addMeasure(event.latlng);else select(index);});
        shape.on('add',()=>{const path=shape.getElement?.();if(path){path.setAttribute('tabindex','0');path.setAttribute('role','button');path.setAttribute('aria-label',name);path.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();select(index);}});}});
      }
    }).addTo(featureLayer);
    layers.set(index,layer);
    if(list.children.length<100){const button=text('button','', 'feature');button.dataset.index=index;button.setAttribute('aria-pressed',String(selected===index));button.append(text('span',name),text('span',feature.geometry.type));button.onclick=()=>select(index,true);list.append(button);}
  });
  if(rows.length>100)list.append(text('p','Showing the first 100 names. All '+rows.length+' features are on the map.'));
  if(selected!==null)select(selected);
}
function load(value,name){
  validateGeoJSON(value);data=value;selected=null;
  $('source').textContent=name;$('source').title=name;$('map-name').textContent=name==='cities.geojson'?'Vietnam / City atlas':name.replace(/\.(geo)?json$/i,'');
  $('search').value='';$('type').replaceChildren(new Option('All types','all'));
  [...new Set(data.features.map(feature=>feature.geometry.type))].sort().forEach(type=>$('type').add(new Option(type,type)));
  status();resetMeasurement();render();fit();
}
function resetMeasurement(){measurePoints=[];measureLayer.clearLayers();$('measurement').hidden=!measuring;$('measurement').textContent='Tap two locations to measure a great-circle distance.';$('clear-measure').hidden=!measuring;}
function addMeasure(point){
  if(measurePoints.length===2)resetMeasurement();
  measurePoints.push(point);L.circleMarker(point,{radius:5,color:'#9b3e20',fillColor:'#fff4dd',fillOpacity:1,weight:2,interactive:false}).addTo(measureLayer);
  if(measurePoints.length===1){$('measurement').textContent='Now choose the second location.';return;}
  L.polyline(measurePoints,{color:'#c3542b',weight:2,dashArray:'6 6',interactive:false}).addTo(measureLayer);
  const km=distanceKm([measurePoints[0].lng,measurePoints[0].lat],[measurePoints[1].lng,measurePoints[1].lat]);
  $('measurement').textContent=km.toLocaleString(undefined,{maximumFractionDigits:1})+' km · great-circle estimate, not a travel route';
}
$('measure').onclick=()=>{measuring=!measuring;$('measure').setAttribute('aria-pressed',String(measuring));$('map').style.cursor=measuring?'crosshair':'';resetMeasurement();};
$('clear-measure').onclick=resetMeasurement;
map.on('click',event=>{if(measuring)addMeasure(event.latlng);});
map.on('mousemove',event=>$('coordinates').textContent=event.latlng.lng.toFixed(4)+'° / '+event.latlng.lat.toFixed(4)+'° · WGS 84');
map.on('moveend',()=>{const c=map.getCenter();$('bounds-label').textContent=c.lat.toFixed(2)+'° latitude / '+c.lng.toFixed(2)+'° longitude · zoom '+map.getZoom();});
$('search').oninput=render;$('type').onchange=render;$('fit').onclick=fit;
$('upload').onchange=async event=>{const file=event.target.files[0];if(!file)return;try{if(file.size>5*1024*1024)throw new Error('Choose a GeoJSON file smaller than 5 MB.');load(JSON.parse(await file.text()),file.name);}catch(error){status('Import failed: '+error.message+' The previous layer is unchanged.');}event.target.value='';};
$('export').onclick=()=>{const value={type:'FeatureCollection',features:rows.map(row=>row.feature)};const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)+'\n'],{type:'application/geo+json'}));const link=document.createElement('a');link.href=url;link.download='atlas-selection.geojson';link.click();setTimeout(()=>URL.revokeObjectURL(url),30000);};
new ResizeObserver(()=>map.invalidateSize({pan:false})).observe($('map'));
async function fetchJSON(path){const response=await fetch(path);if(!response.ok)throw new Error(path+' returned HTTP '+response.status);return response.json();}
const results=await Promise.allSettled([
  fetchJSON('countries.geojson').then(geo=>L.geoJSON(geo,{interactive:false,style:{color:'#a4b9aa',weight:.7,fillColor:'#e5ead8',fillOpacity:1}}).addTo(map).bringToBack()),
  fetchJSON('cities.geojson').then(geo=>load(geo,'cities.geojson'))
]);
const failures=results.flatMap((result,index)=>result.status==='rejected'?[(index?'Could not load cities.geojson: ':'Offline outlines unavailable: ')+result.reason.message]:[]);
if(failures.length){status(failures.join(' · '));render();}
