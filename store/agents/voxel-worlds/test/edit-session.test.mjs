import test from 'node:test';
import assert from 'node:assert/strict';
import {EditSession} from '../template/studio/edit-session.mjs';
import {validateProject,clone} from '../template/studio/project.mjs';
import {harbor} from './fixtures.mjs';

const source=()=>({...validateProject(harbor()),revision:'initial'});
function storage() {
  const values=new Map();
  return {values,getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)};
}
function edit(session,fn) { const next=clone(session.project);fn(next);session.edit(validateProject(next)); }
const bakery=project=>project.objects.find(o=>o.id==='bakery');
const boat=project=>project.objects.find(o=>o.id==='boat');

test('a delayed save preserves later edits, history and a recoverable draft against the saved revision',async()=>{
  const session=new EditSession(source()),local=storage();
  edit(session,p=>{bakery(p).name='Kept bakery';});session.persistDraft(local);
  const request=session.beginSave();let respond;
  const saving=new Promise(resolve=>{respond=resolve;}).then(saved=>{
    assert.equal(session.finishSave(request,saved),true);session.persistDraft(local);
  });
  edit(session,p=>{boat(p).name='Edit made while saving';});session.persistDraft(local);
  const expected=clone(session.project),history=[...session.past];
  respond({...JSON.parse(request.body),revision:'saved'});await saving;
  assert.deepEqual(session.project,expected);assert.deepEqual(session.past,history);
  assert.equal(session.dirty,true);assert.equal(session.revision,'saved');
  const recovered=JSON.parse(local.getItem(session.draftKey));
  assert.deepEqual(recovered.project,expected);assert.equal(recovered.revision,'saved');
  assert.equal(boat(JSON.parse(request.body)).name,'Harbor skiff','the submitted snapshot is immutable');
});

test('undo and redo during an in-flight save remain live edits with their history intact',()=>{
  for(const direction of ['undo','redo']){
    const session=new EditSession(source());
    edit(session,p=>{bakery(p).name='Kept bakery';});
    if(direction==='redo')session.restoreHistory(session.past,session.future);
    const request=session.beginSave();
    session.restoreHistory(direction==='undo'?session.past:session.future,direction==='undo'?session.future:session.past);
    const expected=clone(session.project),past=[...session.past],future=[...session.future];
    assert.equal(session.finishSave(request,{...JSON.parse(request.body),revision:'saved'}),true);
    assert.deepEqual(session.project,expected);assert.deepEqual(session.past,past);assert.deepEqual(session.future,future);
    assert.equal(session.dirty,true);
  }
});

test('an unchanged save becomes clean and clears its draft while retaining normal undo',()=>{
  const session=new EditSession(source()),local=storage();
  edit(session,p=>{bakery(p).name='Kept bakery';});session.persistDraft(local);
  const request=session.beginSave(),saved={...JSON.parse(request.body),revision:'saved'};
  assert.equal(session.finishSave(request,saved),false);session.persistDraft(local);
  assert.deepEqual(session.project,saved);assert.equal(session.dirty,false);assert.equal(local.values.size,0);
  assert.equal(session.restoreHistory(session.past,session.future),true);
  assert.equal(bakery(session.project).name,'Copper Roof Bakery');assert.equal(session.dirty,true);
});

test('accepting an agent source clears both undo and redo so old snapshots cannot remove its revision',()=>{
  const session=new EditSession(source()),local=storage();
  edit(session,p=>{bakery(p).name='Kept bakery';});
  edit(session,p=>{boat(p).name='Temporary boat name';});session.restoreHistory(session.past,session.future);
  const request=session.beginSave();session.finishSave(request,{...JSON.parse(request.body),revision:'saved'});
  assert.ok(session.past.length&&session.future.length);
  const external=clone(session.project);boat(external).name='Agent revised boat';external.revision='external';
  session.acceptSource(external);session.persistDraft(local);
  assert.equal(session.restoreHistory(session.past,session.future),false);
  assert.equal(session.restoreHistory(session.future,session.past),false);
  assert.equal(boat(session.project).name,'Agent revised boat');assert.equal(bakery(session.project).name,'Kept bakery');
  assert.equal(session.dirty,false);assert.equal(session.revision,'external');
});

test('imported drafts recover under the old workspace identity until a save commits the imported world',()=>{
  const original=source(),session=new EditSession(original),local=storage();
  const imported={...source(),id:'night-market-v1',title:'Night market'};
  session.openDraft(imported);session.persistDraft(local);
  const beforeReload=new EditSession(original);
  assert.equal(JSON.parse(local.getItem(beforeReload.draftKey)).project.id,'night-market-v1');
  assert.equal(local.getItem('tidelands:night-market-v1'),null);
  const request=session.beginSave(),saved={...JSON.parse(request.body),revision:'market-saved'};
  edit(session,p=>{bakery(p).name='Market stall edited while saving';});
  session.finishSave(request,saved);session.persistDraft(local);
  assert.equal(local.getItem(beforeReload.draftKey),null);
  const afterReload=new EditSession(saved),draft=JSON.parse(local.getItem(afterReload.draftKey));
  assert.equal(bakery(draft.project).name,'Market stall edited while saving');
  assert.equal(draft.revision,'market-saved');assert.equal(session.dirty,true);
});

test('opening another draft during Save preserves it under the identity that was actually committed',()=>{
  const session=new EditSession(source()),local=storage();
  session.openDraft({...source(),id:'first-market'});session.persistDraft(local);
  const request=session.beginSave(),saved={...JSON.parse(request.body),revision:'first-saved'};
  session.openDraft({...source(),id:'second-market'});session.persistDraft(local);
  session.finishSave(request,saved);session.persistDraft(local);
  assert.equal(session.project.id,'second-market');assert.equal(session.dirty,true);
  const reload=new EditSession(saved);
  assert.equal(JSON.parse(local.getItem(reload.draftKey)).project.id,'second-market');
  assert.equal(local.getItem('tidelands:second-market'),null);
});

test('a conflicting source with a new ID keeps the draft and history recoverable without accepting its revision',()=>{
  const session=new EditSession(source()),local=storage();
  edit(session,p=>{bakery(p).name='Kept local layout';});session.persistDraft(local);
  const expected=clone(session.project),past=[...session.past],external={...source(),id:'night-market-v1',revision:'external'};
  session.observeSource(external);session.persistDraft(local);
  assert.deepEqual(session.project,expected);assert.deepEqual(session.past,past);
  assert.equal(session.dirty,true);assert.equal(session.revision,'initial');
  const reload=new EditSession(external);
  assert.deepEqual(JSON.parse(local.getItem(reload.draftKey)).project,expected);
});

test('draft migration writes the new copy before deleting the old one when storage rejects writes',()=>{
  const session=new EditSession(source()),local=storage();
  edit(session,p=>{bakery(p).name='Keep through storage failure';});session.persistDraft(local);
  const oldKey=session.draftKey,oldDraft=local.getItem(oldKey),setItem=local.setItem;
  session.observeSource({...source(),id:'night-market-v1',revision:'external'});
  local.setItem=()=>{throw new Error('Quota exceeded');};
  assert.throws(()=>session.persistDraft(local),/Quota exceeded/);
  assert.equal(local.getItem(oldKey),oldDraft);assert.equal(session.dirty,true);
  local.setItem=setItem;session.persistDraft(local);
  assert.equal(local.getItem(oldKey),null);
  assert.deepEqual(JSON.parse(local.getItem(session.draftKey)).project,session.project);
});
