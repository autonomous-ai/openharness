#!/usr/bin/env node
// Self-contained, local HTML. The clips come from the shipping art provider.
import {readFileSync,writeFileSync,mkdtempSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {build} from '../../cli/node_modules/esbuild/lib/main.js'
import {rollTraits,individualFlags,renderIndividualSprite,eggLine} from '../tools/render.mjs'
const root=fileURLToPath(new URL('../../',import.meta.url))
const temp=mkdtempSync(join(tmpdir(),'tim-review-'))
await build({entryPoints:[join(root,'cli/src/cable/companionArt.ts')],outfile:join(temp,'art.mjs'),bundle:true,platform:'node',format:'esm',logLevel:'silent'})
const {companionArt}=await import(pathToFileURL(join(temp,'art.mjs')))
const roster=JSON.parse(readFileSync(join(root,'daemons/roster.json'),'utf8'))
const tim=roster.daemons.find(d=>d.id==='tim')
const moods={content:'idle',curious:'idle',bored:'idle',playful:'back',working:'work',focused:'work',happy:'done',excited:'done',proud:'done',relieved:'done',frustrated:'fail',angry:'fail',sad:'fail',tired:'nap',exhausted:'nap',attentive:'need',asleep:'nap',offline:'idle',listening:'need',affectionate:'boop',hatching:'back'}
const data={tim:{},eggs:{},traits:{},sprites:{},eggLines:{}}
for(const seed of [0,1363,84,27]) {
  const traits=rollTraits(roster,'tim',seed)
  data.traits[seed]=individualFlags(roster,'tim',traits)
  data.tim[seed]={};data.sprites[seed]={}
  for(const version of ['0.1','1.0','2.0']) {
    data.tim[seed][version]={};data.sprites[seed][version]={}
    for(const [emotion,mood] of Object.entries(moods)) {
      data.tim[seed][version][emotion]=await companionArt({enabled:true,phase:'creature',creature:{id:'tim',seed,version,shiny:false},feeling:{emotion}})
      data.sprites[seed][version][emotion]=Array.from({length:4},(_,n)=>renderIndividualSprite(roster,'tim',traits,['0.1','1.0','2.0'].indexOf(version),mood,{t:n*300,motion:true}))
    }
  }
}
for(const kind of Object.keys(roster.rules.eggs)) {
  data.eggs[kind]={};data.eggLines[kind]={}
  for(const stage of ['p0','p1','p2','p3','p4','rock','burst','tumble','open']) {
    data.eggs[kind][stage]=await companionArt({enabled:true,phase:'egg',egg:{kind,stage}})
    data.eggLines[kind][stage]=eggLine(roster,kind,stage)
  }
}
const font=readFileSync(join(root,'devices/harness-device/firmware/fonts/jgs7.ttf')).toString('base64')
const fontLicense=readFileSync(join(root,'devices/harness-device/firmware/fonts/Jgs-OFL.txt'),'utf8')
const template=readFileSync(new URL('./review.html',import.meta.url),'utf8')
const licenseHtml=fontLicense.replaceAll('&','&amp;').replaceAll('<','&lt;')
writeFileSync(join(root,'daemons/review/tim-life.html'),template.replace('/*DATA*/',()=>`const DATA=${JSON.stringify(data).replaceAll('<','\\u003c')};`).replace('FONT_DATA',()=>font)
  .replace('</footer>',()=>`<details><summary>Jgs font · Adel Faure · SIL Open Font License</summary><pre style="white-space:pre-wrap">${licenseHtml}</pre></details></footer>`))
console.log('daemons/review/tim-life.html')
