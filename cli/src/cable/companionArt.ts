import { setImmediate as yieldIO } from 'node:timers/promises'
import { rollTraits } from '../pair/plates/render.g.js'
import { COMPANION_ARTWORK as art } from './companionArtwork.g.js'
import { timFrame } from './timPerformance.g.js'
import { COMPANION_EMOTIONS, type CompanionState } from './companionState.js'

export interface CompanionArtFrame { rows: string; mats: string }
export interface CompanionClip {
  key: string; frames: CompanionArtFrame[]; frameMs: number; loop: boolean
  // top, bottom, marks, accessory, odd eye, glow, stars, peek; RGB565.
  palette: number[]
}
const rgb565 = (hex: string): number => {
  const n = Number.parseInt(hex.slice(1), 16)
  return ((n >> 19) << 11) | (((n >> 10) & 63) << 5) | ((n >> 3) & 31)
}
const eggs = art.eggs as Record<string, Record<string, Record<string, CompanionArtFrame[]>>>
const kinds = art.eggKinds as Record<string, { gradient: {top:{hex:string};bottom:{hex:string}};stars?:{hex:string} }>
const cache = new Map<string, Promise<CompanionClip>>()

export function companionArtKey(state: Pick<CompanionState, 'enabled'|'phase'|'egg'|'creature'|'feeling'>, size = 'reveal'): string | null {
  if (!state.enabled) return null
  if (state.phase === 'egg' || (state.phase === 'hatching' && state.egg?.stage !== 'hatchling')) {
    const e = state.egg
    return e && eggs[e.kind]?.[size]?.[e.stage] ? `egg:${e.kind}:${e.stage}:${size}` : null
  }
  const c = state.creature
  return c?.id === 'tim' ? `tim:${c.seed}:${c.version}:${c.shiny ? 1 : 0}:${state.feeling?.emotion ?? 'content'}:${size}` : null
}

/** Fast authored poses, bounded and shared by every device and the desktop.
 * Yield between frames: terminal and voice I/O never wait for a whole clip. */
export function companionArt(state: CompanionState, size: 'portrait'|'reveal' = 'reveal'): Promise<CompanionClip | null> {
  const key = companionArtKey(state, size)
  if (!key) return Promise.resolve(null)
  const held = cache.get(key)
  if (held) { cache.delete(key); cache.set(key, held); return held }
  const promise = draw(state, size, key)
  cache.set(key, promise)
  while(cache.size > 32) cache.delete(cache.keys().next().value!)
  void promise.catch(() => { if(cache.get(key) === promise) cache.delete(key) })
  return promise
}

async function draw(state: CompanionState, size: 'portrait'|'reveal', key: string): Promise<CompanionClip> {
  if (key.startsWith('egg:')) {
    const e = state.egg!, kind = kinds[e.kind], stage = e.stage
    const light = art.plate.light
    return {key,frames:eggs[e.kind][size][stage],frameMs:stage==='rock'?65:stage==='burst'?150:stage==='tumble'?75:190,
      loop:stage.startsWith('p')||stage==='rock',palette:[kind.gradient.top.hex,kind.gradient.bottom.hex,
        light.plain.hex,light.plain.hex,light.peek.hex,light.plain.hex,kind.stars?.hex??light.plain.hex,light.peek.hex].map(rgb565)}
  }
  const c=state.creature!, emotion=state.feeling?.emotion??'content'
  const traits=rollTraits({daemons:[art.tim]},'tim',c.seed) as unknown as {colour:string;extra:string|null;accent:string}
  const family=art.tim.traits.colours.find(v=>v[0]===traits.colour)!
  const extra=art.tim.traits.extras.find(v=>v[0]===traits.extra)
  const palette=[c.shiny?art.tim.shinyGradient.top.hex:family[2],
    c.shiny?art.tim.shinyGradient.bottom.hex:family[3],traits.accent,extra?.[2]??traits.accent,
    art.plate.oddEye.hex,art.plate.light.plain.hex,traits.accent,art.plate.light.peek.hex].map(v=>rgb565(v as string))
  const frames:CompanionArtFrame[]=[]
  for(let f=0;f<8;f++) {
    frames.push(timFrame(traits,c.version,emotion,f,size==='portrait'?28:56))
    await yieldIO()
  }
  return {key,frames,frameMs:['excited','playful','hatching'].includes(emotion)?110:
    ['asleep','exhausted','offline'].includes(emotion)?600:['bored','content','curious'].includes(emotion)?400:180,loop:true,palette}
}

/** Companion portraits use the same local, opt-in plate request/reply path. */
export async function companionPortrait(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  if(payload.id!=='tim'||typeof payload.seed!=='number'||!Number.isInteger(payload.seed)||payload.seed<0||payload.seed>0xffffffff||
    !['0.1','1.0','2.0'].includes(payload.version as string)||!['portrait','reveal'].includes(payload.size as string)||
    !COMPANION_EMOTIONS.includes(payload.performance as never)) return {error:'BAD_REQUEST'}
  const state:CompanionState={v:1,window:'art',epoch:0,revision:0,enabled:true,foreground:true,phase:'creature',
    creature:{uid:'art',id:'tim',seed:payload.seed,version:payload.version as string,name:'Tim',shiny:false},
    feeling:{emotion:payload.performance as NonNullable<CompanionState['feeling']>['emotion'],reason:'portrait',intensity:1}}
  const clip=await companionArt(state,payload.size as 'portrait'|'reveal')
  return {uid:payload.uid,size:payload.size,version:payload.version,mood:payload.mood,performance:payload.performance,
    frames:clip?.frames,frameMs:clip?.frameMs}
}
