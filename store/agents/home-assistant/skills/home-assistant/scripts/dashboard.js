const $=id=>document.getElementById(id),config=JSON.parse($('config').textContent);
let selected=0,night=true;
const node=(tag,text)=>{const n=document.createElement(tag);n.textContent=text;return n;};
$('count').textContent=String(config.automations.length).padStart(2,'0');$('source').textContent=config.source;
function render(){
  const a=config.automations[selected];
  $('rules').replaceChildren(...config.automations.map((rule,i)=>{const b=node('button',rule.alias);b.className='rule';b.setAttribute('role','tab');b.setAttribute('aria-selected',String(i===selected));b.tabIndex=i===selected?0:-1;b.append(node('small',String(i+1).padStart(2,'0')+' / '+rule.mode.toUpperCase()));b.onclick=()=>{selected=i;render();};b.onkeydown=e=>{if(['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.key)){e.preventDefault();selected=(i+(['ArrowDown','ArrowRight'].includes(e.key)?1:-1)+config.automations.length)%config.automations.length;render();$('rules').children[selected].focus();}};return b;}));
  $('title').textContent=a.alias;$('description').textContent=a.description;$('mode').textContent=a.mode.toUpperCase()+' MODE';
  $('trigger-label').textContent=a.triggers.map(x=>x.trigger??x.platform).join(' or ');$('trigger-detail').textContent=a.triggers.map(x=>x.entity_id?x.entity_id+(x.to!==undefined?' → '+x.to:''):x.at||'See source').join(' · ');
  $('condition-label').textContent=a.conditions.length?a.conditions.map(x=>x.condition).join(' and '):'No conditions';$('condition-detail').textContent=a.conditions.map(x=>x.entity_id+(x.state!==undefined?' = '+x.state:'')).join(' · ');
  $('action-label').textContent=a.actions.map(x=>x.action??x.service??'Complex action').join(' → ');$('action-detail').textContent=a.actions.map(x=>list(x.target?.entity_id).join(', ')).filter(Boolean).join(' · ');
  const t=a.triggers[0],kind=t.trigger??t.platform;
  $('event-entity').value=typeof t.entity_id==='string'?t.entity_id:'';$('event-from').value=kind==='numeric_state'?String(Number(t.above??t.below??0)-100):t.from??'not_home';$('event-to').value=kind==='numeric_state'?String(Number(t.above??t.below??0)+100):t.to??'home';$('event-time').value=t.at&&/^\d\d:\d\d/.test(t.at)?t.at:'23:00:00';
  const entities=[...new Set(a.conditions.map(x=>x.entity_id).filter(x=>typeof x==='string'))];
  $('states').replaceChildren(...entities.map(entity=>{const label=node('label',entity),input=document.createElement('input');input.dataset.entity=entity;input.value=entity==='sun.sun'?(night?'below_horizon':'above_horizon'):String(a.conditions.find(x=>x.entity_id===entity)?.state??'home');label.append(input);return label;}));
  for(const id of ['trigger-card','condition-card','action-card'])delete $(id).dataset.result;
  $('outcome').textContent='What would happen?';$('explanation').textContent='Edit the event and entity states, then trace this automation.';$('trace').replaceChildren();
}
for(const id of ['night','day'])$(id).onclick=()=>{night=id==='night';$('night').setAttribute('aria-pressed',String(night));$('day').setAttribute('aria-pressed',String(!night));const sun=[...$('states').querySelectorAll('input')].find(x=>x.dataset.entity==='sun.sun');if(sun)sun.value=night?'below_horizon':'above_horizon';};
$('simulate').onclick=()=>{
  const states=Object.fromEntries([...$('states').querySelectorAll('input')].map(x=>[x.dataset.entity,x.value]));
  const result=simulate(config.automations[selected],{entity:$('event-entity').value,from:$('event-from').value,to:$('event-to').value,time:$('event-time').value},states);
  const labels={'would-run':['Would request these actions','Local model matched the event and every condition. No service was called.'],blocked:['Conditions blocked it','The event does not lead to an action under these entity states.'],'no-trigger':['No matching trigger','The event did not match a modeled trigger. Numeric triggers need a threshold crossing.'],unknown:['Not modeled completely','This automation uses features outside the local model. Test it in Home Assistant; this is not a passing trace.']};
  $('outcome').textContent=labels[result.status][0];$('outcome').dataset.status=result.status;$('explanation').textContent=labels[result.status][1];
  $('trigger-card').dataset.result=String(result.triggers.some(x=>x.result===true));$('condition-card').dataset.result=String(result.conditions.every(x=>x.result===true));$('action-card').dataset.result=String(result.status==='would-run');
  $('trace').replaceChildren(...[...result.triggers.map((x,i)=>'Trigger '+(i+1)+': '+(x.result===null?'not modeled':x.result?'matched':'did not match')),...result.conditions.map((x,i)=>'Condition '+(i+1)+': '+(x.result===null?'not modeled':x.result?'passed':'blocked')),...result.actions.map(x=>'Intent only: '+(x.action??x.service)+' '+JSON.stringify(x.target??{})),...(!result.actionKnown?['Action semantics not modeled.']:[])].map(text=>node('li',text)));
};
$('download').onclick=()=>{const url=URL.createObjectURL(new Blob([config.source],{type:'application/yaml'})),a=document.createElement('a');a.href=url;a.download='automations.yaml';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
render();
