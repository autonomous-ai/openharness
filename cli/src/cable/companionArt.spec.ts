import { describe, it, expect } from 'vitest'
import { companionArt, companionArtKey, companionPortrait } from './companionArt.js'
import { COMPANION_EMOTIONS, type CompanionState } from './companionState.js'

const state = (seed=1363, version='2.0', emotion='content'):CompanionState => ({
  v:1,window:'test',epoch:1,revision:1,enabled:true,foreground:true,motion:true,phase:'creature',
  creature:{uid:'test-tim',id:'tim',seed,version,shiny:false,name:'Tim'},
  feeling:{emotion:emotion as never,reason:'test',intensity:1},
})
describe('the same individual across a full life and emotional day',()=>{
  it('draws every emotion, age and seeded accessory inside a bounded USB frame',async()=>{
    for(const seed of [0,1363,27,45,84,127]) for(const age of ['0.1','1.0','2.0']) for(const emotion of COMPANION_EMOTIONS) {
      const clip=await companionArt(state(seed,age,emotion))
      expect(clip?.frames).toHaveLength(8)
      for(const [index,frame] of clip!.frames.entries()) {
        const rows=frame.rows.split('\n'),mats=frame.mats.split('\n')
        expect(rows.length).toBeLessThanOrEqual(30)
        expect(rows.every(row=>row.length===56&&/^[\x20-\x7e]+$/.test(row))).toBe(true)
        expect(mats.map(row=>row.length)).toEqual(rows.map(row=>row.length))
        expect(Buffer.byteLength(JSON.stringify({t:'companion.art.frame',key:clip!.key,transfer:1,index,...frame}))).toBeLessThan(8192)
      }
    }
  })
  it('keeps the same seed, visibly grows and gives each reaction a performance',async()=>{
    const clips=await Promise.all(['0.1','1.0','2.0'].map(age=>companionArt(state(1363,age))))
    const area=clips.map(c=>c!.frames[0].rows.replace(/\s/g,'').length)
    expect(area[0]).toBeLessThan(area[1]);expect(area[1]).toBeLessThan(area[2])
    const content=await companionArt(state()),joy=await companionArt(state(1363,'2.0','excited'))
    expect(new Set(joy!.frames.map(f=>f.rows)).size).toBeGreaterThan(5)
    expect(joy!.frames[3].rows).not.toBe(content!.frames[3].rows)
    expect((await companionArt(state()))).toBe(content)
    expect((await companionArt(state(84)))!.frames).not.toEqual(content!.frames)
  })
  it('covers every egg kind and every cracking/hatch stage; never invents an egg',async()=>{
    for(const kind of ['first','turn','setup','week','marathon','night','easter','history']) {
      for(const stage of ['p0','p1','p2','p3','p4','rock','burst','tumble','open']) {
        const s={...state(),phase:'egg' as const,creature:undefined,egg:{kind,stage}}
        const clip=await companionArt(s)
        expect(clip?.frames.length).toBeGreaterThan(0)
        expect(clip!.frames.length).toBeLessThanOrEqual(8)
        expect(clip!.palette).toHaveLength(8)
      }
    }
    expect(companionArtKey({...state(),enabled:false})).toBeNull()
    expect(await companionArt({...state(),phase:'egg',egg:{kind:'unknown',stage:'p0'}})).toBeNull()
  })
  it('desktop portrait requests are bounded and use that exact Tim rig',async()=>{
    const p={uid:'tim',id:'tim',seed:1363,version:'0.1',size:'portrait',mood:'done',performance:'excited'}
    const answer=await companionPortrait(p)
    expect(answer.frames).toEqual((await companionArt(state(1363,'0.1','excited'),'portrait'))!.frames)
    expect(await companionPortrait({...p,seed:NaN})).toEqual({error:'BAD_REQUEST'})
    expect(await companionPortrait({...p,performance:'bogus'})).toEqual({error:'BAD_REQUEST'})
  })
})
