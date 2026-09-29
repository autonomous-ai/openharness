import {describe,it,expect,vi} from 'vitest'
import {DesktopCompanion} from './companionState.js'
import {CompanionActions} from './companionActions.js'
const egg={v:1,window:'desktop',epoch:1,revision:1,enabled:true,foreground:true,phase:'egg',motion:true,
  egg:{kind:'first',stage:'p4',uid:'egg1'},feeling:{emotion:'content',reason:'ready',intensity:1}}
const request={requestId:'device-request',window:'desktop',epoch:1,target:'egg1',action:'hatch'}
describe('the device asks the owning desktop',()=>{
  it('opens once, waits for a receipt from that connection, and rejects other windows',async()=>{
    const bridge=new DesktopCompanion(vi.fn());bridge.update('socket',egg)
    const send=vi.fn((_conn:string,_payload:Record<string,unknown>)=>true),actions=new CompanionActions(bridge,send)
    const pending=actions.command(request)
    expect(actions.command(request)).toBe(pending);expect(send).toHaveBeenCalledTimes(1)
    const id=send.mock.calls[0][1].requestId
    actions.reply('other',{requestId:id,ok:true})
    actions.reply('socket',{requestId:id,ok:true})
    expect(await pending).toEqual({ok:true})
    expect(await actions.command({...request,window:'other'})).toMatchObject({ok:false})
    expect(await actions.command({...request,target:'other-egg'})).toMatchObject({ok:false})
    expect(await actions.command({...request,action:'run-command'})).toMatchObject({ok:false})
  })
  it('cannot accept a late receipt after off/account change/disconnect',async()=>{
    const bridge=new DesktopCompanion(vi.fn());bridge.update('socket',egg)
    const send=vi.fn((_conn:string,_payload:Record<string,unknown>)=>true),actions=new CompanionActions(bridge,send)
    const pending=actions.command(request),id=send.mock.calls[0][1].requestId
    bridge.update('socket',{...egg,epoch:2,revision:2,enabled:false})
    actions.reply('socket',{requestId:id,ok:true})
    expect(await pending).toMatchObject({ok:false})
    expect(await actions.command(request)).toMatchObject({ok:false})
  })
  it('times out without retrying or changing the egg',async()=>{
    vi.useFakeTimers()
    try {
      const bridge=new DesktopCompanion(vi.fn());bridge.update('socket',egg)
      const send=vi.fn((_conn:string,_payload:Record<string,unknown>)=>true),actions=new CompanionActions(bridge,send)
      const pending=actions.command(request)
      await vi.advanceTimersByTimeAsync(5001)
      expect(await pending).toMatchObject({ok:false})
      expect(send).toHaveBeenCalledTimes(1);expect(bridge.snapshot().egg?.uid).toBe('egg1')
    } finally {vi.useRealTimers()}
  })
})
