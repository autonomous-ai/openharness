#!/usr/bin/env node
// Offline control/data check only. No browser engine, layout, network or app.
import {parseHTML} from '../review/tools/node_modules/linkedom/worker.js'
import {readFileSync} from 'node:fs'
import vm from 'node:vm'
import assert from 'node:assert/strict'
const html=readFileSync(new URL('../review/tim-life.html',import.meta.url),'utf8')
const {document,window}=parseHTML(html)
let now=0,raf,painted=[]
const $=id=>document.getElementById(id)
Object.defineProperty(window.HTMLSelectElement.prototype,'value',{
  get(){return [...this.querySelectorAll('option')].find(o=>o.hasAttribute('selected'))?.value??this.querySelector('option')?.value??''},
  set(v){for(const o of this.querySelectorAll('option'))o.toggleAttribute('selected',o.value===String(v))}
})
window.HTMLSelectElement.prototype.add=function(o){this.append(o)}
for(const el of document.querySelectorAll('input'))el.checked=el.hasAttribute('checked')
window.HTMLCanvasElement.prototype.getContext=()=>({fillRect(){painted=[]},fillText(ch,x,y){
  assert.ok(Number.isFinite(x)&&Number.isFinite(y));painted.push([ch,x,y])
}})
Object.defineProperty(document,'fonts',{value:{ready:Promise.resolve()}})
function Option(text,value){const o=document.createElement('option');o.textContent=text;o.value=value;return o}
const context=vm.createContext({document,Option,console,performance:{now:()=>now},
  matchMedia:()=>({matches:false}),requestAnimationFrame:fn=>{raf=fn},
  fetch:()=>{throw Error('Unexpected network request')}})
for(const script of document.querySelectorAll('script'))new vm.Script(script.textContent).runInContext(context)
await Promise.resolve()
const step=ms=>{now+=ms;assert.ok(raf);raf(now)}
const click=id=>{$(id).onclick();step(0)}
const select=(id,value)=>{$(id).value=value;$(id).onchange();step(0)}
step(0)
assert.equal($('egg').children.length,8)
assert.equal($('moods').children.length,21)
assert.equal($('stages').children.length,9)
for(const age of ['0.1','1.0','2.0'])for(const seed of ['0','1363','84','27']) {
  select('age',age);select('seed',seed)
  for(const mood of $('moods').children){mood.onclick();step(420);assert.ok(painted.length>20);assert.ok($('mini').textContent)}
}
for(const egg of $('egg').children){select('egg',egg.value);for(const b of $('stages').children){b.onclick();step(420);assert.ok(painted.length>20)}}
click('life');step(250);click('pause')
const frozen=JSON.stringify(painted),label=$('live').textContent
step(10000);assert.equal(JSON.stringify(painted),frozen);assert.equal($('live').textContent,label)
click('pause');for(let i=0;i<140;i++)step(300)
assert.equal($('age').value,'2.0')
assert.match($('live').textContent,/mature/)
$('still').checked=true;select('age','2.0');step(10)
const still=JSON.stringify(painted),mini=$('mini').textContent
step(1500);assert.equal(JSON.stringify(painted),still);assert.equal($('mini').textContent,mini)
$('enabled').checked=false;$('enabled').onchange();step(0)
assert.equal($('mini').textContent,'');assert.match($('live').textContent,/hidden/)
$('enabled').checked=true;$('enabled').onchange();select('egg','first')
for(const b of $('stages').children){
  b.onclick();step(0);click('screen');assert.equal($('age').value,'egg');
  assert.match($('live').textContent,/listening/);assert.ok($('hatch').hidden);
  click('screen');assert.doesNotMatch($('live').textContent,/listening/);
}
$('stages').children[4].onclick();step(0)
assert.equal($('hatch').hidden,false)
click('screen');assert.equal($('age').value,'egg');assert.ok($('hatch').hidden)
click('hatch');step(1000);assert.equal($('age').value,'egg') // Voice owns the screen until finished.
click('screen');assert.equal($('hatch').hidden,false)
click('hatch');for(let i=0;i<35;i++)step(300)
assert.equal($('age').value,'0.1',new vm.Script('JSON.stringify({phase,stage,emotion,sequence,next,step,paused,enabled:$("enabled").checked})').runInContext(context))
click('screen');step(0);assert.match($('live').textContent,/listening/)
click('day');for(let i=0;i<180;i++)step(300)
assert.match($('live').textContent,/asleep/)
const ids=[...document.querySelectorAll('[id]')].map(el=>el.id)
assert.equal(new Set(ids).size,ids.length)
assert.equal(document.querySelectorAll('script[src],link[rel="stylesheet"]').length,0)
assert.match(document.querySelector('details').textContent,/Copyright \(c\) 2022, Adel Faure/)
console.log('Tim review: all ages/individuals/emotions/eggs, hatch, workday, pause, reduced motion, off, embedded font attribution PASS (offline DOM only)')
