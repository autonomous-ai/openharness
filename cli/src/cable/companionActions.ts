import { randomUUID } from 'node:crypto'
import type { DesktopCompanion } from './companionState.js'
type Result = {ok:boolean;error?:string}
interface Pending { conn:string; window:string; epoch:number; done:(result:Result)=>void; timer:ReturnType<typeof setTimeout> }

/** A device's hand goes to the one desktop that owns this life. No retries,
 * account calls, terminal input, or broadcasts. The desktop validates again. */
export class CompanionActions {
  private readonly pending=new Map<string,Pending>()
  private readonly seen=new Map<string,Promise<Result>>()
  constructor(private readonly owner:DesktopCompanion,
    private readonly send:(conn:string,payload:Record<string,unknown>)=>boolean,
    private readonly timeoutMs=5000) {}
  command(raw:Record<string,unknown>):Promise<Result> {
    const requestId=raw.requestId, action=raw.action
    if(typeof requestId!=='string'||!/^[-a-zA-Z0-9]{1,64}$/.test(requestId)||
      !['pet','hatch','nap','wake'].includes(action as string))return Promise.resolve({ok:false,error:'Invalid companion action.'})
    const target=this.owner.actionTarget(raw)
    if(!target)return Promise.resolve({ok:false,error:'The companion changed. Try again.'})
    const key=`${target.state.window}:${target.state.epoch}:${requestId}`
    const held=this.seen.get(key);if(held)return held
    if(this.pending.size>=8)return Promise.resolve({ok:false,error:'Companion is busy.'})
    const id=randomUUID()
    const promise=new Promise<Result>(done=>{
      const timer=setTimeout(()=>{this.pending.delete(id);done({ok:false,error:'No desktop receipt. Check Harness.'})},this.timeoutMs)
      timer.unref()
      this.pending.set(id,{conn:target.conn,window:target.state.window,epoch:target.state.epoch,done,timer})
      if(!this.send(target.conn,{requestId:id,action,window:target.state.window,epoch:target.state.epoch,target:raw.target})) {
        clearTimeout(timer);this.pending.delete(id);done({ok:false,error:'Open Harness to continue.'})
      }
    })
    this.seen.set(key,promise)
    while(this.seen.size>128)this.seen.delete(this.seen.keys().next().value!)
    return promise
  }
  reply(conn:string,raw:Record<string,unknown>):void {
    const id=raw.requestId
    if(typeof id!=='string')return
    const p=this.pending.get(id)
    if(!p||p.conn!==conn)return
    const current=this.owner.snapshot()
    clearTimeout(p.timer);this.pending.delete(id)
    p.done(current.enabled&&current.window===p.window&&current.epoch===p.epoch&&raw.ok===true
      ?{ok:true}:{ok:false,error:'The desktop could not accept that action.'})
  }
  disconnect(conn:string):void {
    for(const [id,p] of this.pending)if(p.conn===conn){clearTimeout(p.timer);this.pending.delete(id);p.done({ok:false,error:'Harness disconnected.'})}
  }
}
