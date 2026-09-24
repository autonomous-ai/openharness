// Editing state shared by the studio controls and persistence tests. Callers validate and mesh
// projects before handing them to the session; history contains only those accepted snapshots.
export class EditSession {
  constructor(source) {
    this.project=source;
    this.revision=source.revision;
    this.sourceId=source.id;
    this.dirty=false;
    this.past=[];
    this.future=[];
    this.editVersion=0;
    this.draftKeys=new Set([this.draftKey]);
  }

  get draftKey() { return 'tidelands:'+this.sourceId; }

  edit(next) {
    this.past.push(JSON.stringify(this.project));
    while(this.past.length>40||this.past.reduce((n,s)=>n+s.length,0)>16000000)this.past.shift();
    this.future.length=0;
    this.setDraft(next);
  }

  setDraft(next) {
    this.project=next;
    this.dirty=true;
    this.editVersion++;
  }

  openDraft(next) {
    this.clearHistory();
    this.setDraft(next);
  }

  restoreHistory(from,to) {
    if(!from.length)return false;
    const next=JSON.parse(from.at(-1));
    to.push(JSON.stringify(this.project));
    from.pop();
    this.setDraft(next);
    return true;
  }

  clearHistory() { this.past.length=0;this.future.length=0; }

  beginSave() {
    return {editVersion:this.editVersion,revision:this.revision,body:JSON.stringify(this.project)};
  }

  finishSave(request,source) {
    const editedDuringSave=this.editVersion!==request.editVersion;
    this.observeSource(source);
    this.revision=source.revision;
    if(!editedDuringSave){this.project=source;this.dirty=false;}
    return editedDuringSave;
  }

  acceptSource(source) {
    this.observeSource(source);
    this.project=source;
    this.revision=source.revision;
    this.dirty=false;
    this.editVersion++;
    this.clearHistory();
  }

  // Drafts follow the workspace source, not an imported unsaved world's ID. An observed
  // conflicting source also becomes the next reload's identity, without accepting its revision.
  observeSource(source) {
    this.sourceId=source.id;
    this.draftKeys.add(this.draftKey);
  }

  persistDraft(storage) {
    if(this.dirty){
      storage.setItem(this.draftKey,JSON.stringify({revision:this.revision,project:this.project,at:Date.now()}));
    }
    // Write a migrated draft before removing its old key; a storage failure keeps that copy.
    for(const key of this.draftKeys)if(!this.dirty||key!==this.draftKey)storage.removeItem(key);
    this.draftKeys=new Set([this.draftKey]);
  }
}
