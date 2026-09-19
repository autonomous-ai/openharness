// Deliberately small local model. Unsupported HA semantics are unknown, never success.
export const list=value=>value==null?[]:Array.isArray(value)?value:[value];
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
export function normalize(input){
  if(!Array.isArray(input)||!input.length||input.length>200)throw new Error('automations.yaml must contain 1–200 automation entries.');
  const ids=new Set();
  return input.map((item,index)=>{
    if(!object(item))throw new Error('Automation '+(index+1)+' must be a mapping.');
    const id=String(item.id??'');if(!id||ids.has(id))throw new Error('Every automation needs a unique id.');ids.add(id);
    if(typeof item.alias!=='string'||!item.alias.trim())throw new Error(id+': give the automation a human-readable alias.');
    const field=(a,b)=>{if(item[a]!==undefined&&item[b]!==undefined)throw new Error(id+': use '+a+' or '+b+', not both.');return list(item[a]??item[b]);};
    const triggers=field('triggers','trigger'),conditions=field('conditions','condition'),actions=field('actions','action');
    if(!triggers.length||!actions.length)throw new Error(id+': at least one trigger and action required; blueprints are not resolved by this local checker.');
    if([...triggers,...conditions,...actions].some(x=>!object(x)))throw new Error(id+': triggers, conditions and actions must be mappings.');
    if(triggers.some(x=>typeof(x.trigger??x.platform)!=='string'))throw new Error(id+': every trigger needs a trigger/platform type.');
    if(conditions.some(x=>typeof x.condition!=='string'))throw new Error(id+': every condition needs a condition type.');
    if(!['single','restart','queued','parallel'].includes(item.mode??'single'))throw new Error(id+': unrecognized automation mode.');
    return {id,alias:item.alias,description:item.description??'',mode:item.mode??'single',triggers,conditions,actions};
  });
}
const unsupported=(value,allowed)=>Object.keys(value).some(key=>!allowed.includes(key));
const plain=value=>typeof value==='string'&&!value.includes('{{')&&!value.includes('{%');
function inRange(value,rule){
  if(value==null||value===''||!Number.isFinite(Number(value)))return null;
  if(rule.above===undefined&&rule.below===undefined)return null;
  if((rule.above!==undefined&&!Number.isFinite(Number(rule.above)))||(rule.below!==undefined&&!Number.isFinite(Number(rule.below))))return null;
  return (rule.above===undefined||Number(value)>Number(rule.above))&&(rule.below===undefined||Number(value)<Number(rule.below));
}
export function checkTrigger(rule,event){
  const type=rule.trigger??rule.platform;
  if(type==='state'){
    if(unsupported(rule,['trigger','platform','entity_id','from','to','id','alias'])||!plain(rule.entity_id)||rule.from===null||rule.to===null)return null;
    if(event.entity!==rule.entity_id)return false;
    if((rule.from!==undefined&&!plain(rule.from))||(rule.to!==undefined&&!plain(rule.to)))return null;
    if(!plain(event.from)||!plain(event.to))return null;
    return event.from!==event.to&&(rule.from===undefined||event.from===String(rule.from))&&(rule.to===undefined||event.to===String(rule.to));
  }
  if(type==='numeric_state'){
    if(unsupported(rule,['trigger','platform','entity_id','above','below','id','alias'])||!plain(rule.entity_id))return null;
    if(event.entity!==rule.entity_id)return false;
    const before=inRange(event.from,rule),after=inRange(event.to,rule);
    return before===null||after===null?null:!before&&after;
  }
  if(type==='time'){
    if(unsupported(rule,['trigger','platform','at','id','alias'])||!/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(rule.at))return null;
    return String(event.time||'').padEnd(8,':00')===String(rule.at).padEnd(8,':00');
  }
  return null;
}
export function checkCondition(rule,states){
  if(rule.condition==='state'){
    if(unsupported(rule,['condition','entity_id','state','alias'])||!plain(rule.entity_id)||!plain(rule.state))return null;
    return states[rule.entity_id]===undefined?null:String(states[rule.entity_id])===rule.state;
  }
  if(rule.condition==='numeric_state'){
    if(unsupported(rule,['condition','entity_id','above','below','alias'])||!plain(rule.entity_id))return null;
    return inRange(states[rule.entity_id],rule);
  }
  return null;
}
export function simulate(automation,event,states){
  const triggers=automation.triggers.map(rule=>({rule,result:checkTrigger(rule,event)}));
  const next={...states};if(event.entity)next[event.entity]=event.to;
  const conditions=automation.conditions.map(rule=>({rule,result:checkCondition(rule,next)}));
  const trigger=triggers.some(x=>x.result===true)?true:triggers.some(x=>x.result===null)?null:false;
  const condition=conditions.some(x=>x.result===false)?false:conditions.some(x=>x.result===null)?null:true;
  const actionKnown=automation.actions.every(rule=>!unsupported(rule,['action','service','target','data','alias'])&&plain(rule.action??rule.service)&&!JSON.stringify(rule).includes('{{')&&!JSON.stringify(rule).includes('{%'));
  const status=trigger===false?'no-trigger':condition===false?'blocked':trigger===null||condition===null||!actionKnown?'unknown':'would-run';
  return {status,triggers,conditions,actions:status==='would-run'?automation.actions:[],actionKnown};
}
